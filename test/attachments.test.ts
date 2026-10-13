import { beforeEach, describe, expect, it } from 'vitest';
import type request from 'supertest';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

let t: LaunchHarness;
let alice: { id: string; cookie: string };

beforeEach(async () => {
  t = await createLaunchHarness();
  alice = await t.member('alice');
});

const HOUR_MS = 3_600_000;

const launchBody = (extra: object = {}) => ({
  prompt: 'Review the attached spec',
  templateId: t.ids.template,
  harness: 'claude-code',
  ...extra,
});

/** Uploads a file for a launch to come; returns its attachment id. */
async function upload(cookie: string, name: string, content: string): Promise<string> {
  const res = await t
    .portal(cookie, 'put', `/attachments/${name}`)
    .set('content-type', 'application/octet-stream')
    .send(Buffer.from(content))
    .expect(201);
  expect(res.body).toMatchObject({ name, size: content.length, runId: null });
  return res.body.id as string;
}

async function launch(cookie: string, extra: object = {}): Promise<string> {
  const res = await t.portal(cookie, 'post', '/runs').send(launchBody(extra)).expect(201);
  await settle(t.launchpad);
  return res.body.id as string;
}

/** Reads a streamed file response as text. */
const asText = (test: request.Test): request.Test =>
  test.buffer(true).parse((r, done) => {
    let text = '';
    r.on('data', (b: Buffer) => (text += b.toString()));
    r.on('end', () => {
      done(null, text);
    });
  });

describe('launch attachments', () => {
  it('copies the files attached to a launch to the agent', async () => {
    const spec = await upload(alice.cookie, 'spec.md', '# Spec');
    const data = await upload(alice.cookie, 'data.csv', 'a,b\n1,2');
    const runId = await launch(alice.cookie, { attachmentIds: [spec, data] });

    const config = t.driver.lastConfig();
    expect(config.inputs).toEqual([
      { path: 'data.csv', size: 7 },
      { path: 'spec.md', size: 6 },
    ]);
    expect(config.systemPrompt).toContain('## Input files');
    expect(config.systemPrompt).toContain('attached these files');
    expect(config.systemPrompt).toContain('`/home/agent/in/spec.md`');
    expect(config.systemPrompt).not.toContain('chained after');

    // The runner downloads them with its run token.
    const file = await asText(t.runner(config.runToken, 'get', '/inputs/spec.md')).expect(200);
    expect(file.body).toBe('# Spec');

    // The run lists them, and the member and the admin can download them.
    const listed = await t.portal(alice.cookie, 'get', `/runs/${runId}/attachments`).expect(200);
    expect((listed.body as { name: string }[]).map((a) => a.name)).toEqual(['data.csv', 'spec.md']);
    const download = await asText(
      t.portal(alice.cookie, 'get', `/runs/${runId}/attachments/data.csv`),
    ).expect(200);
    expect(download.body).toBe('a,b\n1,2');
    await t.admin('get', `/launchpad/runs/${runId}/attachments`).expect(200);
    await t.portal(alice.cookie, 'get', `/runs/${runId}/attachments/nope.txt`).expect(404);
  });

  it('gives an attachment to one launch only', async () => {
    const spec = await upload(alice.cookie, 'spec.md', '# Spec');
    await launch(alice.cookie, { attachmentIds: [spec] });
    const res = await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ attachmentIds: [spec] }))
      .expect(400);
    expect(res.body.message).toMatch(/already launched with/);
    // Nor can it be deleted any more: it belongs to the run.
    await t.portal(alice.cookie, 'delete', `/attachments/${spec}`).expect(404);
  });

  it("refuses other members' attachments, and hides other members' runs' files", async () => {
    const spec = await upload(alice.cookie, 'spec.md', '# Spec');
    const bob = await t.member('bob');
    await t
      .portal(bob.cookie, 'post', '/runs')
      .send(launchBody({ attachmentIds: [spec] }))
      .expect(400);
    await t.portal(bob.cookie, 'delete', `/attachments/${spec}`).expect(404);

    const runId = await launch(alice.cookie, { attachmentIds: [spec] });
    await t.portal(bob.cookie, 'get', `/runs/${runId}/attachments`).expect(404);
    await t.portal(bob.cookie, 'get', `/runs/${runId}/attachments/spec.md`).expect(404);
  });

  it('refuses file names that are not plain names, and two files of the same name', async () => {
    await t
      .portal(alice.cookie, 'put', '/attachments/..')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('x'))
      .expect((res) => {
        expect(res.status).toBeGreaterThanOrEqual(400);
      });
    await t
      .portal(alice.cookie, 'put', `/attachments/${encodeURIComponent('my file.txt')}`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('x'))
      .expect(400);
    const one = await upload(alice.cookie, 'notes.txt', 'one');
    const two = await upload(alice.cookie, 'notes.txt', 'two');
    const res = await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ attachmentIds: [one, two] }))
      .expect(400);
    expect(res.body.message).toMatch(/same name/);
  });

  it('lets the member delete an attachment before launching', async () => {
    const spec = await upload(alice.cookie, 'spec.md', '# Spec');
    await t.portal(alice.cookie, 'delete', `/attachments/${spec}`).expect(204);
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ attachmentIds: [spec] }))
      .expect(400);
  });

  it('caps the files waiting for a launch', async () => {
    for (let i = 0; i < 20; i++) await upload(alice.cookie, `f${String(i)}.txt`, 'x');
    const res = await t
      .portal(alice.cookie, 'put', '/attachments/one-more.txt')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('x'))
      .expect(400);
    expect(res.body.message).toMatch(/can wait for a launch/);
  });

  it('adds attachments to a chained run, replacing parent files of the same name', async () => {
    const parentId = await launch(alice.cookie);
    const token = t.driver.lastConfig().runToken;
    await t.runner(token, 'put', '/outputs/report.md').send('# Old').expect(204);
    await t.runner(token, 'put', '/outputs/data.json').send('[1]').expect(204);
    await t
      .runner(token, 'post', '/finish')
      .send({ outcome: 'succeeded', finalMessage: 'done', memory: null, error: null })
      .expect(200);
    await settle(t.launchpad);

    const report = await upload(alice.cookie, 'report.md', '# New report');
    await launch(alice.cookie, { parentRunId: parentId, attachmentIds: [report] });
    const config = t.driver.lastConfig();
    expect(config.inputs).toEqual([
      { path: 'report.md', size: 12 },
      { path: 'data.json', size: 3 },
    ]);
    expect(config.systemPrompt).toContain('attached these files');
    expect(config.systemPrompt).toContain('chained after');
    const file = await asText(t.runner(config.runToken, 'get', '/inputs/report.md')).expect(200);
    expect(file.body).toBe('# New report');
  });

  it('deletes attachments left unlaunched for a day', async () => {
    const spec = await upload(alice.cookie, 'spec.md', '# Spec');
    t.clock.now = new Date(t.clock.now.getTime() + 25 * HOUR_MS);
    await t.launchpad.reap();
    const cookie = await t.cookieFor('alice');
    await t
      .portal(cookie, 'post', '/runs')
      .send(launchBody({ attachmentIds: [spec] }))
      .expect(400);
  });

  it('keeps the attachments of a run like its output files', async () => {
    const spec = await upload(alice.cookie, 'spec.md', '# Spec');
    const runId = await launch(alice.cookie, { attachmentIds: [spec] });
    await t
      .runner(t.driver.lastConfig().runToken, 'post', '/finish')
      .send({ outcome: 'succeeded', finalMessage: 'done', memory: null, error: null })
      .expect(200);
    await settle(t.launchpad);

    t.clock.now = new Date(t.clock.now.getTime() + 25 * HOUR_MS);
    await t.launchpad.reap();
    const listed = await t.admin('get', `/launchpad/runs/${runId}/attachments`).expect(200);
    expect(listed.body).toHaveLength(1);

    const days = t.launchpad.runs.settings().outputRetentionDays;
    t.clock.now = new Date(t.clock.now.getTime() + days * 24 * HOUR_MS);
    await t.launchpad.reap();
    const purged = await t.admin('get', `/launchpad/runs/${runId}/attachments`).expect(200);
    expect(purged.body).toEqual([]);
  });

  it('uploads a file in parts, larger than one request carries', async () => {
    const MIB = 1024 * 1024;
    const started = await t
      .portal(alice.cookie, 'post', '/attachments')
      .send({ name: 'big.bin' })
      .expect(201);
    const id = started.body.id as string;
    const parts = `/attachments/${id}/parts`;
    const first = Buffer.alloc(32 * MIB, 'a');
    const second = Buffer.from('tail');
    const put = (offset: number, part: Buffer) =>
      t
        .portal(alice.cookie, 'put', `${parts}?offset=${String(offset)}`)
        .set('content-type', 'application/octet-stream')
        .send(part);

    // A part larger than 32 MiB is refused; so is one at another offset than the size received.
    await put(0, Buffer.alloc(32 * MIB + 1)).expect(400);
    expect((await put(0, first).expect(200)).body).toEqual({ received: first.length });
    const res = await put(0, second).expect(409);
    expect(res.body.message).toMatch(`offset ${String(first.length)}`);
    await put(first.length, second).expect(200);

    // Not launchable until complete.
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ attachmentIds: [id] }))
      .expect(400);
    const done = await t.portal(alice.cookie, 'post', `/attachments/${id}/complete`).expect(200);
    expect(done.body).toMatchObject({ id, name: 'big.bin', size: first.length + second.length });
    await put(first.length + second.length, second).expect(404);

    await launch(alice.cookie, { attachmentIds: [id] });
    const config = t.driver.lastConfig();
    expect(config.inputs).toEqual([{ path: 'big.bin', size: first.length + second.length }]);
    const file = await t
      .runner(config.runToken, 'get', '/inputs/big.bin')
      .buffer(true)
      .parse((r, cb) => {
        const got: Buffer[] = [];
        r.on('data', (b: Buffer) => got.push(b));
        r.on('end', () => {
          cb(null, Buffer.concat(got));
        });
      })
      .expect(200);
    expect(Buffer.compare(file.body as Buffer, Buffer.concat([first, second]))).toBe(0);
  });

  it('keeps uploads in parts to their member, and lets them be dropped', async () => {
    const bob = await t.member('bob');
    const started = await t
      .portal(alice.cookie, 'post', '/attachments')
      .send({ name: 'notes.txt' })
      .expect(201);
    const id = started.body.id as string;
    await t
      .portal(bob.cookie, 'put', `/attachments/${id}/parts?offset=0`)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('x'))
      .expect(404);
    await t.portal(bob.cookie, 'post', `/attachments/${id}/complete`).expect(404);
    await t.portal(bob.cookie, 'delete', `/attachments/${id}`).expect(404);
    await t.portal(alice.cookie, 'delete', `/attachments/${id}`).expect(204);
    await t.portal(alice.cookie, 'post', `/attachments/${id}/complete`).expect(404);
    await t.portal(alice.cookie, 'post', '/attachments').send({ name: '..' }).expect(400);
  });

  it('gives runs launched without attachments no inputs', async () => {
    await launch(alice.cookie);
    expect(t.driver.lastConfig().inputs).toBeUndefined();
  });
});
