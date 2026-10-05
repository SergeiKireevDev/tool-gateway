import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomId } from '../store/crypto.js';
import { PRIVATE_FILE_MODE } from '../units.js';
import type { VmDriver, VmInfo, VmSpec } from './vmDriver.js';

interface LocalVm {
  runId: string;
  child: ChildProcess;
  dir: string;
  running: boolean;
  killTimer: NodeJS.Timeout;
}

/**
 * DEVELOPMENT ONLY: runs the runner as a plain child process of the gateway, with no VM, no
 * network lockdown and the gateway user's privileges. Lets the launchpad be developed and tested
 * on machines without KVM. Enabled with `LAUNCHPAD_VM_DRIVER=local-unsafe`.
 */
export class LocalProcessDriver implements VmDriver {
  readonly name = 'local-unsafe';
  private readonly vms = new Map<string, LocalVm>();

  constructor(
    private readonly runnerScript: string,
    private readonly env: Record<string, string> = {},
  ) {}

  async create(spec: VmSpec): Promise<{ vmId: string }> {
    const vmId = randomId();
    const dir = await mkdtemp(path.join(tmpdir(), 'launchpad-local-'));
    const configFile = path.join(dir, 'config.json');
    const config = { ...spec.config, network: { address: '', prefixLength: 0, gateway: '' } };
    await writeFile(configFile, JSON.stringify(config), { mode: PRIVATE_FILE_MODE });
    const child = spawn(
      process.execPath,
      [this.runnerScript, '--config', configFile, '--home', dir],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          NODE_ENV: 'production',
          PATH: process.env.PATH ?? '',
          HOME: dir,
          // Development: where to find (fake or local) harness CLIs.
          ...(process.env.LAUNCHPAD_HARNESS_PATH
            ? { LAUNCHPAD_HARNESS_PATH: process.env.LAUNCHPAD_HARNESS_PATH }
            : {}),
          ...this.env,
        },
      },
    );
    const killTimer = setTimeout(
      () => child.kill('SIGKILL'),
      Math.max(0, Date.parse(spec.killAt) - Date.now()),
    );
    killTimer.unref();
    const vm: LocalVm = { runId: spec.runId, child, dir, running: true, killTimer };
    child.on('exit', () => {
      vm.running = false;
      clearTimeout(killTimer);
    });
    this.vms.set(vmId, vm);
    return { vmId };
  }

  async destroy(vmId: string): Promise<void> {
    const vm = this.vms.get(vmId);
    if (!vm) return;
    this.vms.delete(vmId);
    clearTimeout(vm.killTimer);
    if (vm.running) vm.child.kill('SIGKILL');
    await rm(vm.dir, { recursive: true, force: true });
  }

  list(): Promise<VmInfo[]> {
    return Promise.resolve(
      [...this.vms.entries()].map(([vmId, vm]) => ({ vmId, runId: vm.runId, running: vm.running })),
    );
  }
}
