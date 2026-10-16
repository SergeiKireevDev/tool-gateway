import { beforeEach, describe, expect, it } from 'vitest';
import type request from 'supertest';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

let t: LaunchHarness;
let alice: { id: string; cookie: string };

beforeEach(async () => {
  t = await createLaunchHarness();
  alice = await t.member('alice');
});

const launchBody = (extra: object = {}) => ({
  prompt: 'Review the attached spec',
  templateId: t.ids.template,
  harness: 'claude-code',
  ...extra,
});

async function upload(cookie: string, name: string, content: string): Promise<string> {
  const res = await t
    .portal(cookie, 'put', `/attachments/${name}`)
    .set('content-type', 'application/octet-stream')
    .send(Buffer.from(content))
    .expect(201);
  return res.body.id as string;
}

async function launch(cookie: string, extra: object = {}): Promise<string> {
  const res = await t.portal(cookie, 'post', '/runs').send(launchBody(extra)).expect(201);
  await settle(t.launchpad);
  return res.body.id as string;
}

const asText = (test: request.Test): request.Test =>
  test.buffer(true).parse((r, done) => {
    let text = '';
    r.on('data', (b: Buffer) => (text += b.toString()));
    r.on('end', () => {
      done(null, text);
    });
  });

async function finish(): Promise<void> {
  await t
    .runner(t.driver.lastConfig().runToken, 'post', '/finish')
    .send({ outcome: 'failed', finalMessage: null, memory: null, error: 'boom' })
    .expect(200);
  await settle(t.launchpad);
}

describe('relaunching a run', () => {
  it("gives the new run the original run's attached files again", async () => {
    const spec = await upload(alice.cookie, 'spec.md', '# Spec');
    const data = await upload(alice.cookie, 'data.csv', 'a,b');
    const firstId = await launch(alice.cookie, { attachmentIds: [spec, data] });
    await finish();

    // An uploaded file replaces the original one of the same name.
    const newer = await upload(alice.cookie, 'spec.md', '# Spec v2');
    const againId = await launch(alice.cookie, {
      attachmentsFrom: firstId,
      attachmentIds: [newer],
    });
    const config = t.driver.lastConfig();
    expect(config.runId).toBe(againId);
    expect(config.inputs).toEqual([
      { path: 'data.csv', size: 3 },
      { path: 'spec.md', size: 9 },
    ]);
    const copied = await asText(t.runner(config.runToken, 'get', '/inputs/data.csv')).expect(200);
    expect(copied.body).toBe('a,b');
    const replaced = await asText(t.runner(config.runToken, 'get', '/inputs/spec.md')).expect(200);
    expect(replaced.body).toBe('# Spec v2');

    // The original run keeps its files.
    const original = await asText(
      t.portal(alice.cookie, 'get', `/runs/${firstId}/attachments/spec.md`),
    ).expect(200);
    expect(original.body).toBe('# Spec');
    const listed = await t.portal(alice.cookie, 'get', `/runs/${againId}/attachments`).expect(200);
    expect((listed.body as { name: string }[]).map((a) => a.name)).toEqual(['data.csv', 'spec.md']);
  });

  it("refuses the attached files of another member's run", async () => {
    const spec = await upload(alice.cookie, 'spec.md', '# Spec');
    const firstId = await launch(alice.cookie, { attachmentIds: [spec] });
    const bob = await t.member('bob');
    await t
      .portal(bob.cookie, 'post', '/runs')
      .send(launchBody({ attachmentsFrom: firstId }))
      .expect(404);
  });

  it("keeps a webhook-triggered run's instructions, with the event as the task", async () => {
    const runId = await launch(alice.cookie, {
      prompt: '{"action":"opened"}',
      instructions: 'Label the new issue',
    });
    const config = t.driver.lastConfig();
    expect(config.systemPrompt).toContain('## Instructions');
    expect(config.systemPrompt).toContain('Label the new issue');
    const run = await t.portal(alice.cookie, 'get', `/runs/${runId}`).expect(200);
    expect(run.body).toMatchObject({
      prompt: '{"action":"opened"}',
      instructions: 'Label the new issue',
      triggerId: null,
    });
  });
});
