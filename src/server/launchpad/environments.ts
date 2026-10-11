import { z } from 'zod';
import type { Database } from '../db/database.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { randomId } from '../store/crypto.js';
import type { ImageStatus, VmDriver } from './vmDriver.js';

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_DOCKERFILE_CHARS = 100_000;
const MAX_LOG_CHARS = 16_000;
const ENVIRONMENT_NOT_FOUND = 'Guest environment not found';

export const environmentSchema = z.object({
  name: z.string().trim().min(1, 'Name the environment').max(MAX_NAME_LENGTH),
  description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).default(''),
  dockerfile: z
    .string()
    .max(MAX_DOCKERFILE_CHARS)
    .refine((d) => /^\s*FROM\s+\S/im.test(d), 'The Dockerfile needs a FROM instruction'),
});
export type EnvironmentInput = z.infer<typeof environmentSchema>;

/**
 * A guest environment: an agent VM image the admin added from a Dockerfile (with the launchpad's
 * runner added on top). Members pick one of the ready, enabled ones when launching an agent;
 * without one, agents boot the default guest image.
 */
export interface GuestEnvironment {
  id: string;
  name: string;
  description: string;
  dockerfile: string;
  /** Members can only pick enabled environments (the admin's allowlist). */
  enabled: boolean;
  status: ImageStatus;
  /** The end of the latest build's output. */
  buildLog: string;
  builtAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What members see of an environment they can pick. */
export interface EnvironmentChoice {
  id: string;
  name: string;
  description: string;
}

interface EnvironmentRow {
  id: string;
  name: string;
  description: string;
  dockerfile: string;
  enabled: number;
  status: ImageStatus;
  build_log: string;
  built_at: string | null;
  created_at: string;
  updated_at: string;
}

function toEnvironment(r: EnvironmentRow): GuestEnvironment {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    dockerfile: r.dockerfile,
    enabled: r.enabled === 1,
    status: r.status,
    buildLog: r.build_log,
    builtAt: r.built_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Guest environments: kept in the gateway database, built by the VM driver (vmd runs
 * `deploy/build-custom-image.sh`). Builds run in the background; `refresh` picks up their result.
 */
export class Environments {
  constructor(
    private readonly db: Database,
    private readonly driver: VmDriver,
    private readonly now: () => Date,
  ) {}

  list(): GuestEnvironment[] {
    const rows = this.db.sql
      .prepare('SELECT * FROM guest_environments ORDER BY name, id')
      .all() as unknown as EnvironmentRow[];
    return rows.map(toEnvironment);
  }

  get(id: string): GuestEnvironment | null {
    const row = this.db.sql.prepare('SELECT * FROM guest_environments WHERE id = ?').get(id) as
      EnvironmentRow | undefined;
    return row ? toEnvironment(row) : null;
  }

  require(id: string): GuestEnvironment {
    const env = this.get(id);
    if (!env) throw notFound(ENVIRONMENT_NOT_FOUND);
    return env;
  }

  /** The environments members can pick now: ready and enabled. */
  choices(): EnvironmentChoice[] {
    return this.list()
      .filter((e) => e.enabled && e.status === 'ready')
      .map(({ id, name, description }) => ({ id, name, description }));
  }

  /** The environment a run may boot, or why not. */
  launchable(id: string): GuestEnvironment {
    const env = this.get(id);
    if (!env?.enabled) throw badRequest('This guest environment is not available');
    if (env.status !== 'ready') {
      throw badRequest(`Guest environment "${env.name}" is not ready (${env.status})`);
    }
    return env;
  }

  /** Adds an environment and starts building it. */
  async create(input: unknown): Promise<GuestEnvironment> {
    const req = environmentSchema.parse(input);
    const ts = this.now().toISOString();
    const id = randomId();
    this.db.sql
      .prepare(
        `INSERT INTO guest_environments (id, name, description, dockerfile, enabled, status,
           build_log, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'building', '', ?, ?)`,
      )
      .run(id, req.name, req.description, req.dockerfile, ts, ts);
    await this.build(id, req.dockerfile);
    return this.require(id);
  }

  /** Edits an environment; a changed Dockerfile is rebuilt. */
  async update(id: string, input: unknown): Promise<GuestEnvironment> {
    const env = this.require(id);
    const req = environmentSchema.parse(input);
    const changed = req.dockerfile !== env.dockerfile;
    if (changed && env.status === 'building') throw conflict('The environment is being built');
    this.db.sql
      .prepare(
        'UPDATE guest_environments SET name = ?, description = ?, dockerfile = ?, updated_at = ? WHERE id = ?',
      )
      .run(req.name, req.description, req.dockerfile, this.now().toISOString(), id);
    if (changed) await this.build(id, req.dockerfile);
    return this.require(id);
  }

  /** Builds an environment again (e.g. to pick up a newer base image). */
  async rebuild(id: string): Promise<GuestEnvironment> {
    const env = this.require(id);
    if (env.status === 'building') throw conflict('The environment is being built');
    await this.build(id, env.dockerfile);
    return this.require(id);
  }

  setEnabled(id: string, enabled: boolean): GuestEnvironment {
    this.require(id);
    this.db.sql
      .prepare('UPDATE guest_environments SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, this.now().toISOString(), id);
    return this.require(id);
  }

  /** Deletes an environment and its image. Agents it launched keep running; new ones can't. */
  async delete(id: string): Promise<GuestEnvironment> {
    const env = this.require(id);
    await this.driver.deleteImage(id);
    this.db.sql.prepare('DELETE FROM guest_environments WHERE id = ?').run(id);
    return env;
  }

  /** Records how the builds going on ended (or how far they got). */
  async refresh(): Promise<void> {
    for (const env of this.list().filter((e) => e.status === 'building')) {
      const info = await this.driver.image(env.id).catch(() => undefined);
      if (info === undefined) continue;
      if (info === null) {
        this.setStatus(env.id, 'failed', 'The VM host lost the build (it may have restarted)');
        continue;
      }
      this.setStatus(env.id, info.status, info.log);
    }
  }

  private async build(id: string, dockerfile: string): Promise<void> {
    this.setStatus(id, 'building', '');
    try {
      await this.driver.buildImage(id, dockerfile);
    } catch (err) {
      this.setStatus(id, 'failed', `Could not start the build: ${(err as Error).message}`);
      return;
    }
    await this.refresh();
  }

  private setStatus(id: string, status: ImageStatus, log: string): void {
    const builtAt = status === 'ready' ? this.now().toISOString() : null;
    this.db.sql
      .prepare(
        `UPDATE guest_environments SET status = ?, build_log = ?,
           built_at = CASE WHEN ? IS NULL THEN built_at ELSE ? END WHERE id = ?`,
      )
      .run(status, log.slice(-MAX_LOG_CHARS), builtAt, builtAt, id);
  }
}
