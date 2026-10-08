import { beforeEach, describe, expect, it } from 'vitest';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

let t: LaunchHarness;

beforeEach(async () => {
  t = await createLaunchHarness();
});

describe('service boxes', () => {
  it('lists images, launches, lists and stops services (admin only)', async () => {
    const images = await t.admin('get', '/launchpad/services/images').expect(200);
    expect(images.body).toEqual([{ name: 'echo', ports: [8080] }]);

    const res = await t
      .admin('post', '/launchpad/services')
      .send({ image: 'echo', publish: [{ port: 8080, hostPort: 18080 }] })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'echo',
      image: 'echo',
      vcpus: 1,
      memMib: 1024,
      agentAccess: false,
      publish: [{ port: 8080, hostPort: 18080 }],
      ports: [8080],
      running: true,
    });
    const listed = await t.admin('get', '/launchpad/services').expect(200);
    expect(listed.body).toHaveLength(1);
    const activity = await t.admin('get', '/activity').expect(200);
    expect(JSON.stringify(activity.body)).toContain('Started service box \\"echo\\"');

    await t.admin('delete', `/launchpad/services/${res.body.serviceId as string}`).expect(204);
    expect(t.serviceDriver.services.size).toBe(0);

    const alice = await t.member('alice');
    await t.portal(alice.cookie, 'get', '/services').expect(404);
  });

  it('validates launches', async () => {
    const bad = [
      { image: 'Bad Name' },
      { image: 'echo', name: 'x'.repeat(41) },
      { image: 'echo', publish: [{ port: 8080, hostPort: 80 }] },
      {
        image: 'echo',
        publish: [
          { port: 1, hostPort: 2000 },
          { port: 2, hostPort: 2000 },
        ],
      },
      { image: 'echo', vcpus: 99 },
      { image: 'echo', agentAccess: true },
    ];
    for (const body of bad) {
      await t.admin('post', '/launchpad/services').send(body).expect(400);
    }
  });

  it('tells agents about the services open to them', async () => {
    await t
      .admin('post', '/launchpad/services')
      .send({ image: 'echo', name: 'private', publish: [{ port: 8080, hostPort: 18080 }] })
      .expect(201);
    await t
      .admin('post', '/launchpad/services')
      .send({
        image: 'echo',
        name: 'shared-db',
        agentAccess: true,
        publish: [{ port: 8080, hostPort: 18081 }],
      })
      .expect(201);
    const alice = await t.member('alice');
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send({ prompt: 'Use the db', templateId: t.ids.template, harness: 'claude-code' })
      .expect(201);
    await settle(t.launchpad);
    const prompt = t.driver.lastConfig().systemPrompt;
    expect(prompt).toContain('`shared-db` at `172.30.0.1:18081`');
    expect(prompt).not.toContain('private');
  });

  it('launches runs without listing services when vmd can not list them', async () => {
    t.serviceDriver.listServices = () => Promise.reject(new Error('vmd down'));
    const alice = await t.member('alice');
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send({ prompt: 'Work', templateId: t.ids.template, harness: 'claude-code' })
      .expect(201);
    await settle(t.launchpad);
    expect(t.driver.lastConfig().systemPrompt).not.toContain('service boxes');
  });
});
