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

/** Ends the latest run, so the next launch boots a VM rather than queueing. */
async function finishLast(): Promise<void> {
  await t
    .runner(t.driver.lastConfig().runToken, 'post', '/finish')
    .send({ outcome: 'succeeded', finalMessage: null, memory: null, error: null })
    .expect(200);
  await settle(t.launchpad);
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
    // How to call the tools, with an example and a plain HTTP fallback, for weaker models.
    expect(config.systemPrompt).toContain('Example arguments: `{"method":"GET","path":"/user"}`');
    expect(config.systemPrompt).toContain('$GATEWAY_URL/proxy/github');
    expect(config.systemPrompt).toContain('mcp__gateway__gateway_github');
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

  it('binds only the model API the harness uses', async () => {
    // A template for several harnesses: Anthropic and OpenAI, but no OpenAI account.
    const both = await t
      .admin('post', '/templates')
      .send({
        name: 'any harness',
        grants: [
          { tool: 'github', permissions: ['issues:read'], resources: ['o/r'] },
          { tool: 'anthropic', permissions: ['llm:invoke'], resources: [] },
          { tool: 'openai', permissions: ['llm:invoke'], resources: [] },
        ],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 4 * 3600,
      })
      .expect(201);
    const alice = await t.member('alice', [both.body.id as string]);
    const templateId = both.body.id as string;
    const tools = async (harness: string) => {
      await launch(alice.cookie, { templateId, harness });
      const session = await request(t.vmApp)
        .get('/api/session')
        .set('authorization', `Bearer ${t.driver.lastConfig().sessionKey}`)
        .expect(200);
      return (session.body.grants as { tool: string }[]).map((g) => g.tool);
    };
    expect(await tools('claude-code')).toEqual(['github', 'anthropic']);
    expect(await tools('pi')).toEqual(['github', 'anthropic']);
    const codex = await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ templateId, harness: 'codex' }))
      .expect(400);
    expect(codex.body.message).toBe('No openai account available');
  });

  it('runs agents on a custom LLM endpoint whose chat API they speak', async () => {
    const customTemplate = async (api: string, models: string[] = []) => {
      const res = await t
        .admin('post', '/templates')
        .send({
          name: `custom ${api}`,
          grants: [
            { tool: 'github', permissions: ['issues:read'], resources: ['o/r'] },
            {
              tool: 'custom',
              permissions: ['llm:invoke'],
              resources: models,
              endpoint: { url: 'https://llm.example.com', api, token: 'endpoint-token' },
            },
          ],
          defaultTtlSeconds: 3600,
          maxTtlSeconds: 4 * 3600,
        })
        .expect(201);
      return res.body.id as string;
    };
    const anthropicApi = await customTemplate('anthropic');
    const openaiApi = await customTemplate('openai', ['qwen3', 'llama-*']);
    const alice = await t.member('alice', [anthropicApi, openaiApi]);

    const options = await t.portal(alice.cookie, 'get', '').expect(200);
    const choices = Object.fromEntries(
      (options.body.templates as { id: string; harnesses: object[] }[]).map((x) => [
        x.id,
        x.harnesses,
      ]),
    );
    expect(choices[anthropicApi]).toEqual([
      { harness: 'claude-code', provider: 'custom', models: [], modelRequired: true },
      { harness: 'pi', provider: 'custom', models: [], modelRequired: true },
    ]);
    expect(choices[openaiApi]).toEqual([
      { harness: 'codex', provider: 'custom', models: ['qwen3'], modelRequired: true },
      { harness: 'pi', provider: 'custom', models: ['qwen3'], modelRequired: true },
    ]);

    // No default model on a custom endpoint: the launch names one, unless the template does.
    const unnamed = await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ templateId: anthropicApi }))
      .expect(400);
    expect(unnamed.body.message).toContain('name the model');
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ templateId: anthropicApi, harness: 'codex', model: 'qwen3' }))
      .expect(400);

    await launch(alice.cookie, { templateId: anthropicApi, model: 'qwen3' });
    const config = t.driver.lastConfig();
    expect(config.llm).toEqual({ provider: 'custom', model: 'qwen3', api: 'anthropic' });
    expect(JSON.stringify(t.driver.specs.at(-1))).not.toContain('endpoint-token');
    const session = await request(t.vmApp)
      .get('/api/session')
      .set('authorization', `Bearer ${config.sessionKey}`)
      .expect(200);
    expect((session.body.grants as { tool: string }[]).map((g) => g.tool)).toEqual([
      'github',
      'custom',
    ]);
    await finishLast();

    await launch(alice.cookie, { templateId: openaiApi, harness: 'codex' });
    expect(t.driver.lastConfig().llm).toEqual({
      provider: 'custom',
      model: 'qwen3',
      api: 'openai',
    });
    await launch(alice.cookie, { templateId: openaiApi, harness: 'pi', model: 'llama-4' });
    expect(t.driver.lastConfig().llm).toEqual({
      provider: 'custom',
      model: 'llama-4',
      api: 'openai',
    });
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ templateId: openaiApi, harness: 'pi', model: 'gpt-6' }))
      .expect(400);
  });

  it('proposes the models a custom LLM endpoint serves, within the template’s allowlist', async () => {
    const customTemplate = async (api: string, models: string[]) => {
      const res = await t
        .admin('post', '/templates')
        .send({
          name: `custom ${api}`,
          grants: [
            {
              tool: 'custom',
              permissions: ['llm:invoke'],
              resources: models,
              endpoint: { url: 'https://llm.example.com/', api, token: 'endpoint-token' },
            },
          ],
          defaultTtlSeconds: 3600,
          maxTtlSeconds: 4 * 3600,
        })
        .expect(201);
      return res.body.id as string;
    };
    const anyModel = await customTemplate('anthropic', []);
    const someModels = await customTemplate('openai', ['qwen*', 'llama-4']);
    const alice = await t.member('alice', [anyModel, someModels, t.ids.template]);

    const all = await t.portal(alice.cookie, 'get', `/templates/${anyModel}/models`).expect(200);
    expect(all.body).toEqual({ models: ['qwen3', 'llama-4', 'gpt-6'] });
    const call = t.upstreamCalls.at(-1);
    expect(call?.url).toBe('https://llm.example.com/v1/models?limit=1000');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer endpoint-token');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');

    const some = await t.portal(alice.cookie, 'get', `/templates/${someModels}/models`).expect(200);
    expect(some.body).toEqual({ models: ['qwen3', 'llama-4'] });
    expect(t.upstreamCalls.at(-1)?.url).toBe('https://llm.example.com/v1/models');

    await t.portal(alice.cookie, 'get', `/templates/${t.ids.template}/models`).expect(400);
    const bob = await t.member('bob', [t.ids.template]);
    await t.portal(bob.cookie, 'get', `/templates/${anyModel}/models`).expect(403);
    await t
      .admin('put', `/launchpad/members/${alice.id}`)
      .send({ launchEnabled: false, maxConcurrent: null })
      .expect(200);
    await t.portal(alice.cookie, 'get', `/templates/${anyModel}/models`).expect(403);
  });

  it('reports a custom LLM endpoint whose model list can’t be read', async () => {
    const tpl = await t
      .admin('post', '/templates')
      .send({
        name: 'bad endpoint',
        grants: [
          {
            tool: 'custom',
            permissions: ['llm:invoke'],
            resources: [],
            endpoint: { url: 'https://llm.example.com', api: 'openai', token: 'bad-key' },
          },
        ],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 4 * 3600,
      })
      .expect(201);
    const alice = await t.member('alice', [tpl.body.id as string]);
    const res = await t
      .portal(alice.cookie, 'get', `/templates/${tpl.body.id as string}/models`)
      .expect(502);
    expect(res.body.message).toBe(
      'The custom LLM endpoint answered HTTP 401 when listing its models',
    );
  });

  it('leaves custom endpoints the harness can’t talk to out of the run’s key', async () => {
    const tpl = await t
      .admin('post', '/templates')
      .send({
        name: 'anthropic + openai-style endpoint',
        grants: [
          { tool: 'anthropic', permissions: ['llm:invoke'], resources: [] },
          {
            tool: 'custom',
            permissions: ['llm:invoke'],
            resources: [],
            endpoint: { url: 'https://llm.example.com', api: 'openai' },
          },
        ],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 4 * 3600,
      })
      .expect(201);
    const templateId = tpl.body.id as string;
    const alice = await t.member('alice', [templateId]);
    const tools = async (harness: string, model?: string) => {
      await launch(alice.cookie, { templateId, harness, ...(model && { model }) });
      const config = t.driver.lastConfig();
      const session = await request(t.vmApp)
        .get('/api/session')
        .set('authorization', `Bearer ${config.sessionKey}`)
        .expect(200);
      await finishLast();
      return [config.llm.provider, (session.body.grants as { tool: string }[]).map((g) => g.tool)];
    };
    expect(await tools('claude-code')).toEqual(['anthropic', ['anthropic']]);
    expect(await tools('codex', 'qwen3')).toEqual(['custom', ['custom']]);
    // pi prefers the official API it has an account for; the endpoint stays usable.
    expect(await tools('pi')).toEqual(['anthropic', ['anthropic', 'custom']]);
  });

  it('runs on the custom LLM endpoint when the launch picks it over the official API', async () => {
    const tpl = await t
      .admin('post', '/templates')
      .send({
        name: 'anthropic + local model',
        grants: [
          { tool: 'anthropic', permissions: ['llm:invoke'], resources: ['claude-sonnet-5'] },
          {
            tool: 'custom',
            permissions: ['llm:invoke'],
            resources: [],
            endpoint: { url: 'https://llm.example.com', api: 'anthropic' },
          },
        ],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 4 * 3600,
      })
      .expect(201);
    const templateId = tpl.body.id as string;
    const alice = await t.member('alice', [templateId]);

    // Both model APIs are offered, the official one first (the default).
    const options = await t.portal(alice.cookie, 'get', '').expect(200);
    const offered = (options.body.templates as { harnesses: object[] }[])[0]?.harnesses;
    expect(offered).toEqual([
      {
        harness: 'claude-code',
        provider: 'anthropic',
        models: ['claude-sonnet-5'],
        modelRequired: false,
      },
      { harness: 'claude-code', provider: 'custom', models: [], modelRequired: true },
      { harness: 'pi', provider: 'anthropic', models: ['claude-sonnet-5'], modelRequired: false },
      { harness: 'pi', provider: 'custom', models: [], modelRequired: true },
    ]);
    const models = await t.portal(alice.cookie, 'get', `/templates/${templateId}/models`);
    expect(models.body).toEqual({ models: ['qwen3', 'llama-4', 'gpt-6'] });

    const run = async (extra: object) => {
      const id = await launch(alice.cookie, { templateId, ...extra });
      const config = t.driver.lastConfig();
      const session = await request(t.vmApp)
        .get('/api/session')
        .set('authorization', `Bearer ${config.sessionKey}`)
        .expect(200);
      await finishLast();
      const tools = (session.body.grants as { tool: string }[]).map((g) => g.tool);
      return { id, llm: config.llm, tools };
    };
    // No API picked: the official one, the endpoint staying usable (as before).
    expect(await run({})).toMatchObject({
      llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
      tools: ['anthropic', 'custom'],
    });
    const local = await run({ provider: 'custom', model: 'qwen3' });
    expect(local).toMatchObject({
      llm: { provider: 'custom', model: 'qwen3', api: 'anthropic' },
      tools: ['custom'],
    });
    const stored = await t.portal(alice.cookie, 'get', `/runs/${local.id}`).expect(200);
    expect(stored.body).toMatchObject({ provider: 'custom', model: 'qwen3' });
    expect(await run({ harness: 'pi', provider: 'anthropic' })).toMatchObject({
      llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
      tools: ['anthropic'],
    });

    // The model is checked against the picked API's allowlist, and the API must be granted.
    const send = (extra: object) =>
      t.portal(alice.cookie, 'post', '/runs').send(launchBody({ templateId, ...extra }));
    expect((await send({ provider: 'custom' }).expect(400)).body.message).toContain(
      'name the model',
    );
    await send({ provider: 'anthropic', model: 'qwen3' }).expect(400);
    const openai = await send({ provider: 'openai' }).expect(400);
    expect(openai.body.message).toBe(
      'Template "anthropic + local model" gives no openai access claude-code can use',
    );
  });

  it('gives the run its template’s internet access', async () => {
    const tpl = await t
      .admin('post', '/templates')
      .send({
        name: 'with npm',
        grants: [{ tool: 'anthropic', permissions: ['llm:invoke'], resources: [] }],
        egressDomains: ['registry.npmjs.org'],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 4 * 3600,
      })
      .expect(201);
    const alice = await t.member('alice', [tpl.body.id as string, t.ids.template]);
    await launch(alice.cookie, { templateId: tpl.body.id });
    const config = t.driver.lastConfig();
    expect(config.egressDomains).toEqual(['registry.npmjs.org']);
    expect(config.systemPrompt).toContain('`registry.npmjs.org`');
    expect(config.systemPrompt).not.toContain('has no internet access');

    await launch(alice.cookie);
    expect(t.driver.lastConfig().egressDomains).toEqual([]);
    expect(t.driver.lastConfig().systemPrompt).toContain('has no internet access');
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
