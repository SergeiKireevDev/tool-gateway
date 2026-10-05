import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HTTP } from '../server/httpStatus.js';
import { CONFIG_DRIVE_BYTES } from '../server/launchpad/protocol.js';
import type { VmInfo, VmSpec } from '../server/launchpad/vmDriver.js';
import type { VmdConfig } from './config.js';
import type { HostOps, HostProcess } from './host.js';

const API_SOCKET = 'api.sock';
const SOCKET_WAIT_MS = 5000;
const SOCKET_POLL_MS = 50;
const EXIT_WAIT_MS = 5000;
const OCTETS = 4;
const BITS_PER_OCTET = 8;
const MAX_OCTET = 255;
const LAST_HOST = 254;
const HEX = 16;
const VM_ID_CHARS = 12;

export class VmdError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ManagedVm {
  vmId: string;
  runId: string;
  index: number;
  tap: string;
  process: HostProcess | null;
  running: boolean;
  exited: Promise<void>;
  killTimer: NodeJS.Timeout | null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function netmask(prefix: number): string {
  const bits = prefix === 0 ? 0 : (~0 << (OCTETS * BITS_PER_OCTET - prefix)) >>> 0;
  return Array.from(
    { length: OCTETS },
    (_, i) => (bits >>> ((OCTETS - 1 - i) * BITS_PER_OCTET)) & MAX_OCTET,
  ).join('.');
}

/**
 * Boots and destroys Firecracker microVMs, each in its own jailer chroot as an unprivileged user,
 * with its own tap on the isolated VM bridge, a private copy of the rootfs, and a read-only
 * config drive carrying the run's configuration.
 */
export class VmManager {
  private readonly vms = new Map<string, ManagedVm>();

  constructor(
    private readonly config: VmdConfig,
    private readonly host: HostOps,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Checks the host setup and removes what a previous vmd left behind. */
  async init(): Promise<void> {
    for (const file of [
      this.config.rootfs,
      this.config.kernel,
      this.config.jailerBin,
      this.config.firecrackerBin,
    ]) {
      if (!(await this.host.exists(file)))
        throw new Error(`Missing ${file}: see docs/launchpad-host.md`);
    }
    await this.host.run('ip', ['link', 'show', this.config.bridge]).catch(() => {
      throw new Error(`Bridge ${this.config.bridge} not found: run scripts/vm-host-setup.sh`);
    });
    await this.host.tryRun('pkill', ['-KILL', '-f', `--chroot-base-dir ${this.config.jailBase}`]);
    await this.host.tryRun('pkill', ['-KILL', '-f', 'firecracker --id lp-']);
    for (let index = 1; index <= this.config.maxVms; index++) {
      await this.host.tryRun('ip', ['link', 'del', this.tapName(index)]);
    }
    await this.host.remove(path.join(this.config.jailBase, 'firecracker'));
    await this.host.mkdir(this.config.logDir);
  }

  list(): VmInfo[] {
    return [...this.vms.values()].map(({ vmId, runId, running }) => ({ vmId, runId, running }));
  }

  async create(spec: VmSpec): Promise<{ vmId: string }> {
    const index = this.freeIndex();
    const vmId = `lp-${randomUUID().replace(/-/g, '').slice(0, VM_ID_CHARS)}`;
    const vm: ManagedVm = {
      vmId,
      runId: spec.runId,
      index,
      tap: this.tapName(index),
      process: null,
      running: true,
      exited: Promise.resolve(),
      killTimer: null,
    };
    this.vms.set(vmId, vm);
    try {
      await this.boot(vm, spec);
    } catch (err) {
      await this.destroy(vmId);
      throw err;
    }
    return { vmId };
  }

  async destroy(vmId: string): Promise<boolean> {
    const vm = this.vms.get(vmId);
    if (!vm) return false;
    if (vm.killTimer) clearTimeout(vm.killTimer);
    if (vm.running && vm.process) {
      vm.process.kill('SIGKILL');
      await Promise.race([vm.exited, sleep(EXIT_WAIT_MS)]);
    }
    await this.host.tryRun('ip', ['link', 'del', vm.tap]);
    await this.host.remove(path.join(this.config.jailBase, 'firecracker', vmId));
    this.vms.delete(vmId);
    return true;
  }

  private tapName(index: number): string {
    return `lptap${index}`;
  }

  private freeIndex(): number {
    const used = new Set([...this.vms.values()].map((v) => v.index));
    for (let index = 1; index <= this.config.maxVms; index++) {
      if (!used.has(index)) return index;
    }
    throw new VmdError(HTTP.SERVICE_UNAVAILABLE, `All ${this.config.maxVms} VM slots are in use`);
  }

  guestAddress(index: number): string {
    const octets = this.config.bridgeAddress.split('.').map(Number);
    const last = (octets[OCTETS - 1] ?? 0) + index;
    if (last > LAST_HOST)
      throw new VmdError(HTTP.SERVICE_UNAVAILABLE, 'No guest address left on the VM bridge');
    return [...octets.slice(0, OCTETS - 1), last].join('.');
  }

  private async boot(vm: ManagedVm, spec: VmSpec): Promise<void> {
    const { config, host } = this;
    const address = this.guestAddress(vm.index);
    await host.run('ip', [
      'tuntap',
      'add',
      'dev',
      vm.tap,
      'mode',
      'tap',
      'user',
      String(config.jailUid),
    ]);
    await host.run('ip', ['link', 'set', vm.tap, 'master', config.bridge]);
    // Isolated bridge ports can only talk to the bridge itself (the gateway), not to each other.
    await host.run('bridge', ['link', 'set', 'dev', vm.tap, 'isolated', 'on']);
    await host.run('ip', ['link', 'set', vm.tap, 'up']);

    const jailRoot = path.join(config.jailBase, 'firecracker', vm.vmId, 'root');
    const proc = host.start(
      config.jailerBin,
      [
        '--id',
        vm.vmId,
        '--exec-file',
        config.firecrackerBin,
        '--uid',
        String(config.jailUid),
        '--gid',
        String(config.jailGid),
        '--chroot-base-dir',
        config.jailBase,
        '--',
        '--api-sock',
        `/${API_SOCKET}`,
      ],
      path.join(config.logDir, `${vm.vmId}.log`),
    );
    vm.process = proc;
    vm.exited = new Promise((resolve) => {
      proc.onExit(() => {
        vm.running = false;
        resolve();
      });
    });
    await this.waitForSocket(vm, path.join(jailRoot, API_SOCKET));

    const fullConfig = {
      ...spec.config,
      network: { address, prefixLength: config.prefixLength, gateway: config.bridgeAddress },
    };
    const json = Buffer.from(JSON.stringify(fullConfig));
    if (json.length >= CONFIG_DRIVE_BYTES)
      throw new VmdError(HTTP.BAD_REQUEST, 'Run configuration too large');
    const files = {
      kernel: path.join(jailRoot, 'vmlinux'),
      rootfs: path.join(jailRoot, 'rootfs.ext4'),
      configDrive: path.join(jailRoot, 'config.img'),
    };
    await host.copySparse(config.kernel, files.kernel);
    await host.copySparse(config.rootfs, files.rootfs);
    await host.writePadded(files.configDrive, json, CONFIG_DRIVE_BYTES);
    for (const file of Object.values(files)) await host.chown(file, config.jailUid, config.jailGid);

    const api = (method: string, apiPath: string, body: unknown): Promise<void> =>
      host.firecracker(path.join(jailRoot, API_SOCKET), method, apiPath, body);
    await api('PUT', '/machine-config', {
      vcpu_count: spec.vcpus,
      mem_size_mib: spec.memMib,
      smt: false,
    });
    await api('PUT', '/boot-source', {
      kernel_image_path: '/vmlinux',
      boot_args: [
        'console=ttyS0 reboot=k panic=1 pci=off quiet',
        `ip=${address}::${config.bridgeAddress}:${netmask(config.prefixLength)}::eth0:off`,
        'init=/sbin/launchpad-init',
      ].join(' '),
    });
    await api('PUT', '/drives/rootfs', {
      drive_id: 'rootfs',
      path_on_host: '/rootfs.ext4',
      is_root_device: true,
      is_read_only: false,
    });
    // Second drive = /dev/vdb in the guest, read by the runner (root only).
    await api('PUT', '/drives/config', {
      drive_id: 'config',
      path_on_host: '/config.img',
      is_root_device: false,
      is_read_only: true,
    });
    await api('PUT', '/network-interfaces/eth0', {
      iface_id: 'eth0',
      host_dev_name: vm.tap,
      guest_mac: this.mac(address),
    });
    await api('PUT', '/actions', { action_type: 'InstanceStart' });

    const ttl = Math.max(0, Date.parse(spec.killAt) - this.now());
    vm.killTimer = setTimeout(() => {
      if (vm.running) vm.process?.kill('SIGKILL');
    }, ttl);
    vm.killTimer.unref();
  }

  private mac(address: string): string {
    const hex = address.split('.').map((o) => Number(o).toString(HEX).padStart(2, '0'));
    return ['06', '00', ...hex].join(':');
  }

  private async waitForSocket(vm: ManagedVm, socket: string): Promise<void> {
    const until = this.now() + SOCKET_WAIT_MS;
    while (this.now() < until) {
      if (await this.host.exists(socket)) return;
      if (!vm.running) throw new Error('Firecracker exited during startup (see its log)');
      await sleep(SOCKET_POLL_MS);
    }
    throw new Error('Firecracker API socket did not appear');
  }
}
