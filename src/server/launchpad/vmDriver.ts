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
  /** The guest environment to boot (a built image); the default guest image if absent. */
  imageId?: string;
}

export const IMAGE_STATUSES = ['building', 'ready', 'failed'] as const;
export type ImageStatus = (typeof IMAGE_STATUSES)[number];

/** A guest environment's image, as the VM layer builds it from the admin's Dockerfile. */
export interface ImageInfo {
  imageId: string;
  status: ImageStatus;
  /** The end of the build's output. */
  log: string;
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
  /** Starts building (or rebuilding) a guest environment's image from a Dockerfile. */
  buildImage(imageId: string, dockerfile: string): Promise<void>;
  /** An image's build status, or null when the driver has no such image. */
  image(imageId: string): Promise<ImageInfo | null>;
  /** Idempotent: stops its build and deletes the image. */
  deleteImage(imageId: string): Promise<void>;
}
