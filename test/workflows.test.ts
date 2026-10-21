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
  it('runs a script with any template: its custom LLM endpoint, if any', async () => {
    const alice = await t.member('alice', [template, t.ids.template]);
    const res = await t.portal(alice.cookie, 'get', '').expect(200);
    const byId = Object.fromEntries(
      (res.body.templates as { id: string; workflow: unknown }[]).map((x) => [x.id, x.workflow]),
    );
    expect(byId[template]).toEqual({
      executor: { harness: 'script', provider: 'custom', models: ['qwen3'], modelRequired: true },
    });
    // No custom endpoint: the script has the tools only.
    expect(byId[t.ids.template]).toEqual({ executor: null });
  });

  it('offers every agent and model API of all the templates as planners', async () => {
    const alice = await t.member('alice', [template, t.ids.template, t.ids.noLlmTemplate]);
    const res = await t.portal(alice.cookie, 'get', '/planners').expect(200);
    const planners = res.body.planners as { harness: string; provider: string }[];
    expect(planners).toContainEqual({
      harness: 'claude-code',
      provider: 'anthropic',
      models: ['claude-sonnet-5', 'claude-opus-5'],
      modelRequired: false,
    });
    expect(planners).toContainEqual({
      harness: 'codex',
      provider: 'custom',
      // The allowlist's exact models, then those the endpoint lists.
      models: ['qwen3', 'llama-4'],
      modelRequired: true,
    });
    expect(planners.map((p) => `${p.harness}:${p.provider}`)).toEqual([
      'claude-code:anthropic',
      'pi:anthropic',
      'codex:custom',
    ]);
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
      plannerProvider: 'anthropic',
      executorModel: 'qwen3',
      steps: [
        {
          step: 'plan',
          templateName: null,
          provider: 'anthropic',
          harness: 'claude-code',
          run: { status: 'running', workflowId: id },
        },
        {
          step: 'execute',
          templateName: 'mail workflow',
          provider: 'custom',
          harness: 'script',
          model: 'qwen3',
          run: null,
        },
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

  it('plans on whichever template gives the model API: the script template needs none', async () => {
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

    const id = await start(alice.cookie, { templateId: mailOnly, plannerProvider: 'anthropic' });
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
      plannerProvider: 'anthropic',
      steps: [
        { step: 'plan', templateName: null, run: { templateId: t.ids.template } },
        { step: 'execute', templateName: 'mail only', run: null },
      ],
    });

    await finishLast('succeeded', { 'script.mjs': SCRIPT });
    const exec = t.driver.lastConfig();
    expect(exec).toMatchObject({ harness: 'script', llm: { provider: 'custom', model: 'qwen3' } });
    expect(await sessionTools(exec.sessionKey)).toEqual(['github', 'custom']);
    wf = await t.portal(alice.cookie, 'get', `/workflows/${id}`).expect(200);
    expect(wf.body.steps[1].run).toMatchObject({ templateId: mailOnly, harness: 'script' });

    // A planner on the custom endpoint: the template that gives it with that model.
    await start(alice.cookie, {
      templateId: t.ids.template,
      harness: 'pi',
      plannerProvider: 'custom',
      model: 'qwen3',
    });
    expect(t.driver.lastConfig()).toMatchObject({
      harness: 'pi',
      llm: { provider: 'custom', model: 'qwen3', api: 'openai' },
      gatewayTools: [],
    });
    expect(await sessionTools(t.driver.lastConfig().sessionKey)).toEqual(['custom']);
  });

  it('runs a script with no LLM when its template gives no custom endpoint', async () => {
    const alice = await t.member('alice', [template, t.ids.template]);
    const id = await start(alice.cookie, { templateId: t.ids.template });
    const plan = t.driver.lastConfig();
    expect(plan.systemPrompt).toContain('No LLM');
    expect(plan.systemPrompt).not.toContain('LLM_URL');
    expect(plan.systemPrompt).toContain('`$GATEWAY_URL/proxy/github`');

    await finishLast('succeeded', { 'script.mjs': SCRIPT });
    const exec = t.driver.lastConfig();
    expect(exec).toMatchObject({ harness: 'script', llm: null, gatewayTools: ['gateway_github'] });
    expect(await sessionTools(exec.sessionKey)).toEqual(['github']);
    const wf = await t.portal(alice.cookie, 'get', `/workflows/${id}`).expect(200);
    expect(wf.body).toMatchObject({
      executorModel: null,
      steps: [{}, { templateName: 'triage agents', provider: null, model: null }],
    });
  });

  it("refuses a planner none of the member's templates gives, and a template they don't have", async () => {
    const alice = await t.member('alice', [template, t.ids.noLlmTemplate]);
    const noGemini = await t
      .portal(alice.cookie, 'post', '/workflows')
      .send(workflowBody({ plannerProvider: 'gemini' }))
      .expect(400);
    expect(noGemini.body.message).toContain('gemini');
    const noModel = await t
      .portal(alice.cookie, 'post', '/workflows')
      .send(workflowBody({ model: 'claude-sonnet-5' }))
      .expect(400);
    expect(noModel.body.message).toContain('claude-sonnet-5');
    await t
      .portal(alice.cookie, 'post', '/workflows')
      .send(workflowBody({ templateId: t.ids.template }))
      .expect(403);
    const bob = await t.member('bob', [t.ids.noLlmTemplate]);
    const noPlanner = await t
      .portal(bob.cookie, 'post', '/workflows')
      .send(workflowBody({ templateId: t.ids.noLlmTemplate }))
      .expect(400);
    expect(noPlanner.body.message).toContain('None of your templates');
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
      .send(workflowBody({ templateId: t.ids.template, executorModel: 'qwen3' }))
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
    expect(t.driver.lastConfig().llm?.model).toBe('llama-4');
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

describe('workflow attachments', () => {
  const HOUR_MS = 3_600_000;

  async function upload(cookie: string, name: string, content: string): Promise<string> {
    const res = await t
      .portal(cookie, 'put', `/attachments/${name}`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from(content))
      .expect(201);
    return res.body.id as string;
  }

  const attachedNames = async (cookie: string, runId: string): Promise<string[]> => {
    const res = await t.portal(cookie, 'get', `/runs/${runId}/attachments`).expect(200);
    return (res.body as { name: string }[]).map((a) => a.name);
  };

  it('gives each step its own files: the planner learns only the names of the script’s', async () => {
    const alice = await t.member('alice', [template]);
    const spec = await upload(alice.cookie, 'spec.md', '# Spec');
    const mails = await upload(alice.cookie, 'mails.csv', 'from,subject\na@b.c,Invoice 42');
    const id = await start(alice.cookie, {
      planAttachmentIds: [spec],
      executeAttachmentIds: [mails],
    });

    const plan = t.driver.lastConfig();
    expect(plan.inputs).toEqual([{ path: 'spec.md', size: 6 }]);
    expect(plan.systemPrompt).toContain('## Input files');
    expect(plan.systemPrompt).toContain('`/home/agent/in/spec.md`');
    expect(plan.systemPrompt).toContain('`/home/agent/in/mails.csv` (29 bytes)');
    await t.runner(plan.runToken, 'get', '/inputs/mails.csv').expect(404);
    let wf = await t.portal(alice.cookie, 'get', `/workflows/${id}`).expect(200);
    expect(await attachedNames(alice.cookie, wf.body.steps[0].run.id as string)).toEqual([
      'spec.md',
    ]);
    // Held for the script: no longer waiting for a launch.
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send({ prompt: 'x', templateId: template, harness: 'claude-code', attachmentIds: [mails] })
      .expect(400);
    await t.portal(alice.cookie, 'delete', `/attachments/${mails}`).expect(404);

    await finishLast('succeeded', { 'script.mjs': SCRIPT });
    const exec = t.driver.lastConfig();
    expect(exec).toMatchObject({ harness: 'script', inputs: [{ path: 'mails.csv', size: 29 }] });
    const file = await t.runner(exec.runToken, 'get', '/inputs/mails.csv').expect(200);
    expect(Buffer.from(file.body as Buffer).toString()).toBe('from,subject\na@b.c,Invoice 42');
    wf = await t.portal(alice.cookie, 'get', `/workflows/${id}`).expect(200);
    expect(await attachedNames(alice.cookie, wf.body.steps[1].run.id as string)).toEqual([
      'mails.csv',
    ]);
  });

  it('refuses a file attached to both steps, or not the member’s own', async () => {
    const alice = await t.member('alice', [template]);
    const bob = await t.member('bob', [template]);
    const spec = await upload(alice.cookie, 'spec.md', '# Spec');
    const both = await t
      .portal(alice.cookie, 'post', '/workflows')
      .send(workflowBody({ planAttachmentIds: [spec], executeAttachmentIds: [spec] }))
      .expect(400);
    expect(both.body.message).toContain('one step only');
    await t
      .portal(bob.cookie, 'post', '/workflows')
      .send(workflowBody({ executeAttachmentIds: [spec] }))
      .expect(400);
    expect(t.driver.specs).toHaveLength(0);
  });

  it('deletes the script’s files when its step is never launched, after the retention', async () => {
    const alice = await t.member('alice', [template]);
    const mails = await upload(alice.cookie, 'mails.csv', 'a,b');
    await start(alice.cookie, { executeAttachmentIds: [mails] });
    await finishLast('failed');
    const held = () => t.launchpad.attachments.held(t.launchpad.runs.workflows()[0]?.id ?? '');

    // Kept past the day unlaunched files get, as long as the plan's output files are.
    t.clock.now = new Date(t.clock.now.getTime() + 25 * HOUR_MS);
    await t.launchpad.reap();
    expect(held()).toHaveLength(1);

    const days = t.launchpad.runs.settings().outputRetentionDays;
    t.clock.now = new Date(t.clock.now.getTime() + days * 24 * HOUR_MS);
    await t.launchpad.reap();
    expect(held()).toEqual([]);
  });
});
