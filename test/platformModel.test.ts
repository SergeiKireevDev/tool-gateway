import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanLabels, cleanTitle } from '../src/server/launchpad/platformModel.js';
import {
  createLaunchHarness,
  type LaunchHarness,
  PLATFORM_LLM_URL,
  settle,
} from './launchpadHelpers.js';

const TOKEN = 'platform-secret-token';

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

let t: LaunchHarness;
let calls: Call[];
/** What the fake platform model answers, given the request's user message. */
let answer: (user: string) => string;
let failing: boolean;

/** The user message of a request, for both chat APIs. */
function userText(body: Record<string, unknown>): string {
  const messages = body.messages as { role: string; content: string }[];
  return messages.find((m) => m.role === 'user')?.content ?? '';
}

const platformFetch: typeof fetch = (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input);
  const body = JSON.parse(init.body as string) as Record<string, unknown>;
  calls.push({ url, headers: new Headers(init.headers), body });
  if (failing) return Promise.resolve(new Response('overloaded', { status: 503 }));
  const text = answer(userText(body));
  return Promise.resolve(
    url.endsWith('/v1/messages')
      ? Response.json({ content: [{ type: 'text', text }] })
      : Response.json({ choices: [{ message: { role: 'assistant', content: text } }] }),
  );
};

beforeEach(async () => {
  calls = [];
  failing = false;
  answer = () => 'Summarize the login crash reports';
  t = await createLaunchHarness(platformFetch);
});

const configure = (extra: object = {}) =>
  t
    .admin('put', '/launchpad/platform-model')
    .send({ url: `${PLATFORM_LLM_URL}/v1`, api: 'openai', model: 'qwen3:8b', ...extra });

async function launch(cookie: string, prompt = 'Find the login crash reports'): Promise<string> {
  const res = await t
    .portal(cookie, 'post', '/runs')
    .send({ prompt, templateId: t.ids.template, harness: 'claude-code' })
    .expect(201);
  await settle(t.launchpad);
  return res.body.id as string;
}

describe('platform model settings', () => {
  it('is off until the admin sets it, and never returns its token', async () => {
    const empty = await t.admin('get', '/launchpad/platform-model').expect(200);
    expect(empty.body).toEqual({ platformModel: null });

    const saved = await configure({ token: TOKEN }).expect(200);
    expect(saved.body.platformModel).toEqual({
      url: `${PLATFORM_LLM_URL}/v1`,
      api: 'openai',
      model: 'qwen3:8b',
      hasToken: true,
    });
    const read = await t.admin('get', '/launchpad/platform-model').expect(200);
    expect(JSON.stringify(read.body)).not.toContain(TOKEN);
    expect(t.db.sql.prepare('SELECT sealed FROM platform_model').get()).not.toMatchObject({
      sealed: expect.stringContaining(TOKEN) as unknown,
    });

    // No token keeps the current one; '' removes it.
    const kept = await configure({ model: 'llama3' }).expect(200);
    expect(kept.body.platformModel).toMatchObject({ model: 'llama3', hasToken: true });
    const removed = await configure({ token: '' }).expect(200);
    expect(removed.body.platformModel.hasToken).toBe(false);

    await t.admin('delete', '/launchpad/platform-model').expect(200);
    expect((await t.admin('get', '/launchpad/platform-model')).body.platformModel).toBeNull();
  });

  it('checks the endpoint URL and is the admin’s only', async () => {
    await configure({ url: 'ftp://llm.example' }).expect(400);
    await configure({ url: 'https://user:pw@llm.example' }).expect(400);
    await configure({ model: '' }).expect(400);
    const alice = await t.member('alice');
    const denied = await request(t.app)
      .put('/api/admin/launchpad/platform-model')
      .set('cookie', alice.cookie)
      .send({ url: PLATFORM_LLM_URL, api: 'openai', model: 'x' });
    expect(denied.status).toBe(401);
  });

  it('can be tried on a sample task', async () => {
    await t.admin('post', '/launchpad/platform-model/test').expect(400);
    await configure({ token: TOKEN }).expect(200);
    const tried = await t.admin('post', '/launchpad/platform-model/test').expect(200);
    expect(tried.body).toEqual({ title: 'Summarize the login crash reports' });
    expect(calls[0]?.url).toBe(`${PLATFORM_LLM_URL}/v1/chat/completions`);
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.body).toMatchObject({ model: 'qwen3:8b' });

    failing = true;
    const failed = await t.admin('post', '/launchpad/platform-model/test').expect(502);
    expect(failed.body.message).toContain('HTTP 503');
  });
});

describe('run titles', () => {
  it('leaves runs untitled without a platform model', async () => {
    const alice = await t.member('alice');
    const id = await launch(alice.cookie);
    const run = await t.portal(alice.cookie, 'get', `/runs/${id}`).expect(200);
    expect(run.body.title).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('names each new run from its task', async () => {
    await configure().expect(200);
    const alice = await t.member('alice');
    answer = () => '<think>The user wants crash reports.</think>\n"Find login crash reports."';
    const id = await launch(alice.cookie, 'Find the login crash reports in o/r');
    const run = await t.portal(alice.cookie, 'get', `/runs/${id}`).expect(200);
    expect(run.body.title).toBe('Find login crash reports');
    expect(userText(calls[0]?.body ?? {})).toContain('Find the login crash reports in o/r');
    const listed = await t.portal(alice.cookie, 'get', '/runs').expect(200);
    expect(listed.body[0].title).toBe('Find login crash reports');
  });

  it('names a webhook-triggered run from its instructions and event', async () => {
    await configure({ api: 'anthropic' }).expect(200);
    answer = () => 'Issue ENG-12 moved to Todo: Fix login crash';
    const alice = await t.member('alice');
    const hook = await t
      .hooks(alice.cookie, 'post', '')
      .send({ name: 'issues', source: 'generic', auth: 'url' })
      .expect(201);
    await t
      .portal(alice.cookie, 'post', '/triggers')
      .send({
        name: 'Work on issues',
        webhookId: hook.body.webhook.id,
        eventTypes: [],
        instructions: 'Work on the issue.',
        templateId: t.ids.template,
        harness: 'claude-code',
      })
      .expect(201);
    await request(t.app)
      .post(new URL(hook.body.url as string).pathname)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ type: 'Issue', data: { identifier: 'ENG-12', title: 'Fix login' } }))
      .expect(200);
    await settle(t.launchpad);

    expect(calls[0]?.url).toBe(`${PLATFORM_LLM_URL}/v1/messages`);
    expect(calls[0]?.headers.get('anthropic-version')).toBeTruthy();
    const user = userText(calls[0]?.body ?? {});
    expect(user).toContain('Instructions: Work on the issue.');
    expect(user).toContain('ENG-12');
    const runs = await t.portal(alice.cookie, 'get', '/runs').expect(200);
    expect(runs.body[0].title).toBe('Issue ENG-12 moved to Todo: Fix login crash');
  });

  it('launches anyway when the platform model fails, and says so in the activity', async () => {
    await configure().expect(200);
    failing = true;
    const alice = await t.member('alice');
    const id = await launch(alice.cookie);
    const run = await t.portal(alice.cookie, 'get', `/runs/${id}`).expect(200);
    expect(run.body.title).toBeNull();
    expect(t.driver.specs).toHaveLength(1);
    const activity = t.gateway.activity.recent();
    expect(activity.map((a) => a.detail).join('\n')).toContain(
      'The platform model could not name the run: The platform model answered HTTP 503',
    );
  });
});

describe('skill labels', () => {
  const skillMd = (name: string, body: string): string =>
    `---\nname: ${name}\ndescription: ${name} notes\n---\n\n${body}\n`;

  it('labels exported skills, offering the labels the library already has', async () => {
    await configure().expect(200);
    const alice = await t.member('alice');
    answer = (user) =>
      user.includes('linear-graphql') ? '["linear", "graphql"]' : 'Labels: ["linear", "Webhooks"]';
    await launch(alice.cookie);
    await t
      .runner(t.driver.lastConfig().runToken, 'post', '/finish')
      .send({
        outcome: 'succeeded',
        finalMessage: null,
        memory: null,
        error: null,
        skills: [
          { name: 'linear-graphql', content: skillMd('linear-graphql', 'Use issue(id:).') },
          { name: 'linear-webhooks', content: skillMd('linear-webhooks', 'Check the HMAC.') },
        ],
      })
      .expect(200);
    await settle(t.launchpad);

    const skills = await t.portal(alice.cookie, 'get', '/skills').expect(200);
    expect(
      (skills.body as { name: string; labels: string[] }[]).map((s) => [s.name, s.labels]),
    ).toEqual([
      ['linear-graphql', ['linear', 'graphql']],
      ['linear-webhooks', ['linear', 'webhooks']],
    ]);
    // The second skill was labelled knowing the first one's labels.
    const labelCalls = calls.filter((c) => userText(c.body).includes('Existing labels'));
    expect(userText(labelCalls[0]?.body ?? {})).toContain('Existing labels: (none yet)');
    expect(userText(labelCalls[1]?.body ?? {})).toContain('Existing labels: linear, graphql');
  });
});

describe('answers', () => {
  it('keeps one clean line as the title', () => {
    expect(cleanTitle('Title: **Triage new bugs**\nBecause…')).toBe('Triage new bugs');
    expect(cleanTitle('  \n')).toBeNull();
    expect(cleanTitle('x'.repeat(200))?.length).toBe(80);
  });

  it('keeps at most three plain labels', () => {
    expect(cleanLabels('["GitHub", "pull_requests", "ci", "extra"]')).toEqual([
      'github',
      'pull requests',
      'ci',
    ]);
    expect(cleanLabels('slack, monday.com!, ')).toEqual(['slack']);
    expect(cleanLabels('far too many words for a label, ok')).toEqual(['ok']);
  });
});
