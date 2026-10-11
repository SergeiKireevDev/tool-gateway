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
    // Host files exist (rootfs, kernel…), those vmd creates once written.
    const created = file.endsWith('api.sock') || file.includes('/images/');
    return Promise.resolve(this.files.has(file) || !created);
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
  remove(target: string): Promise<void> {
    this.commands.push(`rm ${target}`);
    this.files.delete(target);
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
  writeFile(file: string, content: string): Promise<void> {
    this.files.set(file, content);
    return Promise.resolve();
  }
  readTail(file: string, maxBytes: number): Promise<string> {
    return Promise.resolve(String(this.files.get(file) ?? '').slice(-maxBytes));
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
  exit(code = 0): void {
    for (const l of this.listeners) l(code);
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

describe('vmd guest environment images', () => {
  it('builds an image from a Dockerfile with the build script, then boots VMs from it', async () => {
    const info = await vms.images.build('env-1', 'FROM launchpad-guest:latest\n');
    expect(info).toEqual({ imageId: 'env-1', status: 'building', log: '' });
    const dockerfile = path.join(config.imagesDir, 'env-1.Dockerfile');
    const rootfs = path.join(config.imagesDir, 'env-1.ext4');
    expect(host.files.get(dockerfile)).toBe('FROM launchpad-guest:latest\n');
    expect(host.commands).toContain(
      `start ${config.imageBuildScript} ${dockerfile} ${rootfs} ${config.imageSize}`,
    );
    // Not bootable while it builds, nor rebuildable.
    await expect(vms.create({ ...spec(), imageId: 'env-1' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(vms.images.build('env-1', 'FROM x')).rejects.toMatchObject({ status: 409 });

    host.files.set(path.join(config.imagesDir, 'env-1.log'), 'Step 1/3\nDone');
    host.procs.at(-1)?.exit(0);
    expect(await vms.images.info('env-1')).toEqual({
      imageId: 'env-1',
      status: 'ready',
      log: 'Step 1/3\nDone',
    });
    const { vmId } = await vms.create({ ...spec(), imageId: 'env-1' });
    const root = path.join(config.jailBase, 'firecracker', vmId, 'root');
    expect(host.files.get(path.join(root, 'rootfs.ext4'))).toBe(`copy of ${rootfs}`);
  });

  it('reports failed builds, deletes images and refuses odd ids', async () => {
    await vms.images.build('env-2', 'FROM x');
    host.procs.at(-1)?.exit(1);
    expect(await vms.images.info('env-2')).toMatchObject({ status: 'failed' });
    await expect(vms.create({ ...spec(), imageId: 'env-2' })).rejects.toMatchObject({
      status: 400,
    });

    await vms.images.build('env-3', 'FROM x');
    const build = host.procs.at(-1);
    await vms.images.delete('env-3');
    expect(build?.killed).toEqual(['SIGKILL']);
    expect(host.commands).toContain(`rm ${path.join(config.imagesDir, 'env-3.ext4')}`);
    expect(await vms.images.info('env-3')).toBeNull();
    expect(await vms.images.info('never-built')).toBeNull();
    await expect(vms.images.build('../etc', 'FROM x')).rejects.toMatchObject({ status: 400 });
  });

  it('knows images built before vmd restarted by their rootfs', async () => {
    host.files.set(path.join(config.imagesDir, 'old.ext4'), 'rootfs');
    const restarted = new VmManager(config, host);
    expect(await restarted.images.info('old')).toMatchObject({ status: 'ready' });
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

  it('builds, reports and deletes guest environment images', async () => {
    const driver = new VmdDriver(socket);
    await driver.buildImage('env-1', 'FROM launchpad-guest:latest');
    expect(await driver.image('env-1')).toMatchObject({ imageId: 'env-1', status: 'building' });
    host.procs.at(-1)?.exit(0);
    expect(await driver.image('env-1')).toMatchObject({ status: 'ready' });
    await driver.deleteImage('env-1');
    await driver.deleteImage('env-1'); // idempotent
    expect(await driver.image('env-1')).toBeNull();
    await expect(driver.buildImage('env-2', '')).rejects.toThrow('HTTP 400');
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
