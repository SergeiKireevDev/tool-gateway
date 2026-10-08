import { request } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_DRIVE_BYTES } from '../src/server/launchpad/protocol.js';
import type { VmSpec } from '../src/server/launchpad/vmDriver.js';
import { VmdDriver } from '../src/server/launchpad/vmdDriver.js';
import { loadVmdConfig, type VmdConfig } from '../src/vmd/config.js';
import type { ServiceSpec } from '../src/server/launchpad/serviceDriver.js';
import type { HostOps, HostProcess, PortForward } from '../src/vmd/host.js';
import { createVmdServer, listenOnSocket } from '../src/vmd/server.js';
import { VmManager } from '../src/vmd/vmManager.js';

/** Records every host operation; Firecracker "starts" and creates its API socket at once. */
class FakeHost implements HostOps {
  readonly commands: string[] = [];
  readonly api: { path: string; body: unknown }[] = [];
  readonly files = new Map<string, Buffer | string>();
  readonly procs: FakeProc[] = [];
  /** Open forwards, as `listen:hostPort -> address:port`. */
  readonly forwards = new Set<string>();
  failCommand: string | null = null;
  failForward = false;

  run(command: string, args: readonly string[]): Promise<void> {
    const line = [command, ...args].join(' ');
    this.commands.push(line);
    return this.failCommand && line.includes(this.failCommand)
      ? Promise.reject(new Error(`failed: ${line}`))
      : Promise.resolve();
  }
  tryRun(command: string, args: readonly string[]): Promise<void> {
    this.commands.push(`(try) ${[command, ...args].join(' ')}`);
    return Promise.resolve();
  }
  start(command: string, args: readonly string[]): HostProcess {
    this.commands.push(`start ${[command, ...args].join(' ')}`);
    const id = args[args.indexOf('--id') + 1] ?? '';
    const base = args[args.indexOf('--chroot-base-dir') + 1] ?? '';
    this.files.set(path.join(base, 'firecracker', id, 'root', 'api.sock'), '');
    const proc = new FakeProc();
    this.procs.push(proc);
    return proc;
  }
  exists(file: string): Promise<boolean> {
    // The jail's API socket and service images exist once created; host files always do.
    const created = file.endsWith('api.sock') || file.includes('/services/');
    return Promise.resolve(this.files.has(file) || !created);
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
  remove(target: string): Promise<void> {
    this.commands.push(`rm ${target}`);
    return Promise.resolve();
  }
  copySparse(from: string, to: string): Promise<void> {
    this.files.set(to, `copy of ${from}`);
    return Promise.resolve();
  }
  writePadded(file: string, content: Buffer, size: number): Promise<void> {
    const buf = Buffer.alloc(size);
    content.copy(buf);
    this.files.set(file, buf);
    return Promise.resolve();
  }
  chown(): Promise<void> {
    return Promise.resolve();
  }
  firecracker(_socket: string, _method: string, apiPath: string, body: unknown): Promise<void> {
    this.api.push({ path: apiPath, body });
    return Promise.resolve();
  }
  readDir(dir: string): Promise<string[]> {
    const names = [...this.files.keys()]
      .filter((f) => path.dirname(f) === dir)
      .map((f) => path.basename(f));
    return Promise.resolve(names);
  }
  readText(file: string): Promise<string> {
    const content = this.files.get(file);
    return content === undefined
      ? Promise.reject(new Error(`ENOENT ${file}`))
      : Promise.resolve(content.toString());
  }
  forward(
    listenAddress: string,
    hostPort: number,
    address: string,
    port: number,
  ): Promise<PortForward> {
    if (this.failForward) return Promise.reject(new Error('EADDRINUSE'));
    const key = `${listenAddress}:${hostPort} -> ${address}:${port}`;
    this.forwards.add(key);
    return Promise.resolve({ close: () => this.forwards.delete(key) });
  }
}

class FakeProc implements HostProcess {
  readonly pid = 1234;
  killed: string[] = [];
  private listeners: ((code: number | null) => void)[] = [];
  onExit(listener: (code: number | null) => void): void {
    this.listeners.push(listener);
  }
  kill(signal: NodeJS.Signals): void {
    this.killed.push(signal);
    this.exit();
  }
  exit(): void {
    for (const l of this.listeners) l(0);
    this.listeners = [];
  }
}

const spec = (runId = 'run-1'): VmSpec => ({
  runId,
  vcpus: 1,
  memMib: 1024,
  killAt: new Date(Date.now() + 3_600_000).toISOString(),
  config: {
    runId,
    runToken: 'gwr_t',
    gatewayUrl: 'http://172.30.0.1:7420',
    sessionKey: 'gws_k',
    harness: 'claude-code',
    llm: { provider: 'anthropic', model: null },
    gatewayTools: [],
    prompt: 'p',
    systemPrompt: 's',
    memory: null,
    deadline: new Date().toISOString(),
  },
});

const serviceSpec = (extra: Partial<ServiceSpec> = {}): ServiceSpec => ({
  name: 'echo',
  image: 'echo',
  vcpus: 1,
  memMib: 512,
  agentAccess: false,
  publish: [{ port: 8080, hostPort: 18080 }],
  ...extra,
});

let config: VmdConfig;
let host: FakeHost;
let vms: VmManager;

beforeEach(() => {
  config = { ...loadVmdConfig({}), maxVms: 2 };
  host = new FakeHost();
  vms = new VmManager(config, host);
});

describe('vmd VM manager', () => {
  it('boots a jailed Firecracker VM on an isolated tap with a config drive', async () => {
    const { vmId } = await vms.create(spec());
    expect(vmId).toMatch(/^lp-[0-9a-f]{12}$/);
    expect(host.commands).toEqual(
      expect.arrayContaining([
        'ip tuntap add dev lptap1 mode tap user 900',
        'ip link set lptap1 master lpbr0',
        'bridge link set dev lptap1 isolated on',
        expect.stringMatching(
          /^start \/usr\/local\/bin\/jailer --id lp-\w+ --exec-file \/usr\/local\/bin\/firecracker --uid 900 --gid 900 --chroot-base-dir \/srv\/launchpad-jail -- --api-sock \/api.sock$/,
        ),
      ]),
    );
    const root = path.join(config.jailBase, 'firecracker', vmId, 'root');
    const drive = host.files.get(path.join(root, 'config.img')) as Buffer;
    expect(drive.length).toBe(CONFIG_DRIVE_BYTES);
    const json = JSON.parse(drive.subarray(0, drive.indexOf(0)).toString());
    expect(json).toMatchObject({
      runId: 'run-1',
      network: { address: '172.30.0.2', prefixLength: 24, gateway: '172.30.0.1' },
    });
    expect(host.api.map((a) => a.path)).toEqual([
      '/machine-config',
      '/boot-source',
      '/drives/rootfs',
      '/drives/config',
      '/network-interfaces/eth0',
      '/actions',
    ]);
    expect(JSON.stringify(host.api[1]?.body)).toContain(
      'ip=172.30.0.2::172.30.0.1:255.255.255.0::eth0:off',
    );
    expect(host.api[4]?.body).toMatchObject({
      host_dev_name: 'lptap1',
      guest_mac: '06:00:ac:1e:00:02',
    });
    expect(vms.list()).toEqual([{ vmId, runId: 'run-1', running: true }]);
  });

  it('limits concurrent VMs and reuses freed slots', async () => {
    const a = await vms.create(spec('a'));
    await vms.create(spec('b'));
    await expect(vms.create(spec('c'))).rejects.toMatchObject({ status: 503 });
    expect(await vms.destroy(a.vmId)).toBe(true);
    expect(host.procs[0]?.killed).toEqual(['SIGKILL']);
    expect(host.commands).toContain('(try) ip link del lptap1');
    await vms.create(spec('c'));
    expect(
      vms
        .list()
        .map((v) => v.runId)
        .sort(),
    ).toEqual(['b', 'c']);
    expect(await vms.destroy('lp-unknown')).toBe(false);
  });

  it('reports VMs that exited and cleans up after a failed boot', async () => {
    const { vmId } = await vms.create(spec());
    host.procs[0]?.exit();
    expect(vms.list()).toEqual([{ vmId, runId: 'run-1', running: false }]);
    host.failCommand = 'isolated on';
    await expect(vms.create(spec('x'))).rejects.toThrow('failed');
    expect(vms.list()).toHaveLength(1);
    expect(host.commands).toContain('(try) ip link del lptap2');
  });
});

describe('vmd service boxes', () => {
  beforeEach(() => {
    host.files.set(path.join(config.serviceDir, 'echo.ext4'), 'image');
    host.files.set(path.join(config.serviceDir, 'echo.json'), JSON.stringify({ ports: [8080] }));
    // A manifest without its image is not listed.
    host.files.set(path.join(config.serviceDir, 'half.json'), JSON.stringify({ ports: [1] }));
  });

  it('lists built images', async () => {
    expect(await vms.listImages()).toEqual([{ name: 'echo', ports: [8080] }]);
  });

  it('boots a long-lived VM from the image, without config drive, and publishes its ports', async () => {
    const service = await vms.createService(serviceSpec());
    expect(service).toMatchObject({
      name: 'echo',
      address: '172.30.0.2',
      ports: [8080],
      running: true,
    });
    const root = path.join(config.jailBase, 'firecracker', service.serviceId, 'root');
    expect(host.files.get(path.join(root, 'rootfs.ext4'))).toBe(
      `copy of ${path.join(config.serviceDir, 'echo.ext4')}`,
    );
    expect(host.files.has(path.join(root, 'config.img'))).toBe(false);
    expect(host.api.map((a) => a.path)).not.toContain('/drives/config');
    expect(JSON.stringify(host.api[1]?.body)).toContain(
      'init=/sbin/service-box-init lp_service=echo',
    );
    expect(host.commands).toContain('bridge link set dev lptap1 isolated on');
    expect([...host.forwards]).toEqual(['127.0.0.1:18080 -> 172.30.0.2:8080']);
    expect(service.agentEndpoints).toEqual([]);
    expect(host.commands.join('\n')).not.toContain('nft add');
    // Not an agent run: invisible to the launchpad's reaper, and not destroyable as a run.
    expect(vms.list()).toEqual([]);
    expect(await vms.destroy(service.serviceId)).toBe(false);
    expect(vms.listServices()).toHaveLength(1);

    expect(await vms.destroyService(service.serviceId)).toBe(true);
    expect(host.forwards.size).toBe(0);
    expect(host.procs[0]?.killed).toEqual(['SIGKILL']);
    expect(vms.listServices()).toEqual([]);
  });

  it('opens published ports to agents on the bridge address, through the VM firewall', async () => {
    const service = await vms.createService(serviceSpec({ agentAccess: true }));
    // The service's tap stays isolated: agents only reach it through vmd's forward.
    expect(host.commands).toContain('bridge link set dev lptap1 isolated on');
    expect([...host.forwards]).toEqual([
      '127.0.0.1:18080 -> 172.30.0.2:8080',
      '172.30.0.1:18080 -> 172.30.0.2:8080',
    ]);
    expect(host.commands).toContain('nft add element inet launchpad service_ports { 18080 }');
    expect(service.agentEndpoints).toEqual(['172.30.0.1:18080']);
    await vms.destroyService(service.serviceId);
    expect(host.commands).toContain(
      '(try) nft delete element inet launchpad service_ports { 18080 }',
    );
    expect(host.forwards.size).toBe(0);
  });

  it('forgets ports opened by a previous vmd', async () => {
    await vms.init();
    expect(host.commands).toContain('(try) nft flush set inet launchpad service_ports');
  });

  it('refuses unknown images, taken names and host ports, and cleans up failed publishing', async () => {
    await expect(vms.createService(serviceSpec({ image: 'half' }))).rejects.toMatchObject({
      status: 404,
    });
    await vms.createService(serviceSpec());
    await expect(vms.createService(serviceSpec({ publish: [] }))).rejects.toMatchObject({
      status: 409,
    });
    await expect(vms.createService(serviceSpec({ name: 'other' }))).rejects.toMatchObject({
      status: 409,
    });
    host.failForward = true;
    await expect(
      vms.createService(serviceSpec({ name: 'other', publish: [{ port: 1, hostPort: 2000 }] })),
    ).rejects.toMatchObject({ status: 409 });
    expect(vms.listServices().map((s) => s.name)).toEqual(['echo']);
    expect(host.commands).toContain('(try) ip link del lptap2');
  });

  it('destroys runs and services on shutdown', async () => {
    await vms.create(spec());
    await vms.createService(serviceSpec());
    await vms.destroyAll();
    expect(vms.list()).toEqual([]);
    expect(vms.listServices()).toEqual([]);
  });
});

describe('vmd API with the gateway driver', () => {
  let socket: string;
  let server: ReturnType<typeof createVmdServer>;

  beforeEach(async () => {
    socket = path.join(await mkdtemp(path.join(tmpdir(), 'vmd-')), 'vmd.sock');
    server = createVmdServer(vms);
    await listenOnSocket(server, socket, null);
  });
  afterEach(() => {
    server.close();
  });

  it('creates, lists and destroys VMs over the unix socket', async () => {
    const driver = new VmdDriver(socket);
    const { vmId } = await driver.create(spec());
    expect(await driver.list()).toEqual([{ vmId, runId: 'run-1', running: true }]);
    await driver.destroy(vmId);
    await driver.destroy(vmId); // idempotent
    expect(await driver.list()).toEqual([]);
  });

  it('launches, lists and stops service boxes over the unix socket', async () => {
    host.files.set(path.join(config.serviceDir, 'echo.ext4'), 'image');
    host.files.set(path.join(config.serviceDir, 'echo.json'), JSON.stringify({ ports: [8080] }));
    const driver = new VmdDriver(socket);
    expect(await driver.listServiceImages()).toEqual([{ name: 'echo', ports: [8080] }]);
    const service = await driver.createService(serviceSpec());
    expect(await driver.listServices()).toEqual([service]);
    expect(await driver.list()).toEqual([]);
    await expect(driver.createService(serviceSpec())).rejects.toMatchObject({
      status: 409,
      message: 'A service named echo is already running',
    });
    await expect(
      driver.createService(serviceSpec({ publish: [{ port: 1, hostPort: 80 }] })),
    ).rejects.toMatchObject({ status: 400 });
    await driver.destroyService(service.serviceId);
    await driver.destroyService(service.serviceId); // idempotent
    expect(await driver.listServices()).toEqual([]);
  });

  it('validates specs', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: socket, path: '/vms', method: 'POST' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ runId: 'x', vcpus: 99 }));
    });
    expect(status).toBe(400);
  });
});
