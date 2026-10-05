import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

let t: LaunchHarness;

beforeEach(async () => {
  t = await createLaunchHarness();
});

const launchBody = (extra: object = {}) => ({
  prompt: 'Triage the open issues of o/r',
  templateId: t.ids.template,
  harness: 'claude-code',
  ...extra,
});

async function launch(cookie: string, extra: object = {}): Promise<string> {
  const res = await t.portal(cookie, 'post', '/runs').send(launchBody(extra)).expect(201);
  await settle(t.launchpad);
  return res.body.id as string;
}

const minutes = (n: number): void => {
  t.clock.now = new Date(t.clock.now.getTime() + n * 60_000);
};

describe('launch options', () => {
  it('lists the harnesses each template can run', async () => {
    const alice = await t.member('alice');
    const res = await t.portal(alice.cookie, 'get', '').expect(200);
    const byId = Object.fromEntries(
      (res.body.templates as { id: string; harnesses: { harness: string }[] }[]).map((x) => [
        x.id,
        x.harnesses.map((c) => c.harness),
      ]),
    );
    expect(byId[t.ids.template]).toEqual(['claude-code', 'pi']);
    expect(byId[t.ids.noLlmTemplate]).toEqual([]);
    expect(res.body.enabled).toBe(true);
  });
});

describe('a run, end to end', () => {
  it('boots a VM with a scoped key, takes reports and cleans up', async () => {
    const alice = await t.member('alice');
    const id = await launch(alice.cookie);

    const run = await t.portal(alice.cookie, 'get', `/runs/${id}`).expect(200);
    expect(run.body).toMatchObject({ status: 'running', vmId: 'vm-1', harness: 'claude-code' });
    // Template max TTL 4h - 5 min margin caps the 2h default: the default wins.
    expect(run.body.timeoutSeconds).toBe(7200);

    const config = t.driver.lastConfig();
    expect(config).toMatchObject({
      runId: id,
      gatewayUrl: 'http://172.30.0.1:7420',
      harness: 'claude-code',
      llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
      gatewayTools: ['gateway_github'],
    });
    expect(config.sessionKey).toMatch(/^gws_/);
    expect(config.runToken).toMatch(/^gwr_/);
    expect(config.systemPrompt).toContain('gateway_github');
    expect(config.systemPrompt).toContain('`o/r`');
    expect(JSON.stringify(run.body)).not.toContain(config.runToken);
    expect(JSON.stringify(run.body)).not.toContain(config.sessionKey);

    // The agent's key works on the VM listener, for its grants only.
    const vm = (path: string) =>
      request(t.vmApp).get(path).set('authorization', `Bearer ${config.sessionKey}`);
    await vm('/proxy/github/repos/o/r/issues').expect(200);
    await vm('/proxy/github/repos/o/other/issues').expect(403);
    const session = await vm('/api/session').expect(200);
    expect(session.body.tokenBudget).toBe(20_000_000);
    expect((session.body.grants as { kind: string }[]).map((g) => g.kind)).toEqual(['tool', 'llm']);

    // Runner reports
    await t
      .runner(config.runToken, 'post', '/events')
      .send({
        events: [
          { seq: 0, at: '2026-01-01T00:00:01Z', type: 'status', text: 'started' },
          {
            seq: 1,
            at: '2026-01-01T00:00:02Z',
            type: 'tool_call',
            text: 'gateway_github GET /repos/o/r/issues',
            tool: 'gateway_github',
            callId: 'c1',
            data: { token: 'gws_leakedkey123' },
          },
        ],
      })
      .expect(200);
    await t
      .runner(config.runToken, 'put', '/outputs/report/summary.md')
      .set('content-type', 'text/markdown')
      .send('# 3 issues')
      .expect(204);
    await t
      .runner(config.runToken, 'post', '/finish')
      .send({ outcome: 'succeeded', finalMessage: 'Labelled 3 issues', memory: null, error: null })
      .expect(200);

    const done = await t.portal(alice.cookie, 'get', `/runs/${id}`).expect(200);
    expect(done.body).toMatchObject({ status: 'succeeded', finalMessage: 'Labelled 3 issues' });
    expect(t.driver.destroyed).toEqual(['vm-1']);
    await vm('/proxy/github/repos/o/r/issues').expect(401);
    await t.runner(config.runToken, 'post', '/events').send({ events: [] }).expect(401);

    const events = await t.portal(alice.cookie, 'get', `/runs/${id}/events`).expect(200);
    expect(events.body).toHaveLength(2);
    expect(JSON.stringify(events.body)).not.toContain('leakedkey123');
    const after = await t.portal(alice.cookie, 'get', `/runs/${id}/events?after=0`).expect(200);
    expect(after.body).toHaveLength(1);

    const activity = await t.portal(alice.cookie, 'get', `/runs/${id}/activity`).expect(200);
    expect((activity.body as { decision?: string }[]).map((a) => a.decision)).toEqual(
      expect.arrayContaining(['allowed', 'denied']),
    );

    const outputs = await t.portal(alice.cookie, 'get', `/runs/${id}/outputs`).expect(200);
    expect(outputs.body).toEqual([
      expect.objectContaining({ path: 'report/summary.md', size: 10 }),
    ]);
    const file = await t
      .portal(alice.cookie, 'get', `/runs/${id}/outputs/report/summary.md`)
      .expect(200);
    expect(Buffer.from(file.body as Buffer).toString()).toBe('# 3 issues');
  });

  it('dedupes re-sent event batches and rejects bad output paths', async () => {
    const alice = await t.member('alice');
    await launch(alice.cookie);
    const { runToken } = t.driver.lastConfig();
    const batch = {
      events: [{ seq: 0, at: '2026-01-01T00:00:01Z', type: 'log', text: 'hi' }],
    };
    const first = await t.runner(runToken, 'post', '/events').send(batch).expect(200);
    const again = await t.runner(runToken, 'post', '/events').send(batch).expect(200);
    expect([first.body.stored, again.body.stored]).toEqual([1, 0]);
    await t.runner(runToken, 'put', '/outputs/..%2Fescape').send('x').expect(400);
    await t.runner(runToken, 'put', '/outputs/a/../b').send('x').expect(400);
    await t.runner('gwr_wrong', 'post', '/events').send(batch).expect(401);
  });
});

describe('launch checks', () => {
  it('needs a template with model access for the harness', async () => {
    const alice = await t.member('alice');
    const res = await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ templateId: t.ids.noLlmTemplate }))
      .expect(400);
    expect(res.body.message).toContain('anthropic');
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ harness: 'codex' }))
      .expect(400);
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ model: 'claude-opus-5-5' }))
      .expect(400);
  });

  it('only allows the member’s templates, and respects disabled launch rights', async () => {
    const bob = await t.member('bob', [t.ids.noLlmTemplate]);
    await t.portal(bob.cookie, 'post', '/runs').send(launchBody()).expect(403);
    const alice = await t.member('alice');
    await t
      .admin('put', `/launchpad/members/${alice.id}`)
      .send({ launchEnabled: false, maxConcurrent: null })
      .expect(200);
    await t.portal(alice.cookie, 'post', '/runs').send(launchBody()).expect(403);
  });
});

describe('isolation and control', () => {
  it('hides other members’ runs; the admin sees and stops everything', async () => {
    const alice = await t.member('alice');
    const bob = await t.member('bob');
    const id = await launch(alice.cookie);
    await t.portal(bob.cookie, 'get', `/runs/${id}`).expect(404);
    await t.portal(bob.cookie, 'post', `/runs/${id}/cancel`).expect(404);
    expect((await t.portal(bob.cookie, 'get', '/runs').expect(200)).body).toEqual([]);

    const all = await t.admin('get', '/launchpad/runs').expect(200);
    expect((all.body as { id: string }[]).map((r) => r.id)).toEqual([id]);
    const stopped = await t.admin('post', `/launchpad/runs/${id}/cancel`).expect(200);
    expect(stopped.body).toMatchObject({
      status: 'cancelled',
      statusReason: 'Stopped by the admin',
    });
    expect(t.driver.destroyed).toEqual(['vm-1']);
    await t.admin('post', `/launchpad/runs/${id}/cancel`).expect(409);
  });

  it('queues runs beyond the per-member limit and starts them as others finish', async () => {
    const alice = await t.member('alice');
    const ids = [
      await launch(alice.cookie),
      await launch(alice.cookie),
      await launch(alice.cookie),
    ];
    const status = async (id: string) =>
      (await t.portal(alice.cookie, 'get', `/runs/${id}`).expect(200)).body.status as string;
    expect(await Promise.all(ids.map(status))).toEqual(['running', 'running', 'queued']);
    await t.portal(alice.cookie, 'post', `/runs/${ids[0] ?? ''}/cancel`).expect(200);
    await settle(t.launchpad);
    expect(await status(ids[2] ?? '')).toBe('running');
  });

  it('fails a run whose VM does not boot, and revokes its key', async () => {
    const alice = await t.member('alice');
    t.driver.failNext = 'no KVM';
    const id = await launch(alice.cookie);
    const run = await t.portal(alice.cookie, 'get', `/runs/${id}`).expect(200);
    expect(run.body).toMatchObject({ status: 'failed', statusReason: 'no KVM' });
    const sessions = t.gateway.listSessions();
    expect(sessions.map((s) => s.status)).toEqual(['revoked']);
  });
});

describe('reaping', () => {
  it('fails runs whose VM died silently and destroys orphan VMs', async () => {
    const alice = await t.member('alice');
    const id = await launch(alice.cookie);
    const vm = t.driver.vms.get('vm-1');
    if (vm) vm.running = false;
    t.driver.vms.set('vm-orphan', { vmId: 'vm-orphan', runId: 'gone', running: true });
    await t.launchpad.reap();
    expect(t.launchpad.runs.require(id).status).toBe('running'); // within the report grace
    minutes(1);
    await t.launchpad.reap();
    expect(t.launchpad.runs.require(id)).toMatchObject({
      status: 'failed',
      statusReason: 'The VM stopped before the agent reported a result',
    });
    expect(t.driver.destroyed).toEqual(expect.arrayContaining(['vm-1', 'vm-orphan']));
  });

  it('times runs out after their deadline', async () => {
    const alice = await t.member('alice');
    const id = await launch(alice.cookie);
    minutes(120 + 1);
    await t.launchpad.reap();
    expect(t.launchpad.runs.require(id).status).toBe('running'); // kill grace
    minutes(2);
    await t.launchpad.reap();
    expect(t.launchpad.runs.require(id).status).toBe('timed_out');
  });

  it('fails runs left provisioning by a restart', async () => {
    const alice = await t.member('alice');
    const id = await launch(alice.cookie);
    t.launchpad.runs.update(id, { status: 'provisioning' });
    await t.launchpad.recover();
    expect(t.launchpad.runs.require(id)).toMatchObject({
      status: 'failed',
      statusReason: 'The gateway restarted while the run was starting',
    });
  });
});

describe('admin settings', () => {
  it('validates and applies settings', async () => {
    const current = (await t.admin('get', '/launchpad/settings').expect(200)).body;
    expect(current).toMatchObject({ defaultTimeoutSeconds: 7200, maxTimeoutSeconds: 14400 });
    const { driver: _driver, ...settings } = current as Record<string, unknown>;
    await t
      .admin('put', '/launchpad/settings')
      .send({ ...settings, defaultTimeoutSeconds: 20_000 })
      .expect(400);
    await t
      .admin('put', '/launchpad/settings')
      .send({ ...settings, defaultTimeoutSeconds: 1800 })
      .expect(200);
    const alice = await t.member('alice');
    const id = await launch(alice.cookie);
    expect(t.launchpad.runs.require(id).timeoutSeconds).toBe(1800);
  });
});

describe('reaping while a VM boots', () => {
  it('never destroys the VM of a run that is still starting', async () => {
    const alice = await t.member('alice');
    // The VM exists in the driver before the run knows its id.
    t.driver.vms.set('vm-booting', { vmId: 'vm-booting', runId: 'pending-run', running: true });
    const res = await t.portal(alice.cookie, 'post', '/runs').send(launchBody()).expect(201);
    t.driver.vms.set('vm-booting', {
      vmId: 'vm-booting',
      runId: res.body.id as string,
      running: true,
    });
    t.launchpad.runs.update(res.body.id as string, { status: 'provisioning', vmId: null });
    await t.launchpad.reap();
    expect(t.driver.destroyed).not.toContain('vm-booting');
  });
});
