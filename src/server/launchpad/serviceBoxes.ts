import express, { type Router } from 'express';
import { z } from 'zod';
import type { ActivityLog } from '../activity.js';
import { created, h, param } from '../http/handlers.js';
import type { ServiceDriver, ServiceImage, ServiceInfo, ServiceSpec } from './serviceDriver.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_HINT = 'lowercase letters, digits and dashes (up to 40)';
const MAX_PORT = 65_535;
const MIN_HOST_PORT = 1024;
const MAX_PUBLISHED = 16;
const MAX_VCPUS = 16;
const MIN_MEM_MIB = 256;
const MAX_MEM_MIB = 65_536;
const DEFAULT_MEM_MIB = 1024;

export const serviceLaunchSchema = z
  .object({
    image: z.string().regex(NAME_RE, `Image: ${NAME_HINT}`),
    /** Defaults to the image name. */
    name: z.string().regex(NAME_RE, `Name: ${NAME_HINT}`).optional(),
    vcpus: z.number().int().min(1).max(MAX_VCPUS).default(1),
    memMib: z.number().int().min(MIN_MEM_MIB).max(MAX_MEM_MIB).default(DEFAULT_MEM_MIB),
    agentAccess: z.boolean().default(false),
    publish: z
      .array(
        z.object({
          port: z.number().int().min(1).max(MAX_PORT),
          hostPort: z.number().int().min(MIN_HOST_PORT).max(MAX_PORT),
        }),
      )
      .max(MAX_PUBLISHED)
      .default([])
      .refine((p) => new Set(p.map((x) => x.hostPort)).size === p.length, 'Duplicate host port'),
  })
  .refine((s) => !s.agentAccess || s.publish.length > 0, {
    message: 'Publish at least one port to open the service to agents',
    path: ['publish'],
  });

/**
 * Service boxes: long-lived VMs built from a Dockerfile (`deploy/services/<image>`) that serve a
 * test service on the host's loopback (for tunnels and local clients) and, when opened to them,
 * to agent VMs. Unlike runs they have no session key and no deadline: they run until stopped.
 */
export class ServiceBoxes {
  constructor(
    private readonly driver: ServiceDriver,
    private readonly activity: ActivityLog,
  ) {}

  images(): Promise<ServiceImage[]> {
    return this.driver.listServiceImages();
  }

  list(): Promise<ServiceInfo[]> {
    return this.driver.listServices();
  }

  async launch(body: unknown): Promise<ServiceInfo> {
    const input = serviceLaunchSchema.parse(body);
    const spec: ServiceSpec = { ...input, name: input.name ?? input.image };
    const service = await this.driver.createService(spec);
    this.activity.add({
      kind: 'admin',
      detail: `Started service box "${service.name}" (image ${service.image}) at ${service.address}`,
    });
    return service;
  }

  async stop(serviceId: string): Promise<void> {
    const service = (await this.list()).find((s) => s.serviceId === serviceId);
    await this.driver.destroyService(serviceId);
    if (service)
      this.activity.add({ kind: 'admin', detail: `Stopped service box "${service.name}"` });
  }

  /** Running services agent VMs can reach (listed in their system prompt). */
  async forAgents(): Promise<ServiceInfo[]> {
    return (await this.list()).filter((s) => s.agentAccess && s.running);
  }
}

/** Admin: service boxes (mounted under `/api/admin/launchpad/services`). */
export function serviceBoxRoutes(services: ServiceBoxes): Router {
  const router = express.Router();
  router.get(
    '/images',
    h(() => services.images()),
  );
  router.get(
    '/',
    h(() => services.list()),
  );
  router.post(
    '/',
    created((req) => services.launch(req.body)),
  );
  router.delete(
    '/:id',
    h(async (req) => {
      await services.stop(param(req, 'id'));
    }),
  );
  return router;
}
