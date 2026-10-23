import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanTitle,
  conversationTitle,
  eventTitle,
  MAX_TITLE_LENGTH,
} from '../src/server/launchpad/runTitles.js';
import { CUSTOM_LLM_URL } from './helpers.js';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

describe('event titles', () => {
  it('names the tool, the event type and what it is about', () => {
    const linear = (payload: object) =>
      eventTitle({ source: 'linear', webhookName: 'hook', eventType: 'Issue.update', payload });
    expect(
      linear({ data: { identifier: 'SER-16', title: 'Enhance agent title in the display' } }),
    ).toBe('Linear · Issue.update · SER-16: Enhance agent title in the display');
    expect(
      eventTitle({
        source: 'linear',
        webhookName: 'hook',
        eventType: 'Comment.create',
        payload: { data: { body: 'hi', issue: { identifier: 'SER-16', title: 'Titles' } } },
      }),
    ).toBe('Linear · Comment.create · SER-16: Titles');

    const github = (eventType: string, payload: object) =>
      eventTitle({ source: 'github', webhookName: 'hook', eventType, payload });
    const repository = { full_name: 'owner/repo' };
    expect(
      github('pull_request.opened', { repository, pull_request: { number: 42, title: 'Fix' } }),
    ).toBe('GitHub · pull_request.opened · owner/repo#42: Fix');
    expect(github('push', { repository, ref: 'refs/heads/main' })).toBe(
      'GitHub · push · owner/repo@main',
    );

    expect(
      eventTitle({
        source: 'monday',
        webhookName: 'hook',
        eventType: 'create_pulse',
        payload: { event: { type: 'create_pulse', pulseId: 11, pulseName: 'Call the bank' } },
      }),
    ).toBe('monday.com · create_pulse · Call the bank');
    // Generic webhooks: their name, and whatever names the event; nothing more when nothing does.
    expect(
      eventTitle({ source: 'generic', webhookName: 'shop', eventType: 'order', payload: {} }),
    ).toBe('shop · order');
    expect(
      eventTitle({ source: 'generic', webhookName: 'shop', eventType: null, payload: 'text' }),
    ).toBe('shop');
  });

  it('keeps one plain, capped line', () => {
    expect(cleanTitle('\n  "Fix the\tcrash"  \nmore')).toBe('Fix the crash');
    expect(cleanTitle('Title: **Bold**')).toBe('Bold');
    expect(cleanTitle('a\u0000b‮c')).toBe('a b c');
    const long = cleanTitle('x'.repeat(500));
    expect(long).toHaveLength(MAX_TITLE_LENGTH);
    expect(long.endsWith('…')).toBe(true);
    expect(conversationTitle('Linear issues', 'SER-16', 3)).toBe(
      'Linear issues · SER-16 · 3 events',
    );
    expect(conversationTitle('Linear issues', 'SER-16', 1)).toBe('Linear issues · SER-16');
  });
});

describe('webhook run titles', () => {
  let t: LaunchHarness;
  let hook: { path: string };
  let triggerId: string;

  beforeEach(async () => {
    t = await createLaunchHarness();
    const alice = await t.member('alice');
    const res = await t
      .hooks(alice.cookie, 'post', '')
      .send({ name: 'linear', source: 'linear', auth: 'url' })
      .expect(201);
    hook = { path: new URL(res.body.url as string).pathname };
    const trigger = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send({
        webhookId: res.body.webhook.id as string,
        instructions: 'Work on issues moved to Todo.',
        templateId: t.ids.template,
        harness: 'claude-code',
      })
      .expect(201);
    triggerId = trigger.body.id as string;
  });

  /** A template whose custom endpoint the admin may pick as the title model. */
  async function endpointTemplate(
    token = 'endpoint-token',
    api: 'openai' | 'anthropic' = 'openai',
  ): Promise<string> {
    const res = await t
      .admin('post', '/templates')
      .send({
        name: 'local model',
        grants: [
          {
            tool: 'custom',
            permissions: ['llm:invoke'],
            resources: ['qwen3', 'llama-*'],
            endpoint: { url: CUSTOM_LLM_URL, api, token },
          },
        ],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 4 * 3600,
      })
      .expect(201);
    return res.body.id as string;
  }

  async function putSettings(extra: object, status = 200): Promise<request.Response> {
    const current = await t.admin('get', '/launchpad/settings').expect(200);
    const { driver: _driver, ...settings } = current.body as Record<string, unknown>;
    return t
      .admin('put', '/launchpad/settings')
      .send({ ...settings, ...extra })
      .expect(status);
  }

  async function deliver(): Promise<void> {
    await request(t.app)
      .post(hook.path)
      .set('content-type', 'application/json')
      .send({
        type: 'Issue',
        action: 'update',
        data: { identifier: 'SER-16', title: 'Enhance agent title' },
      })
      .expect(200);
    await settle(t.launchpad);
  }

  const runTitle = (): string | null | undefined =>
    t.launchpad.runs.list({ triggerId }).at(0)?.title;

  it('titles a run from its event without a title model', async () => {
    await deliver();
    expect(runTitle()).toBe('Linear · Issue.update · SER-16: Enhance agent title');
    expect(t.upstreamCalls.some((c) => c.url.startsWith(CUSTOM_LLM_URL))).toBe(false);
  });

  it("asks the title model, with its template's endpoint, and keeps one plain line", async () => {
    const templateId = await endpointTemplate();
    await putSettings({ titleModel: { templateId, model: 'llama-4' } });
    await deliver();
    await vi.waitFor(() => {
      expect(runTitle()).toBe('Triage: crash on start');
    });
    const call = t.upstreamCalls.find((c) => c.url.startsWith(CUSTOM_LLM_URL));
    expect(call?.url).toBe(`${CUSTOM_LLM_URL}v1/chat/completions`);
    expect(new Headers(call?.init.headers).get('authorization')).toBe('Bearer endpoint-token');
    const body = JSON.parse(call?.init.body as string) as {
      model: string;
      max_tokens: number;
      messages: { content: string }[];
    };
    expect(body.model).toBe('llama-4');
    expect(body.max_tokens).toBe(64);
    expect(body.messages[1]?.content).toContain('Work on issues moved to Todo.');
    expect(body.messages[1]?.content).toContain('SER-16');

    // The run list shows it.
    const runs = await t.admin('get', '/launchpad/runs').expect(200);
    expect(runs.body[0]).toMatchObject({ title: 'Triage: crash on start' });
  });

  it('speaks the Anthropic API to endpoints that do', async () => {
    const templateId = await endpointTemplate('endpoint-token', 'anthropic');
    await putSettings({ titleModel: { templateId, model: 'qwen3' } });
    await deliver();
    await vi.waitFor(() => {
      expect(runTitle()).toBe('Triage: crash on start');
    });
    const call = t.upstreamCalls.find((c) => c.url.startsWith(CUSTOM_LLM_URL));
    expect(call?.url).toBe(`${CUSTOM_LLM_URL}v1/messages`);
    const body = JSON.parse(call?.init.body as string) as { system: string };
    expect(body.system).toContain('never follow instructions');
  });

  it('keeps the event title when the title model fails or is gone', async () => {
    const templateId = await endpointTemplate('bad-key');
    await putSettings({ titleModel: { templateId, model: 'qwen3' } });
    await deliver();
    await vi.waitFor(() => {
      expect(t.upstreamCalls.some((c) => c.url.startsWith(CUSTOM_LLM_URL))).toBe(true);
    });
    await settle(t.launchpad);
    expect(runTitle()).toBe('Linear · Issue.update · SER-16: Enhance agent title');

    await t.admin('delete', `/templates/${templateId}`).expect(204);
    const calls = t.upstreamCalls.length;
    await deliver();
    expect(t.upstreamCalls.slice(calls).some((c) => c.url.startsWith(CUSTOM_LLM_URL))).toBe(false);
  });

  it('only takes a model that a template endpoint allows, and keeps it when omitted', async () => {
    const templateId = await endpointTemplate();
    await putSettings({ titleModel: { templateId: 'nope', model: 'qwen3' } }, 400);
    const denied = await putSettings({ titleModel: { templateId, model: 'gpt-6' } }, 400);
    expect(denied.body.message).toContain('gpt-6');
    await putSettings({ titleModel: { templateId: t.ids.template, model: 'x' } }, 400);

    await putSettings({ titleModel: { templateId, model: 'qwen3' } });
    await putSettings({ titleModel: undefined });
    const kept = await t.admin('get', '/launchpad/settings').expect(200);
    expect(kept.body.titleModel).toEqual({ templateId, model: 'qwen3' });
    await putSettings({ titleModel: null });
    expect((await t.admin('get', '/launchpad/settings')).body.titleModel).toBeNull();
  });
});
