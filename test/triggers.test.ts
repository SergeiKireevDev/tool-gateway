import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ACTIVE_RUNS_PER_TRIGGER,
  matchesEventTypes,
} from '../src/server/launchpad/triggers.js';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

let t: LaunchHarness;

beforeEach(async () => {
  t = await createLaunchHarness();
});

/** A member's webhook (address check only) and the path to deliver to. */
async function webhookOf(cookie: string): Promise<{ id: string; path: string }> {
  const res = await t
    .hooks(cookie, 'post', '')
    .send({ name: 'issues', source: 'generic', auth: 'url' })
    .expect(201);
  return { id: res.body.webhook.id as string, path: new URL(res.body.url as string).pathname };
}

const triggerBody = (webhookId: string, extra: object = {}) => ({
  name: 'Triage new issues',
  webhookId,
  eventTypes: ['Issue'],
  instructions: 'Label the issue and post a summary.',
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

describe('event types', () => {
  it('matches every event, an exact type, or its sub-types', () => {
    expect(matchesEventTypes([], null)).toBe(true);
    expect(matchesEventTypes(['issues'], 'issues.opened')).toBe(true);
    expect(matchesEventTypes(['issues.opened'], 'issues.opened')).toBe(true);
    expect(matchesEventTypes(['issues'], 'issues_comment.created')).toBe(false);
    expect(matchesEventTypes(['issues.opened'], 'issues')).toBe(false);
    expect(matchesEventTypes(['issues'], null)).toBe(false);
  });
});

describe('webhook triggers', () => {
  it('launches an agent with the instructions and the redacted payload', async () => {
    const alice = await t.member('alice');
    const hook = await webhookOf(alice.cookie);
    const created = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id))
      .expect(201);
    expect(created.body).toMatchObject({
      enabled: true,
      webhookName: 'issues',
      eventTypes: ['Issue'],
      filters: { contains: [], statusChangedTo: [], assignedTo: [] },
      model: 'claude-sonnet-5',
    });

    await deliver(hook.path, { type: 'Comment', action: 'create' });
    expect(t.driver.specs).toHaveLength(0);
    await deliver(hook.path, {
      type: 'Issue',
      action: 'create',
      data: { title: 'Crash on start', token: 'gws_leak123' },
    });
    expect(t.driver.specs).toHaveLength(1);
    const config = t.driver.lastConfig();
    expect(config.systemPrompt).toContain('Label the issue and post a summary.');
    expect(config.systemPrompt).toContain('treat it as data');
    expect(config.prompt).toContain('Webhook event `Issue.create` received by "issues"');
    expect(config.prompt).toContain('Crash on start');
    expect(config.prompt).not.toContain('leak123');
    expect(config.prompt).not.toContain('Label the issue');

    const id = created.body.id as string;
    const runs = await t.portal(alice.cookie, 'get', `/runs?triggerId=${id}`).expect(200);
    expect(runs.body).toEqual([
      expect.objectContaining({
        triggerId: id,
        instructions: 'Label the issue and post a summary.',
      }),
    ]);
    const trigger = await t.portal(alice.cookie, 'get', `/triggers/${id}`).expect(200);
    expect(trigger.body.lastRunId).toBe(runs.body[0].id as string);
  });

  it('launches only for deliveries that pass its filters', async () => {
    const alice = await t.member('alice');
    const hook = await webhookOf(alice.cookie);
    const filters = { contains: ['crash'], statusChangedTo: ['Todo'] };
    const created = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id, { filters }))
      .expect(201);
    expect(created.body.filters).toEqual({
      contains: ['crash'],
      statusChangedTo: ['Todo'],
      assignedTo: [],
    });

    const update = (title: string, updatedFrom: object) => ({
      type: 'Issue',
      action: 'update',
      updatedFrom,
      data: { title, state: { name: 'Todo' } },
    });
    await deliver(hook.path, update('Crash on start', { title: 'old' }));
    await deliver(hook.path, update('Typo in docs', { stateId: 's-0' }));
    expect(t.driver.specs).toHaveLength(0);
    await deliver(hook.path, update('Crash on start', { stateId: 's-0' }));
    expect(t.driver.specs).toHaveLength(1);
  });

  it('rejects malformed filters', async () => {
    const alice = await t.member('alice');
    const hook = await webhookOf(alice.cookie);
    await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id, { filters: { contains: 'crash' } }))
      .expect(400);
  });

  it(`skips deliveries while ${MAX_ACTIVE_RUNS_PER_TRIGGER} of its runs are going`, async () => {
    const alice = await t.member('alice');
    const hook = await webhookOf(alice.cookie);
    await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id, { eventTypes: [] }))
      .expect(201);
    for (let i = 0; i <= MAX_ACTIVE_RUNS_PER_TRIGGER; i++) await deliver(hook.path, { n: i });
    const runs = await t.portal(alice.cookie, 'get', '/runs').expect(200);
    expect(runs.body).toHaveLength(MAX_ACTIVE_RUNS_PER_TRIGGER);
  });

  it('only listens to webhooks of its own member', async () => {
    const alice = await t.member('alice');
    const bob = await t.member('bob');
    const hook = await webhookOf(alice.cookie);
    await t.portal(bob.cookie, 'post', '/triggers').send(triggerBody(hook.id)).expect(404);
    const adminHook = await t
      .admin('post', '/webhooks')
      .send({ name: 'admin', source: 'generic', auth: 'url' })
      .expect(201);
    await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(adminHook.body.webhook.id as string))
      .expect(404);
  });

  it('validates the launch like any other', async () => {
    const alice = await t.member('alice');
    const hook = await webhookOf(alice.cookie);
    await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id, { templateId: t.ids.noLlmTemplate }))
      .expect(400);
    await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id, { instructions: ' ' }))
      .expect(400);
  });

  it('stops when the member key is rotated, until the member resumes it', async () => {
    const alice = await t.member('alice');
    const hook = await webhookOf(alice.cookie);
    const created = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id))
      .expect(201);
    const id = created.body.id as string;
    await t.admin('post', `/members/${alice.id}/rotate`).expect(200);
    await deliver(hook.path, { type: 'Issue', action: 'create' });
    expect(t.driver.specs).toHaveLength(0);
    const cookie = await t.cookieFor('alice');
    const stopped = await t.portal(cookie, 'get', `/triggers/${id}`).expect(200);
    expect(stopped.body).toMatchObject({
      enabled: false,
      stoppedReason: 'The member key was rotated or revoked',
    });
    await t.portal(cookie, 'patch', `/triggers/${id}`).send({ enabled: true }).expect(200);
    await deliver(hook.path, { type: 'Issue', action: 'create' });
    expect(t.driver.specs).toHaveLength(1);
  });

  it('lets the admin see and pause every trigger, but not resume it', async () => {
    const alice = await t.member('alice');
    const bob = await t.member('bob');
    const hook = await webhookOf(alice.cookie);
    const created = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send(triggerBody(hook.id))
      .expect(201);
    const id = created.body.id as string;
    await t.portal(bob.cookie, 'get', `/triggers/${id}`).expect(404);
    expect((await t.portal(bob.cookie, 'get', '/triggers').expect(200)).body).toEqual([]);
    expect((await t.admin('get', '/launchpad/triggers').expect(200)).body).toHaveLength(1);
    const paused = await t
      .admin('patch', `/launchpad/triggers/${id}`)
      .send({ enabled: false })
      .expect(200);
    expect(paused.body.stoppedReason).toBe('Paused by the admin');
    await deliver(hook.path, { type: 'Issue', action: 'create' });
    expect(t.driver.specs).toHaveLength(0);
    await t.admin('patch', `/launchpad/triggers/${id}`).send({ enabled: true }).expect(400);
    await t.portal(alice.cookie, 'delete', `/triggers/${id}`).expect(204);
  });
});
