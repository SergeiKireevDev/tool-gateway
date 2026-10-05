import { request } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_DRIVE_BYTES } from '../src/server/launchpad/protocol.js';
import type { VmSpec } from '../src/server/launchpad/vmDriver.js';
import { VmdDriver } from '../src/server/launchpad/vmdDriver.js';
import { loadVmdConfig, type VmdConfig } from '../src/vmd/config.js';
import type { HostOps, HostProcess } from '../src/vmd/host.js';
import { createVmdServer, listenOnSocket } from '../src/vmd/server.js';
import { VmManager } from '../src/vmd/vmManager.js';

/** Records every host operation; Firecracker "starts" and creates its API socket at once. */
class FakeHost implements HostOps {
  readonly commands: string[] = [];
  readonly api: { path: string; body: unknown }[] = [];
  readonly files = new Map<string, Buffer | string>();
  readonly procs: FakeProc[] = [];
  failCommand: string | null = null;

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
    return Promise.resolve(this.files.has(file) || !file.endsWith('api.sock'));
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
