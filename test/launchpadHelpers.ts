import request from 'supertest';
import { createApp, createVmApp } from '../src/server/http/app.js';
import { Launchpad } from '../src/server/launchpad/launchpad.js';
import type { RunnerConfig } from '../src/server/launchpad/protocol.js';
import { RunStore } from '../src/server/launchpad/runStore.js';
import { Scheduler } from '../src/server/launchpad/scheduler.js';
import type { VmDriver, VmInfo, VmSpec } from '../src/server/launchpad/vmDriver.js';
import { createHarness, type Harness } from './helpers.js';

/** VM driver that boots nothing: records specs and lets tests stop VMs or make boots fail. */
export class FakeVmDriver implements VmDriver {
  readonly name = 'fake';
  readonly specs: VmSpec[] = [];
  readonly vms = new Map<string, VmInfo>();
  readonly destroyed: string[] = [];
  failNext: string | null = null;
  private n = 0;

  create(spec: VmSpec): Promise<{ vmId: string }> {
    if (this.failNext) {
      const message = this.failNext;
      this.failNext = null;
      return Promise.reject(new Error(message));
    }
    this.specs.push(spec);
    this.n += 1;
    const vmId = `vm-${this.n}`;
    this.vms.set(vmId, { vmId, runId: spec.runId, running: true });
    return Promise.resolve({ vmId });
  }

  destroy(vmId: string): Promise<void> {
    this.destroyed.push(vmId);
    this.vms.delete(vmId);
    return Promise.resolve();
  }

  list(): Promise<VmInfo[]> {
    return Promise.resolve([...this.vms.values()]);
  }

  /** The runner config the latest VM was booted with. */
  lastConfig(): Omit<RunnerConfig, 'network'> {
    const spec = this.specs.at(-1);
    if (!spec) throw new Error('No VM booted');
    return spec.config;
  }
}

export interface LaunchHarness extends Harness {
  launchpad: Launchpad;
  scheduler: Scheduler;
  driver: FakeVmDriver;
  app: ReturnType<typeof createApp>;
  vmApp: ReturnType<typeof createVmApp>;
  adminToken: string;
  ids: { github: string; anthropic: string; template: string; noLlmTemplate: string };
  /** A fresh portal cookie for a member (web sessions last 12 hours of the test clock). */
  cookieFor(name: string): Promise<string>;
  /** Creates a member with a Google email and returns it with a portal cookie. */
  member(name: string, templateIds?: string[]): Promise<{ id: string; cookie: string }>;
  portal(cookie: string, method: 'get' | 'post' | 'patch' | 'delete', path: string): request.Test;
  admin(method: 'get' | 'post' | 'put' | 'patch', path: string): request.Test;
  runner(token: string, method: 'post' | 'put', path: string): request.Test;
}

export async function createLaunchHarness(): Promise<LaunchHarness> {
  const h = await createHarness();
  const driver = new FakeVmDriver();
  const launchpad = new Launchpad({
    gateway: h.gateway,
    runs: new RunStore(h.db),
    driver,
    crypto: h.crypto,
    vmGatewayUrl: 'http://172.30.0.1:7420',
    now: () => h.clock.now,
  });
  const scheduler = new Scheduler(h.db, h.gateway, launchpad, () => h.clock.now);
  launchpad.onFinished((run) => {
    scheduler.onRunFinished(run);
  });
  const app = createApp(h.gateway, h.config, { fetch: h.fetch, launchpad, scheduler });
  const vmApp = createVmApp(h.gateway, h.config, { fetch: h.fetch, launchpad });
  const adminToken = await h.gateway.rotateAdminToken();
  const admin = (method: 'get' | 'post' | 'put' | 'patch', path: string) =>
    request(app)[method](`/api/admin${path}`).set('authorization', `Bearer ${adminToken}`);

  const github = await admin('post', '/accounts')
    .send({ tool: 'github', label: 'gh', secret: 'ghp_real' })
    .expect(201);
  const anthropic = await admin('post', '/accounts')
    .send({ tool: 'anthropic', label: 'claude', secret: 'sk-ant-real' })
    .expect(201);
  const template = await admin('post', '/templates')
    .send({
      name: 'triage agents',
      grants: [
        { tool: 'github', permissions: ['issues:read'], resources: ['o/r'] },
        { tool: 'anthropic', permissions: ['llm:invoke'], resources: ['claude-sonnet-5'] },
      ],
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 4 * 3600,
    })
    .expect(201);
  const noLlm = await admin('post', '/templates')
    .send({
      name: 'no model',
      grants: [{ tool: 'github', permissions: ['issues:read'], resources: [] }],
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 4 * 3600,
    })
    .expect(201);
  const ids = {
    github: github.body.id as string,
    anthropic: anthropic.body.id as string,
    template: template.body.id as string,
    noLlmTemplate: noLlm.body.id as string,
  };

  return {
    ...h,
    launchpad,
    scheduler,
    driver,
    app,
    vmApp,
    adminToken,
    ids,
    admin,
    async cookieFor(name) {
      const identity = h.gateway.identify(`${name}@example.com`);
      if (identity?.role !== 'member') throw new Error('member sign-in failed');
      const { token } = await h.gateway.createWebSession(identity);
      return `gw_session=${token}`;
    },
    async member(name, templateIds = [ids.template, ids.noLlmTemplate]) {
      const email = `${name}@example.com`;
      const res = await admin('post', '/members')
        .send({ name, email, templateIds, accountIds: [ids.github, ids.anthropic] })
        .expect(201);
      const identity = h.gateway.identify(email);
      if (identity?.role !== 'member') throw new Error('member sign-in failed');
      const { token } = await h.gateway.createWebSession(identity);
      return { id: res.body.member.id as string, cookie: `gw_session=${token}` };
    },
    portal: (cookie, method, path) =>
      request(app)
        [method](`/api/me/launchpad${path}`)
        .set('cookie', cookie)
        .set('x-gateway-request', '1'),
    runner: (token, method, path) =>
      request(vmApp)[method](`/runner${path}`).set('authorization', `Bearer ${token}`),
  };
}

/** Lets queued work (pump, cleanup) settle. */
export async function settle(launchpad: Launchpad): Promise<void> {
  await launchpad.pump();
  await new Promise((resolve) => setImmediate(resolve));
}
