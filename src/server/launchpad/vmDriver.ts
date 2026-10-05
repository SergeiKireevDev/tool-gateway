import type { RunnerConfig } from './protocol.js';

/** What the launchpad asks the VM layer to boot for one run. */
export interface VmSpec {
  runId: string;
  /** Written to the VM's config drive; the driver fills in the guest network. */
  config: Omit<RunnerConfig, 'network'>;
  vcpus: number;
  memMib: number;
  /** The driver kills the VM at this time whatever the guest does (ISO). */
  killAt: string;
}

export interface VmInfo {
  vmId: string;
  runId: string;
  /** False once the VM process exited (it is still listed until destroyed). */
  running: boolean;
}

/**
 * Boots and destroys agent VMs. The production driver talks to `vmd` (Firecracker, root daemon);
 * the local driver runs the runner as a plain process for development (no isolation).
 */
export interface VmDriver {
  readonly name: string;
  create(spec: VmSpec): Promise<{ vmId: string }>;
  /** Idempotent: destroying an unknown or already gone VM succeeds. */
  destroy(vmId: string): Promise<void>;
  list(): Promise<VmInfo[]>;
}
