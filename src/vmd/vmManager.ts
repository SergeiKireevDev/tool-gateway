import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HTTP } from '../server/httpStatus.js';
import { CONFIG_DRIVE_BYTES } from '../server/launchpad/protocol.js';
import type { ServiceImage, ServiceInfo, ServiceSpec } from '../server/launchpad/serviceDriver.js';
import type { VmInfo, VmSpec } from '../server/launchpad/vmDriver.js';
import type { VmdConfig } from './config.js';
import type { HostOps, HostProcess, PortForward } from './host.js';

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
const IMAGE_SUFFIX = '.ext4';
const MANIFEST_SUFFIX = '.json';
const AGENT_INIT = '/sbin/launchpad-init';
const SERVICE_INIT = '/sbin/service-box-init';
const MAX_PORT = 65_535;
const LOOPBACK = '127.0.0.1';
/** The nftables set (deploy/vm-host-setup.sh) of host ports agent VMs may reach. */
const SERVICE_PORTS_SET = (action: 'add' | 'delete' | 'flush'): string[] => [
  action,
  ...(action === 'flush' ? ['set'] : ['element']),
  'inet',
  'launchpad',
  'service_ports',
];

export class VmdError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What a service box keeps besides its VM. */
interface ManagedService {
  spec: ServiceSpec;
  ports: number[];
  forwards: PortForward[];
  /** Host ports opened to agent VMs in the VM firewall. */
  openPorts: number[];
  startedAt: string;
}

/** How to boot one VM: an agent run's or a service box's. */
interface BootOptions {
  rootfs: string;
  vcpus: number;
  memMib: number;
  init: string;
  /** Kernel parameters for the guest's init (unknown `key=value` ones become its environment). */
  initArgs: string[];
  /** Written to the read-only config drive (with the guest network), or none. */
  config: Record<string, unknown> | null;
  /** Killed at this time (ISO), or never. */
  killAt: string | null;
}

interface ManagedVm {
  vmId: string;
  /** The agent run it belongs to ('' for a service box). */
  runId: string;
  service: ManagedService | null;
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
    await this.host.tryRun('nft', SERVICE_PORTS_SET('flush'));
    await this.host.remove(path.join(this.config.jailBase, 'firecracker'));
    await this.host.mkdir(this.config.jailBase);
    await this.host.mkdir(this.config.logDir);
  }

  /** Agent run VMs (service boxes are listed by `listServices`). */
  list(): VmInfo[] {
    return [...this.vms.values()]
      .filter((vm) => vm.service === null)
      .map(({ vmId, runId, running }) => ({ vmId, runId, running }));
  }

  async create(spec: VmSpec): Promise<{ vmId: string }> {
    const vm = this.allocate(spec.runId, null);
    await this.bootOrDestroy(vm, {
      rootfs: this.config.rootfs,
      vcpus: spec.vcpus,
      memMib: spec.memMib,
      init: AGENT_INIT,
      initArgs: [],
      config: spec.config,
      killAt: spec.killAt,
    });
    return { vmId: vm.vmId };
  }

  /** Destroys an agent run's VM (not a service box). */
  async destroy(vmId: string): Promise<boolean> {
    return this.vms.get(vmId)?.service === null ? this.teardown(vmId) : false;
  }

  // ---------------------------------------------------------------- service boxes

  /** Built service images, from their manifests in the service directory. */
  async listImages(): Promise<ServiceImage[]> {
    const names = (await this.host.readDir(this.config.serviceDir))
      .filter((f) => f.endsWith(MANIFEST_SUFFIX))
      .map((f) => f.slice(0, -MANIFEST_SUFFIX.length))
      .sort();
    const images: ServiceImage[] = [];
    for (const name of names) {
      const image = await this.readImage(name);
      if (image) images.push(image);
    }
    return images;
  }

  listServices(): ServiceInfo[] {
    return [...this.vms.values()].flatMap((vm) =>
      vm.service ? [this.serviceInfo(vm, vm.service)] : [],
    );
  }

  /** Boots a long-lived VM from a service image and publishes its ports on the host's loopback. */
  async createService(spec: ServiceSpec): Promise<ServiceInfo> {
    const image = await this.readImage(spec.image);
    if (!image) throw new VmdError(HTTP.NOT_FOUND, `No service image named ${spec.image}`);
    // Checked after the last await before the slot is taken, so concurrent launches can't race.
    const taken = this.listServices();
    if (taken.some((s) => s.name === spec.name))
      throw new VmdError(HTTP.CONFLICT, `A service named ${spec.name} is already running`);
    const used = new Set(taken.flatMap((s) => s.publish.map((p) => p.hostPort)));
    const clash = spec.publish.find((p) => used.has(p.hostPort));
    if (clash) throw new VmdError(HTTP.CONFLICT, `Host port ${clash.hostPort} is already in use`);
    const service: ManagedService = {
      spec,
      ports: image.ports,
      forwards: [],
      openPorts: [],
      startedAt: new Date(this.now()).toISOString(),
    };
    const vm = this.allocate('', service);
    await this.bootOrDestroy(vm, {
      rootfs: this.imagePath(spec.image),
      vcpus: spec.vcpus,
      memMib: spec.memMib,
      init: SERVICE_INIT,
      initArgs: [`lp_service=${spec.name}`],
      config: null,
      killAt: null,
    });
    try {
      await this.publish(vm, service);
    } catch (err) {
      await this.teardown(vm.vmId);
      throw new VmdError(HTTP.CONFLICT, `Could not publish a port: ${(err as Error).message}`);
    }
    return this.serviceInfo(vm, service);
  }

  async destroyService(serviceId: string): Promise<boolean> {
    return this.vms.get(serviceId)?.service ? this.teardown(serviceId) : false;
  }

  /** Destroys every VM, agent runs' and service boxes' (vmd shutting down). */
  async destroyAll(): Promise<void> {
    await Promise.all([...this.vms.keys()].map((vmId) => this.teardown(vmId)));
  }

  /**
   * Forwards each published port from the host's loopback and, for services open to agents, from
   * the bridge address too, whose port the VM firewall then lets agent VMs reach (agents never
   * talk to a service's VM directly: every tap stays isolated).
   */
  private async publish(vm: ManagedVm, service: ManagedService): Promise<void> {
    const address = this.guestAddress(vm.index);
    for (const p of service.spec.publish) {
      service.forwards.push(await this.host.forward(LOOPBACK, p.hostPort, address, p.port));
      if (!service.spec.agentAccess) continue;
      service.forwards.push(
        await this.host.forward(this.config.bridgeAddress, p.hostPort, address, p.port),
      );
      service.openPorts.push(p.hostPort);
      await this.host.run('nft', [...SERVICE_PORTS_SET('add'), `{ ${String(p.hostPort)} }`]);
    }
  }

  private async unpublish(service: ManagedService): Promise<void> {
    for (const port of service.openPorts) {
      await this.host.tryRun('nft', [...SERVICE_PORTS_SET('delete'), `{ ${String(port)} }`]);
    }
    for (const forward of service.forwards) forward.close();
  }

  private serviceInfo(vm: ManagedVm, service: ManagedService): ServiceInfo {
    const { spec } = service;
    return {
      ...spec,
      serviceId: vm.vmId,
      address: this.guestAddress(vm.index),
      agentEndpoints: spec.agentAccess
        ? spec.publish.map((p) => `${this.config.bridgeAddress}:${String(p.hostPort)}`)
        : [],
      ports: service.ports,
      running: vm.running,
      startedAt: service.startedAt,
    };
  }

  private imagePath(name: string): string {
    return path.join(this.config.serviceDir, `${name}${IMAGE_SUFFIX}`);
  }

  private async readImage(name: string): Promise<ServiceImage | null> {
    if (!(await this.host.exists(this.imagePath(name)))) return null;
    try {
      const manifest = JSON.parse(
        await this.host.readText(path.join(this.config.serviceDir, `${name}${MANIFEST_SUFFIX}`)),
      ) as { ports?: unknown };
      const ports = Array.isArray(manifest.ports)
        ? manifest.ports.filter(
            (p): p is number =>
              Number.isInteger(p) && (p as number) > 0 && (p as number) <= MAX_PORT,
          )
        : [];
      return { name, ports };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- VMs

  private allocate(runId: string, service: ManagedService | null): ManagedVm {
    const index = this.freeIndex();
    const vmId = `lp-${randomUUID().replace(/-/g, '').slice(0, VM_ID_CHARS)}`;
    const vm: ManagedVm = {
      vmId,
      runId,
      service,
      index,
      tap: this.tapName(index),
      process: null,
      running: true,
      exited: Promise.resolve(),
      killTimer: null,
    };
    this.vms.set(vmId, vm);
    return vm;
  }

  private async bootOrDestroy(vm: ManagedVm, opts: BootOptions): Promise<void> {
    try {
      await this.boot(vm, opts);
    } catch (err) {
      await this.teardown(vm.vmId);
      throw err;
    }
  }

  private async teardown(vmId: string): Promise<boolean> {
    const vm = this.vms.get(vmId);
    if (!vm) return false;
    if (vm.service) await this.unpublish(vm.service);
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

  private async boot(vm: ManagedVm, opts: BootOptions): Promise<void> {
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
      proc.onExit((code) => {
        vm.running = false;
        const owner = vm.service ? `service ${vm.service.spec.name}` : `run ${vm.runId}`;
        console.info(`vmd: VM ${vm.vmId} (${owner}) exited with code ${String(code)}`);
        resolve();
      });
    });
    await this.waitForSocket(vm, path.join(jailRoot, API_SOCKET));

    const kernel = path.join(jailRoot, 'vmlinux');
    const rootfs = path.join(jailRoot, 'rootfs.ext4');
    const files = [kernel, rootfs];
    await host.copySparse(config.kernel, kernel);
    await host.copySparse(opts.rootfs, rootfs);
    if (opts.config) {
      const fullConfig = {
        ...opts.config,
        network: { address, prefixLength: config.prefixLength, gateway: config.bridgeAddress },
      };
      const json = Buffer.from(JSON.stringify(fullConfig));
      if (json.length >= CONFIG_DRIVE_BYTES)
        throw new VmdError(HTTP.BAD_REQUEST, 'Run configuration too large');
      const configDrive = path.join(jailRoot, 'config.img');
      await host.writePadded(configDrive, json, CONFIG_DRIVE_BYTES);
      files.push(configDrive);
    }
    for (const file of files) await host.chown(file, config.jailUid, config.jailGid);

    const api = (method: string, apiPath: string, body: unknown): Promise<void> =>
      host.firecracker(path.join(jailRoot, API_SOCKET), method, apiPath, body);
    await api('PUT', '/machine-config', {
      vcpu_count: opts.vcpus,
      mem_size_mib: opts.memMib,
      smt: false,
    });
    await api('PUT', '/boot-source', {
      kernel_image_path: '/vmlinux',
      boot_args: [
        'console=ttyS0 reboot=k panic=1 pci=off quiet',
        `ip=${address}::${config.bridgeAddress}:${netmask(config.prefixLength)}::eth0:off`,
        `init=${opts.init}`,
        ...opts.initArgs,
      ].join(' '),
    });
    await api('PUT', '/drives/rootfs', {
      drive_id: 'rootfs',
      path_on_host: '/rootfs.ext4',
      is_root_device: true,
      is_read_only: false,
    });
    // Second drive = /dev/vdb in the guest, read by the runner (root only).
    if (opts.config) {
      await api('PUT', '/drives/config', {
        drive_id: 'config',
        path_on_host: '/config.img',
        is_root_device: false,
        is_read_only: true,
      });
    }
    await api('PUT', '/network-interfaces/eth0', {
      iface_id: 'eth0',
      host_dev_name: vm.tap,
      guest_mac: this.mac(address),
    });
    await api('PUT', '/actions', { action_type: 'InstanceStart' });

    if (opts.killAt === null) return;
    const ttl = Math.max(0, Date.parse(opts.killAt) - this.now());
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
