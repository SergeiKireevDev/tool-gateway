import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

let t: LaunchHarness;

beforeEach(async () => {
  t = await createLaunchHarness();
});

const DOCKERFILE = 'FROM launchpad-guest:latest\nRUN apt-get update && apt-get install -y golang\n';

const launchBody = (extra: object = {}) => ({
  prompt: 'Build the Go service in o/r',
  templateId: t.ids.template,
  harness: 'claude-code',
  ...extra,
});

/** Adds an environment as the admin and finishes its build. */
async function readyEnvironment(name = 'Go toolchain'): Promise<string> {
  const res = await t
    .admin('post', '/launchpad/environments')
    .send({ name, description: 'Go 1.24', dockerfile: DOCKERFILE })
    .expect(201);
  const id = res.body.id as string;
  t.driver.finishBuild(id);
  await t.admin('get', '/launchpad/environments').expect(200);
  return id;
}

describe('guest environments (admin)', () => {
  it('builds an environment from a Dockerfile and records how the build went', async () => {
    const res = await t
      .admin('post', '/launchpad/environments')
      .send({ name: 'Go toolchain', dockerfile: DOCKERFILE })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'Go toolchain',
      description: '',
      dockerfile: DOCKERFILE,
      enabled: true,
      status: 'building',
      builtAt: null,
    });
    const id = res.body.id as string;
    expect(t.driver.images.get(id)?.dockerfile).toBe(DOCKERFILE);

    t.driver.finishBuild(id);
    const list = await t.admin('get', '/launchpad/environments').expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        id,
        status: 'ready',
        buildLog: 'Done',
        builtAt: expect.any(String),
      }),
    ]);

    // A changed Dockerfile is rebuilt; a failed build says why.
    const edited = await t
      .admin('put', `/launchpad/environments/${id}`)
      .send({ name: 'Go', dockerfile: `${DOCKERFILE}RUN nope\n` })
      .expect(200);
    expect(edited.body).toMatchObject({ name: 'Go', status: 'building' });
    await t.admin('post', `/launchpad/environments/${id}/rebuild`).expect(409);
    t.driver.finishBuild(id, false);
    await t.launchpad.reap();
    expect(t.launchpad.environments.require(id)).toMatchObject({
      status: 'failed',
      buildLog: expect.stringContaining('exit code 100'),
    });

    await t.admin('post', `/launchpad/environments/${id}/rebuild`).expect(200);
    expect(t.driver.images.get(id)?.status).toBe('building');

    await t.admin('delete', `/launchpad/environments/${id}`).expect(204);
    expect(t.driver.images.has(id)).toBe(false);
    await t.admin('get', '/launchpad/environments').expect(200, []);
  });

  it('refuses Dockerfiles without a base image', async () => {
    const res = await t
      .admin('post', '/launchpad/environments')
      .send({ name: 'Broken', dockerfile: 'RUN echo hi' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('FROM');
    await t
      .admin('post', '/launchpad/environments')
      .send({ name: '', dockerfile: DOCKERFILE })
      .expect(400);
  });

  it('fails a build the VM host lost', async () => {
    const id = await readyEnvironment();
    await t.admin('post', `/launchpad/environments/${id}/rebuild`).expect(200);
    t.driver.images.delete(id);
    await t.launchpad.reap();
    expect(t.launchpad.environments.require(id)).toMatchObject({
      status: 'failed',
      buildLog: expect.stringContaining('lost the build'),
    });
  });

  it('is admin only', async () => {
    const alice = await t.member('alice');
    await t
      .portal(alice.cookie, 'post', '/environments')
      .send({ name: 'x', dockerfile: DOCKERFILE })
      .expect(404);
  });
});

describe('launching in a guest environment', () => {
  it('lists the ready, enabled environments and boots the one picked', async () => {
    const id = await readyEnvironment();
    await t
      .admin('post', '/launchpad/environments')
      .send({ name: 'Still building', dockerfile: DOCKERFILE })
      .expect(201);
    const alice = await t.member('alice');

    const options = await t.portal(alice.cookie, 'get', '').expect(200);
    expect(options.body.environments).toEqual([
      { id, name: 'Go toolchain', description: 'Go 1.24' },
    ]);

    const run = await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ environmentId: id }))
      .expect(201);
    await settle(t.launchpad);
    expect(run.body).toMatchObject({ environmentId: id, environmentName: 'Go toolchain' });
    expect(t.driver.specs.at(-1)?.imageId).toBe(id);
  });

  it('boots the default image when none is picked', async () => {
    await readyEnvironment();
    const alice = await t.member('alice');
    const run = await t.portal(alice.cookie, 'post', '/runs').send(launchBody()).expect(201);
    await settle(t.launchpad);
    expect(run.body.environmentId).toBeNull();
    expect(t.driver.specs.at(-1)).not.toHaveProperty('imageId');
  });

  it('refuses environments that are disabled, not built or unknown', async () => {
    const id = await readyEnvironment();
    const alice = await t.member('alice');
    await t.admin('patch', `/launchpad/environments/${id}`).send({ enabled: false }).expect(200);
    const options = await t.portal(alice.cookie, 'get', '').expect(200);
    expect(options.body.environments).toEqual([]);
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ environmentId: id }))
      .expect(400);
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ environmentId: 'nope' }))
      .expect(400);

    await t.admin('patch', `/launchpad/environments/${id}`).send({ enabled: true }).expect(200);
    await t.admin('post', `/launchpad/environments/${id}/rebuild`).expect(200);
    const res = await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ environmentId: id }))
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('not ready');
  });

  it('fails a queued run whose environment went away before it started', async () => {
    const id = await readyEnvironment();
    const alice = await t.member('alice');
    await t.admin('put', '/launchpad/settings').send({
      ...t.launchpad.runs.settings(),
      maxConcurrentRuns: 1,
    });
    await t.portal(alice.cookie, 'post', '/runs').send(launchBody()).expect(201);
    const queued = await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ environmentId: id }))
      .expect(201);
    await settle(t.launchpad);
    await t.admin('delete', `/launchpad/environments/${id}`).expect(204);
    await t
      .runner(t.driver.lastConfig().runToken, 'post', '/finish')
      .send({ outcome: 'succeeded', finalMessage: null, memory: null, error: null })
      .expect(200);
    await settle(t.launchpad);
    const run = await t
      .portal(alice.cookie, 'get', `/runs/${queued.body.id as string}`)
      .expect(200);
    expect(run.body).toMatchObject({
      status: 'failed',
      statusReason: 'This guest environment is not available',
    });
    expect(t.driver.specs).toHaveLength(1);
  });

  it('keeps the environment of schedules and triggers', async () => {
    const id = await readyEnvironment();
    const alice = await t.member('alice');
    const schedule = await t
      .portal(alice.cookie, 'post', '/schedules')
      .send(launchBody({ environmentId: id, preset: 'hourly' }))
      .expect(201);
    expect(schedule.body.environmentId).toBe(id);

    const hook = await t
      .hooks(alice.cookie, 'post', '')
      .send({ name: 'issues', source: 'generic', auth: 'url' })
      .expect(201);
    const trigger = await t
      .portal(alice.cookie, 'post', '/triggers')
      .send({
        instructions: 'Label the issue',
        templateId: t.ids.template,
        harness: 'claude-code',
        webhookId: hook.body.webhook.id as string,
        environmentId: id,
      })
      .expect(201);
    expect(trigger.body.environmentId).toBe(id);
    await request(t.app)
      .post(new URL(hook.body.url as string).pathname)
      .send({ type: 'Issue' })
      .expect(200);
    await settle(t.launchpad);
    expect(t.driver.specs.map((s) => s.imageId)).toEqual([id]);

    t.clock.now = new Date(t.clock.now.getTime() + 2 * 3_600_000);
    await t.scheduler.tick();
    await settle(t.launchpad);
    expect(t.driver.specs.map((s) => s.imageId)).toEqual([id, id]);
  });
});
