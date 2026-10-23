import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { McpServer } from '../src/guest/mcpServer.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

let t: LaunchHarness;

beforeEach(async () => {
  t = await createLaunchHarness();
});

async function webhookOf(cookie: string): Promise<{ id: string; path: string }> {
  const res = await t
    .hooks(cookie, 'post', '')
    .send({ name: 'linear', source: 'generic', auth: 'url' })
    .expect(201);
  return { id: res.body.webhook.id as string, path: new URL(res.body.url as string).pathname };
}

const KEY = '.data.issueId // .data.id';

/** A conversation channel the admin adds (enabled). */
async function channel(conversationKey = KEY): Promise<string> {
  const res = await t
    .admin('post', '/launchpad/channels')
    .send({ name: 'Linear issues', description: 'One per issue', conversationKey })
    .expect(201);
  return res.body.id as string;
}

let channelId = '';

const triggerBody = (webhookId: string, extra: object = {}) => ({
  name: 'Issue threads',
  webhookId,
  channelId,
  instructions: 'Answer every comment on the issue.',
  templateId: t.ids.template,
  harness: 'claude-code',
  ...extra,
});

const deliver = async (path: string, payload: object): Promise<void> => {
  await request(t.app)
    .post(path)
    .set('content-type', 'application/json')
    .send(JSON.stringify(payload))
    .expect(200);
  await settle(t.launchpad);
};

const comment = (issueId: string, body: string) => ({
  type: 'Comment',
  action: 'create',
  data: { issueId, body },
});

/** The agent's side of its conversation, with its session key. */
const session = (key: string, method: 'get' | 'post', path = '') =>
  request(t.vmApp)
    [method](`/api/session/conversation${path}`)
    .set('authorization', `Bearer ${key}`);

const finish = async (runToken: string, body: object = {}): Promise<void> => {
  await t
    .runner(runToken, 'post', '/finish')
    .send({ outcome: 'succeeded', finalMessage: 'Answered.', memory: null, error: null, ...body })
    .expect(200);
  await settle(t.launchpad);
};

async function conversationTrigger(): Promise<{
  cookie: string;
  hook: { id: string; path: string };
  triggerId: string;
}> {
  channelId = await channel();
  const alice = await t.member('alice');
  const hook = await webhookOf(alice.cookie);
  const created = await t
    .portal(alice.cookie, 'post', '/triggers')
    .send(triggerBody(hook.id))
    .expect(201);
  expect(created.body).toMatchObject({
    channelId,
    channelName: 'Linear issues',
    conversationKey: KEY,
  });
  return { cookie: alice.cookie, hook, triggerId: created.body.id as string };
}

describe('conversation triggers', () => {
  it('lets only the admin define conversation channels, and checks their key', async () => {
    const bad = await t
      .admin('post', '/launchpad/channels')
      .send({ name: 'Broken', conversationKey: '.data[' })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain('Conversation key');
    channelId = await channel();
    const alice = await t.member('alice');
    const hook = await webhookOf(alice.cookie);

    // Members pick a channel; they can't write their own key, nor manage channels.
    const own = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id, { channelId: '', conversationKey: '.data.id' }))
      .expect(400);
    expect(JSON.stringify(own.body)).toContain('set by the admin');
    await t.portal(alice.cookie, 'post', '/channels').send({ name: 'x' }).expect(404);
    const info = await t.portal(alice.cookie, 'get', '').expect(200);
    expect(info.body.channels).toEqual([
      {
        id: channelId,
        name: 'Linear issues',
        description: 'One per issue',
        conversationKey: KEY,
        eventTypes: [],
        sources: [],
        filters: { contains: [], statusChangedTo: [], assignedTo: [] },
        templateId: null,
        agentTtlSeconds: null,
      },
    ]);
    const plain = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id, { channelId: '' }))
      .expect(201);
    expect(plain.body).toMatchObject({ channelId: null, conversationKey: null });

    // A disabled channel can't be picked, and the triggers on it stop at their next delivery.
    const created = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id))
      .expect(201);
    await t.admin('patch', `/launchpad/channels/${channelId}`).send({ enabled: false }).expect(200);
    expect((await t.portal(alice.cookie, 'get', '').expect(200)).body.channels).toEqual([]);
    await t.portal(alice.cookie, 'post', '/triggers').send(triggerBody(hook.id)).expect(400);
    await deliver(hook.path, comment('ISS-1', 'Hello'));
    const stopped = await t
      .portal(alice.cookie, 'get', `/triggers/${created.body.id as string}`)
      .expect(200);
    expect(stopped.body).toMatchObject({
      enabled: false,
      stoppedReason: expect.stringContaining('channel'),
    });
    await t
      .portal(alice.cookie, 'patch', `/triggers/${created.body.id as string}`)
      .send({ enabled: true })
      .expect(400);

    // Enabled again (with an edited key), the trigger resumes on it.
    await t
      .admin('put', `/launchpad/channels/${channelId}`)
      .send({ name: 'Linear issues', conversationKey: '.data.issueId' })
      .expect(200);
    await t.admin('patch', `/launchpad/channels/${channelId}`).send({ enabled: true }).expect(200);
    const resumed = await t
      .portal(alice.cookie, 'patch', `/triggers/${created.body.id as string}`)
      .send({ enabled: true })
      .expect(200);
    expect(resumed.body).toMatchObject({ enabled: true, conversationKey: '.data.issueId' });
    const list = await t.admin('get', '/launchpad/channels').expect(200);
    expect(list.body).toEqual([expect.objectContaining({ id: channelId, enabled: true })]);
    await t.admin('delete', `/launchpad/channels/${channelId}`).expect(204);
    const gone = await t
      .portal(alice.cookie, 'get', `/triggers/${created.body.id as string}`)
      .expect(200);
    expect(gone.body).toMatchObject({ channelName: null, conversationKey: null });
  });

  it('lets the admin filter the types of notification a channel carries', async () => {
    const { cookie, hook, triggerId } = await conversationTrigger();
    await t
      .admin('put', `/launchpad/channels/${channelId}`)
      .send({ name: 'Linear issues', conversationKey: KEY, eventTypes: ['Comment', 'Comment'] })
      .expect(200);
    const [listed] = (await t.admin('get', '/launchpad/channels').expect(200)).body;
    expect(listed).toMatchObject({ eventTypes: ['Comment'] });
    const trigger = await t.portal(cookie, 'get', `/triggers/${triggerId}`).expect(200);
    expect(trigger.body).toMatchObject({ channelEventTypes: ['Comment'] });

    // An issue update isn't a notification the channel carries: no conversation, no run.
    await deliver(hook.path, { type: 'Issue', action: 'update', data: { id: 'ISS-1' } });
    expect(t.driver.specs).toHaveLength(0);
    const none = await t.portal(cookie, 'get', `/triggers/${triggerId}/conversations`).expect(200);
    expect(none.body).toEqual([]);
    const still = await t.portal(cookie, 'get', `/triggers/${triggerId}`).expect(200);
    expect(still.body).toMatchObject({ enabled: true });

    // A comment (`Comment.create`, a sub-type) is.
    await deliver(hook.path, comment('ISS-1', 'Hello'));
    expect(t.driver.specs).toHaveLength(1);
    const list = await t.portal(cookie, 'get', `/triggers/${triggerId}/conversations`).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ key: 'ISS-1', messages: 1 })]);

    await t
      .admin('put', `/launchpad/channels/${channelId}`)
      .send({ name: 'Linear issues', conversationKey: KEY, eventTypes: [''] })
      .expect(400);
  });

  it("leaves a channel's event types and filters to the admin", async () => {
    const { cookie, hook, triggerId } = await conversationTrigger();
    // A trigger on a channel can't set event types or filters of its own…
    for (const extra of [{ eventTypes: ['Issue'] }, { filters: { contains: ['urgent'] } }]) {
      const res = await t
        .portal(cookie, 'post', '/triggers')
        .send(triggerBody(hook.id, extra))
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('conversation channel sets the event types');
      await t
        .portal(cookie, 'put', `/triggers/${triggerId}`)
        .send(triggerBody(hook.id, extra))
        .expect(400);
    }
    // …but a plain trigger can.
    await t
      .portal(cookie, 'post', '/triggers')
      .send(triggerBody(hook.id, { channelId: '', eventTypes: ['Issue'] }))
      .expect(201);

    // Those a trigger set before channels picked them are ignored: the channel's apply.
    t.db.sql
      .prepare('UPDATE triggers SET event_types = ? WHERE id = ?')
      .run(JSON.stringify(['Issue']), triggerId);
    await deliver(hook.path, comment('ISS-1', 'Hello'));
    const list = await t.portal(cookie, 'get', `/triggers/${triggerId}/conversations`).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ key: 'ISS-1', messages: 1 })]);
  });

  it('lets the admin pick the sources, filters, template and agent TTL of a channel', async () => {
    const own = await t
      .admin('post', '/templates')
      .send({
        name: 'conversation agents',
        grants: [
          { tool: 'anthropic', permissions: ['llm:invoke'], resources: ['claude-sonnet-5'] },
        ],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 12 * 3600,
      })
      .expect(201);
    const convTemplate = own.body.id as string;
    const body = (extra: object) => ({ name: 'Threads', conversationKey: KEY, ...extra });
    // The template must exist, and its keys must outlive the agents.
    await t
      .admin('post', '/launchpad/channels')
      .send(body({ templateId: 'nope' }))
      .expect(400);
    const tooLong = await t
      .admin('post', '/launchpad/channels')
      .send(body({ templateId: t.ids.template, agentTtlSeconds: 5 * 3600 }))
      .expect(400);
    expect(JSON.stringify(tooLong.body)).toContain('agent TTL');
    await t
      .admin('post', '/launchpad/channels')
      .send(body({ agentTtlSeconds: 60 }))
      .expect(400);
    const created = await t
      .admin('post', '/launchpad/channels')
      .send(
        body({
          sources: ['github'],
          filters: { contains: ['urgent'] },
          templateId: convTemplate,
          agentTtlSeconds: 10 * 3600,
        }),
      )
      .expect(201);
    channelId = created.body.id as string;
    expect(created.body).toMatchObject({
      sources: ['github'],
      filters: { contains: ['urgent'], statusChangedTo: [], assignedTo: [] },
      templateId: convTemplate,
      agentTtlSeconds: 10 * 3600,
    });

    // Members only see the channels whose template is one of theirs.
    const bob = await t.member('bob');
    expect((await t.portal(bob.cookie, 'get', '').expect(200)).body.channels).toEqual([]);
    const alice = await t.member('alice', [t.ids.template, convTemplate]);
    const info = await t.portal(alice.cookie, 'get', '').expect(200);
    expect(info.body.channels).toEqual([expect.objectContaining({ id: channelId })]);

    // A trigger on the channel listens to one of its sources, with its template.
    const hook = await webhookOf(alice.cookie);
    const source = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id, { templateId: convTemplate }))
      .expect(400);
    expect(JSON.stringify(source.body)).toContain('only carries github webhooks');
    await t
      .admin('put', `/launchpad/channels/${channelId}`)
      .send(
        body({
          sources: ['generic', 'github'],
          filters: { contains: ['urgent'] },
          templateId: convTemplate,
          agentTtlSeconds: 10 * 3600,
        }),
      )
      .expect(200);
    const template = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id))
      .expect(400);
    expect(template.body.message).toContain('use template "conversation agents"');
    const trigger = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id, { templateId: convTemplate }))
      .expect(201);
    expect(trigger.body).toMatchObject({ channelAgentTtlSeconds: 10 * 3600 });
    const triggerId = trigger.body.id as string;

    // Only deliveries that pass its filters are messages.
    await deliver(hook.path, comment('ISS-1', 'Hello'));
    expect(t.driver.specs).toHaveLength(0);
    await deliver(hook.path, comment('ISS-1', 'Urgent: it crashes'));
    expect(t.driver.specs).toHaveLength(1);

    // Its agents live as long as its agent TTL, with its template.
    const first = await t.portal(alice.cookie, 'get', `/triggers/${triggerId}`).expect(200);
    const run = t.launchpad.runs.require(first.body.lastRunId as string);
    expect(run).toMatchObject({ templateId: convTemplate, timeoutSeconds: 10 * 3600 });

    // The admin moves the channel to another template: the next agent gets it.
    await t
      .admin('put', `/launchpad/channels/${channelId}`)
      .send(body({ templateId: t.ids.template }))
      .expect(200);
    await finish(t.driver.specs[0]?.config.runToken ?? '');
    await deliver(hook.path, comment('ISS-2', 'urgent too'));
    const next = await t.portal(alice.cookie, 'get', `/triggers/${triggerId}`).expect(200);
    expect(next.body.lastRunId).not.toBe(run.id);
    const nextRun = t.launchpad.runs.require(next.body.lastRunId as string);
    expect(nextRun).toMatchObject({ templateId: t.ids.template, timeoutSeconds: 2 * 3600 });
  });

  it('gives the events of a conversation to its running agent', async () => {
    const { hook } = await conversationTrigger();
    await deliver(hook.path, comment('ISS-1', 'First question'));
    expect(t.driver.specs).toHaveLength(1);
    const first = t.driver.lastConfig();
    expect(first.prompt).toContain('First question');
    expect(first.systemPrompt).toContain('## Conversation');
    expect(first.systemPrompt).toContain('conversation key `ISS-1`');
    expect(first.systemPrompt).toContain('gateway_conversation_receive');
    expect(first.systemPrompt).not.toContain('earlier run');

    // Another conversation gets its own agent; the same one doesn't.
    await deliver(hook.path, comment('ISS-2', 'Other issue'));
    expect(t.driver.specs).toHaveLength(2);
    await deliver(hook.path, comment('ISS-1', 'Follow-up'));
    expect(t.driver.specs).toHaveLength(2);

    const info = await session(first.sessionKey, 'get').expect(200);
    expect(info.body).toEqual({ key: 'ISS-1', runs: 1, pending: 1 });
    const got = await session(first.sessionKey, 'post', '/receive').send({}).expect(200);
    expect(got.body.messages).toHaveLength(1);
    expect(got.body.messages[0].text).toContain('Follow-up');
    const none = await session(first.sessionKey, 'post', '/receive').send({}).expect(200);
    expect(none.body.messages).toEqual([]);
    await session(first.sessionKey, 'post', '/receive').send({ waitSeconds: 3600 }).expect(400);
  });

  it('wakes an agent waiting for an event', async () => {
    const { hook } = await conversationTrigger();
    await deliver(hook.path, comment('ISS-1', 'First question'));
    const { sessionKey } = t.driver.lastConfig();
    const started = Date.now();
    const waiting = session(sessionKey, 'post', '/receive')
      .send({ waitSeconds: 20 })
      .then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await deliver(hook.path, comment('ISS-1', 'Are you there?'));
    const res = await waiting;
    expect(res.status).toBe(200);
    expect(res.body.messages[0].text).toContain('Are you there?');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('revives the conversation with its history and memory', async () => {
    const { cookie, hook, triggerId } = await conversationTrigger();
    await deliver(hook.path, comment('ISS-1', 'First question'));
    const first = t.driver.lastConfig();
    await session(first.sessionKey, 'post', '/reply').send({ text: 'Looking into it' }).expect(201);
    await deliver(hook.path, comment('ISS-1', 'Arrived late'));
    expect(t.driver.specs).toHaveLength(1);

    // The event the agent never asked for starts the next run, with what the first one left.
    await finish(first.runToken, { memory: 'Customer prefers short answers.' });
    expect(t.driver.specs).toHaveLength(2);
    const second = t.driver.lastConfig();
    expect(second.memory).toBe('Customer prefers short answers.');
    expect(second.prompt).toContain('Arrived late');
    expect(second.prompt).not.toContain('First question');
    expect(second.systemPrompt).toContain('1 earlier run(s)');
    expect(second.systemPrompt).toContain('First question');
    expect(second.systemPrompt).toContain('Looking into it');
    expect(second.systemPrompt).toContain('Answered.');
    expect(second.systemPrompt).not.toContain('Arrived late');

    // Once it ends with nothing waiting, the conversation stays, and a new event revives it.
    await finish(second.runToken, { memory: null });
    expect(t.driver.specs).toHaveLength(2);
    await deliver(hook.path, comment('ISS-1', 'Thanks!'));
    expect(t.driver.specs).toHaveLength(3);
    expect(t.driver.lastConfig().memory).toBe('Customer prefers short answers.');
    expect(t.driver.lastConfig().systemPrompt).toContain('2 earlier run(s)');

    const list = await t.portal(cookie, 'get', `/triggers/${triggerId}/conversations`).expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ key: 'ISS-1', runs: 3, pending: 0, messages: 6 }),
    ]);
    const id = list.body[0].id as string;
    const messages = await t
      .portal(cookie, 'get', `/triggers/${triggerId}/conversations/${id}/messages`)
      .expect(200);
    expect((messages.body as { direction: string }[]).map((m) => m.direction)).toEqual([
      'in',
      'out',
      'in',
      'out',
      'out',
      'in',
    ]);
    const page = await t
      .portal(
        cookie,
        'get',
        `/triggers/${triggerId}/conversations/${id}/messages?after=${messages.body[4].id as number}`,
      )
      .expect(200);
    expect(page.body).toHaveLength(1);
    await t.admin('get', `/launchpad/triggers/${triggerId}/conversations`).expect(200);
    const bob = await t.member('bob');
    await t.portal(bob.cookie, 'get', `/triggers/${triggerId}/conversations`).expect(404);
    await t.portal(bob.cookie, 'delete', `/triggers/${triggerId}/conversations/${id}`).expect(404);

    // Forgotten, the key starts a new conversation.
    await t.portal(cookie, 'delete', `/triggers/${triggerId}/conversations/${id}`).expect(204);
    await session(t.driver.lastConfig().sessionKey, 'get').expect(404);
    await deliver(hook.path, comment('ISS-1', 'New start'));
    expect(t.driver.specs).toHaveLength(4);
    expect(t.driver.lastConfig().memory).toBeNull();
    expect(t.driver.lastConfig().systemPrompt).not.toContain('earlier run');
  });

  it('skips deliveries without a key, and serves waiting conversations when room frees', async () => {
    const { cookie, hook } = await conversationTrigger();
    await deliver(hook.path, { type: 'Comment', data: { body: 'no issue' } });
    expect(t.driver.specs).toHaveLength(0);
    for (const id of ['A', 'B', 'C', 'D']) await deliver(hook.path, comment(id, `about ${id}`));
    const prompts = async (): Promise<string[]> => {
      const runs = await t.portal(cookie, 'get', '/runs').expect(200);
      return (runs.body as { prompt: string }[]).map((r) => r.prompt);
    };
    expect(await prompts()).toHaveLength(3);
    await finish(t.driver.specs[0]?.config.runToken ?? '');
    const after = await prompts();
    expect(after).toHaveLength(4);
    expect(after.some((p) => p.includes('about D'))).toBe(true);
  });

  it('is only reachable by runs that serve a conversation', async () => {
    const alice = await t.member('alice');
    const hook = await webhookOf(alice.cookie);
    await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id, { channelId: undefined }))
      .expect(201);
    await deliver(hook.path, comment('ISS-1', 'First question'));
    const { sessionKey, systemPrompt } = t.driver.lastConfig();
    expect(systemPrompt).not.toContain('## Conversation');
    await session(sessionKey, 'get').expect(404);
    await session(sessionKey, 'post', '/receive').send({}).expect(404);
    await session('gws_nope', 'get').expect(401);
  });

  it('gives the agent conversation tools in its MCP server', async () => {
    const { hook } = await conversationTrigger();
    await deliver(hook.path, comment('ISS-1', 'First question'));
    const { sessionKey } = t.driver.lastConfig();
    const server = t.vmApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const mcp = new McpServer({ gatewayUrl, sessionKey });
      const call = async (name: string, args: object) =>
        (await mcp.handle({
          jsonrpc: '2.0',
          id: name,
          method: 'tools/call',
          params: { name, arguments: args },
        })) as { result: { isError: boolean; content: { text: string }[] } };
      const list = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as {
        result: { tools: { name: string }[] };
      };
      expect(list.result.tools.map((x) => x.name)).toEqual([
        'gateway_github',
        'gateway_conversation_receive',
        'gateway_conversation_reply',
      ]);
      const empty = await call('gateway_conversation_receive', { waitSeconds: 0 });
      expect(empty.result.content[0]?.text).toBe('No new event in 0 s.');
      await deliver(hook.path, comment('ISS-1', 'Second question'));
      const got = await call('gateway_conversation_receive', {});
      expect(got.result.isError).toBe(false);
      expect(got.result.content[0]?.text).toContain('1 new event(s)');
      expect(got.result.content[0]?.text).toContain('Second question');
      const replied = await call('gateway_conversation_reply', { text: 'On it' });
      expect(replied.result).toMatchObject({ isError: false });
      const bad = await call('gateway_conversation_reply', {});
      expect(bad.result.isError).toBe(true);
    } finally {
      server.close();
    }
  });
});
