import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

let t: LaunchHarness;
let template: string;

const SCRIPT = "console.log('Read 3 mails');\nconsole.log('Done: 1 reply drafted');\n";

beforeEach(async () => {
  t = await createLaunchHarness();
  const res = await t
    .admin('post', '/templates')
    .send({
      name: 'mail workflow',
      grants: [
        { tool: 'github', permissions: ['issues:read'], resources: ['o/r'] },
        { tool: 'anthropic', permissions: ['llm:invoke'], resources: ['claude-opus-5'] },
        {
          tool: 'custom',
          permissions: ['llm:invoke'],
          resources: ['qwen3', 'llama-*'],
          endpoint: { url: 'https://llm.example.com', api: 'openai', token: 'endpoint-token' },
        },
      ],
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 4 * 3600,
    })
    .expect(201);
  template = res.body.id as string;
});

const workflowBody = (extra: object = {}) => ({
  prompt: 'Draft replies to the unread mails about invoices',
  templateId: template,
  harness: 'claude-code',
  ...extra,
});

async function start(cookie: string, extra: object = {}): Promise<string> {
  const res = await t.portal(cookie, 'post', '/workflows').send(workflowBody(extra)).expect(201);
  await settle(t.launchpad);
  return res.body.id as string;
}

/** Reports the latest VM's run as finished, after uploading these output files. */
async function finishLast(
  outcome: 'succeeded' | 'failed',
  files: Record<string, string> = {},
): Promise<void> {
  const { runToken } = t.driver.lastConfig();
  for (const [path, content] of Object.entries(files)) {
    await t.runner(runToken, 'put', `/outputs/${path}`).send(content).expect(204);
  }
  await t
    .runner(runToken, 'post', '/finish')
    .send({ outcome, finalMessage: 'done', memory: null, error: null })
    .expect(200);
  await settle(t.launchpad);
}

const sessionTools = async (key: string): Promise<string[]> => {
  const res = await request(t.vmApp)
    .get('/api/session')
    .set('authorization', `Bearer ${key}`)
    .expect(200);
  return (res.body.grants as { tool: string }[]).map((g) => g.tool);
};

describe('workflow launch options', () => {
  it('offers a workflow for templates with a custom LLM endpoint', async () => {
    const alice = await t.member('alice', [template, t.ids.template]);
    const res = await t.portal(alice.cookie, 'get', '').expect(200);
    const byId = Object.fromEntries(
      (res.body.templates as { id: string; workflow: unknown }[]).map((x) => [x.id, x.workflow]),
    );
    expect(byId[template]).toEqual({
      executor: { harness: 'script', provider: 'custom', models: ['qwen3'], modelRequired: true },
    });
    // No custom endpoint: no workflow.
    expect(byId[t.ids.template]).toBeNull();
  });
});

describe('a workflow, end to end', () => {
  it('plans without tools, then runs the script on the custom endpoint and the tools', async () => {
    const alice = await t.member('alice', [template]);
    const id = await start(alice.cookie);

    // Step 1: the frontier agent, with its model API only.
    const plan = t.driver.lastConfig();
    expect(plan).toMatchObject({
      harness: 'claude-code',
      llm: { provider: 'anthropic', model: 'claude-opus-5' },
      gatewayTools: [],
      prompt: 'Draft replies to the unread mails about invoices',
    });
    expect(await sessionTools(plan.sessionKey)).toEqual(['anthropic']);
    expect(plan.systemPrompt).toContain('/home/agent/out/script.mjs');
    expect(plan.systemPrompt).toContain('`$GATEWAY_URL/proxy/github`');
    expect(plan.systemPrompt).toContain('Issues (read)');
    expect(plan.systemPrompt).toContain('`o/r`');
    expect(plan.systemPrompt).toContain('/v1/chat/completions');
    expect(plan.systemPrompt).toContain('`qwen3`');
    expect(plan.systemPrompt).not.toContain('endpoint-token');
    await request(t.vmApp)
      .get('/proxy/github/repos/o/r/issues')
      .set('authorization', `Bearer ${plan.sessionKey}`)
      .expect(403);

    let wf = await t.portal(alice.cookie, 'get', `/workflows/${id}`).expect(200);
    expect(wf.body).toMatchObject({
      status: 'running',
      plannerHarness: 'claude-code',
      executorModel: 'qwen3',
      steps: [
        { step: 'plan', harness: 'claude-code', run: { status: 'running', workflowId: id } },
        { step: 'execute', harness: 'script', model: 'qwen3', run: null },
      ],
    });

    // Step 2: the script, with the custom endpoint and the tools but not the frontier model.
    await finishLast('succeeded', { 'script.mjs': SCRIPT });
    const exec = t.driver.lastConfig();
    expect(exec).toMatchObject({
      harness: 'script',
      prompt: SCRIPT,
      systemPrompt: '',
      llm: { provider: 'custom', model: 'qwen3', api: 'openai' },
      gatewayTools: ['gateway_github'],
    });
    expect(await sessionTools(exec.sessionKey)).toEqual(['github', 'custom']);
    await request(t.vmApp)
      .get('/proxy/github/repos/o/r/issues')
      .set('authorization', `Bearer ${exec.sessionKey}`)
      .expect(200);

    wf = await t.portal(alice.cookie, 'get', `/workflows/${id}`).expect(200);
    expect(wf.body.steps[0].run.status).toBe('succeeded');
    expect(wf.body.steps[1].run).toMatchObject({ status: 'running', harness: 'script' });
    expect(wf.body.status).toBe('running');

    await finishLast('succeeded');
    wf = await t.portal(alice.cookie, 'get', `/workflows/${id}`).expect(200);
    expect(wf.body.status).toBe('succeeded');
    const list = await t.portal(alice.cookie, 'get', '/workflows').expect(200);
    expect((list.body as { id: string }[]).map((w) => w.id)).toEqual([id]);
    const runs = await t.portal(alice.cookie, 'get', `/runs?harness=script`).expect(200);
    expect(runs.body).toHaveLength(1);
  });

  it('plans with an agent of another template: the workflow template needs no model API', async () => {
    const res = await t
      .admin('post', '/templates')
      .send({
        name: 'mail only',
        grants: [
          { tool: 'github', permissions: ['issues:read'], resources: ['o/r'] },
          {
            tool: 'custom',
            permissions: ['llm:invoke'],
            resources: ['qwen3'],
            endpoint: { url: 'https://llm.example.com', api: 'openai', token: 'endpoint-token' },
          },
        ],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 4 * 3600,
      })
      .expect(201);
    const mailOnly = res.body.id as string;
    const alice = await t.member('alice', [mailOnly, t.ids.template]);
    const options = await t.portal(alice.cookie, 'get', '').expect(200);
    const offered = (options.body.templates as { id: string; workflow: unknown }[]).find(
      (x) => x.id === mailOnly,
    );
    expect(offered?.workflow).toMatchObject({ executor: { harness: 'script' } });

    const id = await start(alice.cookie, {
      templateId: mailOnly,
      plannerTemplateId: t.ids.template,
    });
    const plan = t.driver.lastConfig();
    expect(plan).toMatchObject({
      harness: 'claude-code',
      llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
      gatewayTools: [],
    });
    expect(await sessionTools(plan.sessionKey)).toEqual(['anthropic']);
    expect(plan.systemPrompt).toContain('`$GATEWAY_URL/proxy/github`');
    expect(plan.systemPrompt).toContain('`qwen3`');

    let wf = await t.portal(alice.cookie, 'get', `/workflows/${id}`).expect(200);
    expect(wf.body).toMatchObject({
      templateId: mailOnly,
      templateName: 'mail only',
      plannerTemplateId: t.ids.template,
      plannerTemplateName: 'triage agents',
      steps: [
        { step: 'plan', templateName: 'triage agents', run: { templateId: t.ids.template } },
        { step: 'execute', templateName: 'mail only', run: null },
      ],
    });

    await finishLast('succeeded', { 'script.mjs': SCRIPT });
    const exec = t.driver.lastConfig();
    expect(exec).toMatchObject({ harness: 'script', llm: { provider: 'custom', model: 'qwen3' } });
    expect(await sessionTools(exec.sessionKey)).toEqual(['github', 'custom']);
    wf = await t.portal(alice.cookie, 'get', `/workflows/${id}`).expect(200);
    expect(wf.body.steps[1].run).toMatchObject({ templateId: mailOnly, harness: 'script' });
  });

  it("refuses a planner on a template the member doesn't have, or that runs no agent", async () => {
    const alice = await t.member('alice', [template, t.ids.noLlmTemplate]);
    await t
      .portal(alice.cookie, 'post', '/workflows')
      .send(workflowBody({ plannerTemplateId: t.ids.template }))
      .expect(403);
    const noModel = await t
      .portal(alice.cookie, 'post', '/workflows')
      .send(workflowBody({ plannerTemplateId: t.ids.noLlmTemplate }))
      .expect(400);
    expect(noModel.body.message).toContain('anthropic');
    expect(t.driver.specs).toHaveLength(0);
  });

  it('fails when the planner wrote no script, and stops after a failed plan', async () => {
    const alice = await t.member('alice', [template]);
    const empty = await start(alice.cookie);
    await finishLast('succeeded', { 'notes.md': 'no script' });
    const wf = await t.portal(alice.cookie, 'get', `/workflows/${empty}`).expect(200);
    expect(wf.body).toMatchObject({ status: 'failed', steps: [{}, { run: null }] });
    expect(wf.body.statusReason).toContain('wrote no script');
    expect(t.driver.specs).toHaveLength(1);

    const failed = await start(alice.cookie);
    await finishLast('failed', { 'script.mjs': SCRIPT });
    const after = await t.portal(alice.cookie, 'get', `/workflows/${failed}`).expect(200);
    expect(after.body).toMatchObject({ status: 'failed', steps: [{}, { run: null }] });
    expect(t.driver.specs).toHaveLength(2);
  });

  it('checks both steps at launch', async () => {
    const alice = await t.member('alice', [template, t.ids.template]);
    const noEndpoint = await t
      .portal(alice.cookie, 'post', '/workflows')
      .send(workflowBody({ templateId: t.ids.template }))
      .expect(400);
    expect(noEndpoint.body.message).toContain('custom LLM endpoint');
    await t
      .portal(alice.cookie, 'post', '/workflows')
      .send(workflowBody({ executorModel: 'gpt-6' }))
      .expect(400);
    await t
      .portal(alice.cookie, 'post', '/workflows')
      .send(workflowBody({ harness: 'gemini' }))
      .expect(400);
    const id = await start(alice.cookie, { executorModel: 'llama-4' });
    await finishLast('succeeded', { 'script.mjs': SCRIPT });
    expect(t.driver.lastConfig().llm.model).toBe('llama-4');
    expect(id).toBeTruthy();
  });

  it('is stopped as a whole, hidden from other members and visible to the admin', async () => {
    const alice = await t.member('alice', [template]);
    const bob = await t.member('bob', [template]);
    const id = await start(alice.cookie);
    await t.portal(bob.cookie, 'get', `/workflows/${id}`).expect(404);
    await t.portal(bob.cookie, 'post', `/workflows/${id}/cancel`).expect(404);
    const admin = await t.admin('get', '/launchpad/workflows').expect(200);
    expect((admin.body as { id: string }[]).map((w) => w.id)).toEqual([id]);

    const stopped = await t.portal(alice.cookie, 'post', `/workflows/${id}/cancel`).expect(200);
    expect(stopped.body.status).toBe('cancelled');
    await settle(t.launchpad);
    expect(t.driver.specs).toHaveLength(1);
    await t.portal(alice.cookie, 'post', `/workflows/${id}/cancel`).expect(409);
  });
});
