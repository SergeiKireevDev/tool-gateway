import { beforeEach, describe, expect, it } from 'vitest';
import { nextRun, nextRuns, type Recurrence } from '../src/server/launchpad/recurrence.js';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();
const rec = (r: Partial<Recurrence>): Recurrence => ({
  preset: 'daily',
  minute: 0,
  hour: 9,
  weekday: 1,
  dayOfMonth: 1,
  timezone: 'UTC',
  ...r,
});

describe('recurrence', () => {
  it('computes hourly, daily, weekly and monthly runs', () => {
    const t = at('2026-03-10T10:30:00Z'); // a Tuesday
    expect(iso(nextRun(rec({ preset: 'hourly', minute: 15 }), t))).toBe('2026-03-10T11:15:00.000Z');
    expect(iso(nextRun(rec({ preset: 'hourly', minute: 45 }), t))).toBe('2026-03-10T10:45:00.000Z');
    expect(iso(nextRun(rec({ preset: 'daily' }), t))).toBe('2026-03-11T09:00:00.000Z');
    expect(iso(nextRun(rec({ preset: 'daily', hour: 18 }), t))).toBe('2026-03-10T18:00:00.000Z');
    expect(iso(nextRun(rec({ preset: 'weekly', weekday: 1 }), t))).toBe('2026-03-16T09:00:00.000Z');
    expect(iso(nextRun(rec({ preset: 'weekly', weekday: 2, hour: 11 }), t))).toBe(
      '2026-03-10T11:00:00.000Z',
    );
    expect(iso(nextRun(rec({ preset: 'monthly', dayOfMonth: 5 }), t))).toBe(
      '2026-04-05T09:00:00.000Z',
    );
    expect(
      iso(nextRun(rec({ preset: 'monthly', dayOfMonth: 28 }), at('2026-12-30T00:00:00Z'))),
    ).toBe('2027-01-28T09:00:00.000Z');
  });

  it('follows the time zone across daylight saving changes', () => {
    const paris = rec({ preset: 'daily', hour: 9, timezone: 'Europe/Paris' });
    // CET (UTC+1) before 29 March 2026, CEST (UTC+2) after.
    expect(nextRuns(paris, at('2026-03-27T12:00:00Z'), 3).map(iso)).toEqual([
      '2026-03-28T08:00:00.000Z',
      '2026-03-29T07:00:00.000Z',
      '2026-03-30T07:00:00.000Z',
    ]);
    const ny = rec({
      preset: 'weekly',
      weekday: 0,
      hour: 23,
      minute: 30,
      timezone: 'America/New_York',
    });
    expect(iso(nextRun(ny, at('2026-07-01T00:00:00Z')))).toBe('2026-07-06T03:30:00.000Z');
  });
});

let t: LaunchHarness;

beforeEach(async () => {
  t = await createLaunchHarness();
  t.clock.now = new Date('2026-03-10T10:30:00Z');
});

const scheduleBody = (extra: object = {}) => ({
  prompt: 'Summarize yesterday’s issues',
  templateId: t.ids.template,
  harness: 'claude-code',
  preset: 'daily',
  hour: 9,
  timezone: 'UTC',
  ...extra,
});

async function finishLastRun(memory: string | null): Promise<void> {
  const { runToken } = t.driver.lastConfig();
  await t
    .runner(runToken, 'post', '/finish')
    .send({ outcome: 'succeeded', finalMessage: 'ok', memory, error: null })
    .expect(200);
}

describe('schedules', () => {
  it('launches due schedules and carries MEMORY.md between runs', async () => {
    const alice = await t.member('alice');
    const created = await t
      .portal(alice.cookie, 'post', '/schedules')
      .send(scheduleBody())
      .expect(201);
    expect(created.body).toMatchObject({
      enabled: true,
      nextRunAt: '2026-03-11T09:00:00.000Z',
      nextRuns: [
        '2026-03-11T09:00:00.000Z',
        '2026-03-12T09:00:00.000Z',
        '2026-03-13T09:00:00.000Z',
      ],
      name: 'Summarize yesterday’s issues',
    });

    await t.scheduler.tick();
    expect(t.driver.specs).toHaveLength(0); // not due yet

    t.clock.now = new Date('2026-03-11T09:00:10Z');
    await t.scheduler.tick();
    await settle(t.launchpad);
    expect(t.driver.lastConfig().memory).toBeNull();
    await finishLastRun('# notes\nlast seen #42');

    t.clock.now = new Date('2026-03-12T09:00:05Z');
    await t.scheduler.tick();
    await settle(t.launchpad);
    expect(t.driver.specs).toHaveLength(2);
    expect(t.driver.lastConfig().memory).toBe('# notes\nlast seen #42');
    expect(t.driver.lastConfig().systemPrompt).toContain('notes from your previous runs');
    const cookie = await t.cookieFor('alice');
    const runs = await t
      .portal(cookie, 'get', `/runs?scheduleId=${created.body.id as string}`)
      .expect(200);
    expect(runs.body).toHaveLength(2);
  });

  it('runs on the model API picked when the schedule was created', async () => {
    const tpl = await t
      .admin('post', '/templates')
      .send({
        name: 'anthropic + local endpoint',
        grants: [
          { tool: 'anthropic', permissions: ['llm:invoke'], resources: [] },
          {
            tool: 'custom',
            permissions: ['llm:invoke'],
            resources: [],
            endpoint: { url: 'http://192.168.1.20:1234', api: 'anthropic' },
          },
        ],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 4 * 3600,
      })
      .expect(201);
    const templateId = tpl.body.id as string;
    const alice = await t.member('alice', [templateId]);
    const created = await t
      .portal(alice.cookie, 'post', '/schedules')
      .send(scheduleBody({ templateId, provider: 'custom', model: 'qwen' }))
      .expect(201);
    expect(created.body).toMatchObject({ provider: 'custom', model: 'qwen' });
    t.clock.now = new Date('2026-03-11T09:00:10Z');
    await t.scheduler.tick();
    await settle(t.launchpad);
    expect(t.driver.lastConfig().llm).toEqual({
      provider: 'custom',
      model: 'qwen',
      api: 'anthropic',
    });
  });

  it('skips a run while the previous one is still going', async () => {
    const alice = await t.member('alice');
    await t
      .portal(alice.cookie, 'post', '/schedules')
      .send(scheduleBody({ preset: 'hourly', minute: 0 }))
      .expect(201);
    t.clock.now = new Date('2026-03-10T11:00:01Z');
    await t.scheduler.tick();
    await settle(t.launchpad);
    t.clock.now = new Date('2026-03-10T12:00:01Z');
    await t.scheduler.tick();
    await settle(t.launchpad);
    expect(t.driver.specs).toHaveLength(1);
  });

  it('stops when the member key is rotated, until the member resumes it', async () => {
    const alice = await t.member('alice');
    const s = await t.portal(alice.cookie, 'post', '/schedules').send(scheduleBody()).expect(201);
    const id = s.body.id as string;
    await t.admin('post', `/members/${alice.id}/rotate`).expect(200);
    t.clock.now = new Date('2026-03-11T09:00:10Z');
    await t.scheduler.tick();
    const cookie = await t.cookieFor('alice');
    const stopped = await t.portal(cookie, 'get', `/schedules/${id}`).expect(200);
    expect(stopped.body).toMatchObject({
      enabled: false,
      stoppedReason: 'The member key was rotated or revoked',
      nextRuns: [],
    });
    expect(t.driver.specs).toHaveLength(0);

    const resumed = await t
      .portal(cookie, 'patch', `/schedules/${id}`)
      .send({ enabled: true })
      .expect(200);
    expect(resumed.body).toMatchObject({ enabled: true, stoppedReason: null, keyGeneration: 1 });
  });

  it('lets the admin see and pause every schedule, but not resume it', async () => {
    const alice = await t.member('alice');
    const bob = await t.member('bob');
    const s = await t.portal(alice.cookie, 'post', '/schedules').send(scheduleBody()).expect(201);
    const id = s.body.id as string;
    await t.portal(bob.cookie, 'get', `/schedules/${id}`).expect(404);
    expect((await t.portal(bob.cookie, 'get', '/schedules').expect(200)).body).toEqual([]);
    expect((await t.admin('get', '/launchpad/schedules').expect(200)).body).toHaveLength(1);
    const paused = await t
      .admin('patch', `/launchpad/schedules/${id}`)
      .send({ enabled: false })
      .expect(200);
    expect(paused.body.stoppedReason).toBe('Paused by the admin');
    await t.admin('patch', `/launchpad/schedules/${id}`).send({ enabled: true }).expect(400);
    await t.portal(alice.cookie, 'delete', `/schedules/${id}`).expect(204);
  });

  it('validates schedules like launches', async () => {
    const alice = await t.member('alice');
    await t
      .portal(alice.cookie, 'post', '/schedules')
      .send(scheduleBody({ timezone: 'Mars/Olympus' }))
      .expect(400);
    await t
      .portal(alice.cookie, 'post', '/schedules')
      .send(scheduleBody({ preset: 'yearly' }))
      .expect(400);
    await t
      .portal(alice.cookie, 'post', '/schedules')
      .send(scheduleBody({ templateId: t.ids.noLlmTemplate }))
      .expect(400);
    await t
      .portal(alice.cookie, 'post', '/schedules')
      .send(scheduleBody({ dayOfMonth: 31, preset: 'monthly' }))
      .expect(400);
  });
});
