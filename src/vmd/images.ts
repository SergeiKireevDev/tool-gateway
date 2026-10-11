import path from 'node:path';
import { HTTP } from '../server/httpStatus.js';
import type { ImageInfo, ImageStatus } from '../server/launchpad/vmDriver.js';
import { BYTES_PER_KIB } from '../server/units.js';
import type { VmdConfig } from './config.js';
import type { HostOps, HostProcess } from './host.js';
import { VmdError } from './vmManager.js';

/** Image ids are the gateway's guest environment ids; they name files, so nothing else. */
export const IMAGE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const LOG_TAIL_KIB = 16;
const LOG_TAIL_BYTES = LOG_TAIL_KIB * BYTES_PER_KIB;

interface Build {
  status: ImageStatus;
  process: HostProcess;
}

/**
 * Builds guest environments: the root filesystem of each, from the admin's Dockerfile, with the
 * launchpad's runner added (`deploy/build-custom-image.sh`). One build at a time per image; a
 * rebuild replaces the image, which VMs already booted from it don't notice (they have a copy).
 */
export class ImageBuilder {
  private readonly builds = new Map<string, Build>();

  constructor(
    private readonly config: VmdConfig,
    private readonly host: HostOps,
  ) {}

  rootfs(imageId: string): string {
    return this.file(imageId, 'ext4');
  }

  /** Starts building an image; its status says when it is done. */
  async build(imageId: string, dockerfile: string): Promise<ImageInfo> {
    if (this.builds.get(imageId)?.status === 'building') {
      throw new VmdError(HTTP.CONFLICT, 'The image is already being built');
    }
    const { config, host } = this;
    await host.mkdir(config.imagesDir);
    // A failed rebuild must not leave the previous image behind as if it were ready.
    await host.remove(this.rootfs(imageId));
    await host.remove(this.file(imageId, 'log'));
    const dockerfilePath = this.file(imageId, 'Dockerfile');
    await host.writeFile(dockerfilePath, dockerfile);
    const process = host.start(
      config.imageBuildScript,
      [dockerfilePath, this.rootfs(imageId), config.imageSize],
      this.file(imageId, 'log'),
    );
    const build: Build = { status: 'building', process };
    this.builds.set(imageId, build);
    process.onExit((code) => {
      build.status = code === 0 ? 'ready' : 'failed';
      console.info(`vmd: image ${imageId} build ${build.status} (exit code ${String(code)})`);
    });
    return { imageId, status: build.status, log: '' };
  }

  /** An image's status and the end of its build log, or null if vmd knows nothing of it. */
  async info(imageId: string): Promise<ImageInfo | null> {
    const status = await this.status(imageId);
    if (status === null) return null;
    return {
      imageId,
      status,
      log: await this.host.readTail(this.file(imageId, 'log'), LOG_TAIL_BYTES),
    };
  }

  /** The rootfs of an image VMs can boot from now. */
  async readyRootfs(imageId: string): Promise<string> {
    if ((await this.status(imageId)) !== 'ready') {
      throw new VmdError(HTTP.BAD_REQUEST, `Guest image ${imageId} is not ready`);
    }
    return this.rootfs(imageId);
  }

  /** Stops its build if one is going, and deletes the image. Unknown images are fine. */
  async delete(imageId: string): Promise<void> {
    const build = this.builds.get(imageId);
    if (build?.status === 'building') build.process.kill('SIGKILL');
    this.builds.delete(imageId);
    for (const ext of ['ext4', 'ext4.tmp', 'Dockerfile', 'log']) {
      await this.host.remove(this.file(imageId, ext));
    }
  }

  /** Builds started since vmd started are tracked; older images are ready if their rootfs exists. */
  private async status(imageId: string): Promise<ImageStatus | null> {
    const build = this.builds.get(imageId);
    if (build) return build.status;
    if (await this.host.exists(this.rootfs(imageId))) return 'ready';
    return (await this.host.exists(this.file(imageId, 'log'))) ? 'failed' : null;
  }

  private file(imageId: string, ext: string): string {
    if (!IMAGE_ID_RE.test(imageId)) throw new VmdError(HTTP.BAD_REQUEST, 'Invalid image id');
    return path.join(this.config.imagesDir, `${imageId}.${ext}`);
  }
}
