import { request } from 'node:http';
import { HttpError } from '../errors.js';
import { HTTP } from '../httpStatus.js';
import type { ServiceDriver, ServiceImage, ServiceInfo, ServiceSpec } from './serviceDriver.js';
import type { VmDriver, VmInfo, VmSpec } from './vmDriver.js';

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const NOT_FOUND = 404;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ERROR_CHARS = 500;
/** vmd answers these for requests it refuses (bad spec, unknown image, name taken, full). */
const RELAYED_STATUSES = new Set<number>([
  HTTP.BAD_REQUEST,
  HTTP.NOT_FOUND,
  HTTP.CONFLICT,
  HTTP.SERVICE_UNAVAILABLE,
]);

function vmdError(status: number, text: string): string | null {
  if (!RELAYED_STATUSES.has(status)) return null;
  try {
    const { error } = JSON.parse(text) as { error?: unknown };
    return typeof error === 'string' ? error.slice(0, MAX_ERROR_CHARS) : null;
  } catch {
    return null;
  }
}

/** Talks to `vmd` (the root Firecracker daemon) over its unix socket. */
export class VmdDriver implements VmDriver, ServiceDriver {
  readonly name = 'firecracker';

  constructor(private readonly socketPath: string) {}

  async create(spec: VmSpec): Promise<{ vmId: string }> {
    return (await this.call('POST', '/vms', spec)) as { vmId: string };
  }

  async destroy(vmId: string): Promise<void> {
    await this.call('DELETE', `/vms/${encodeURIComponent(vmId)}`, undefined, true);
  }

  async list(): Promise<VmInfo[]> {
    return (await this.call('GET', '/vms')) as VmInfo[];
  }

  async createService(spec: ServiceSpec): Promise<ServiceInfo> {
    return (await this.call('POST', '/services', spec)) as ServiceInfo;
  }

  async destroyService(serviceId: string): Promise<void> {
    await this.call('DELETE', `/services/${encodeURIComponent(serviceId)}`, undefined, true);
  }

  async listServices(): Promise<ServiceInfo[]> {
    return (await this.call('GET', '/services')) as ServiceInfo[];
  }

  async listServiceImages(): Promise<ServiceImage[]> {
    return (await this.call('GET', '/service-images')) as ServiceImage[];
  }

  private call(
    method: string,
    path: string,
    body?: unknown,
    allowMissing = false,
  ): Promise<unknown> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method,
          timeout: REQUEST_TIMEOUT_MS,
          headers: payload ? { 'content-type': 'application/json' } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (allowMissing && status === NOT_FOUND) {
              resolve(null);
              return;
            }
            if (status < HTTP_OK_MIN || status > HTTP_OK_MAX) {
              const refused = vmdError(status, text);
              if (refused !== null) {
                reject(new HttpError(status, refused));
                return;
              }
              reject(
                new Error(
                  `vmd ${method} ${path}: HTTP ${status} ${text.slice(0, MAX_ERROR_CHARS)}`,
                ),
              );
              return;
            }
            resolve(text ? (JSON.parse(text) as unknown) : null);
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`vmd ${method} ${path} timed out`)));
      req.on('error', reject);
      req.end(payload);
    });
  }
}
