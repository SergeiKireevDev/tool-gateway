import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadInputs } from '../src/guest/runner.js';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

let t: LaunchHarness;
let alice: { id: string; cookie: string };

beforeEach(async () => {
  t = await createLaunchHarness();
  alice = await t.member('alice');
});

const launchBody = (extra: object = {}) => ({
  prompt: 'Summarize the open issues of o/r',
  templateId: t.ids.template,
  harness: 'claude-code',
  ...extra,
});

async function launch(cookie: string, extra: object = {}): Promise<string> {
  const res = await t.portal(cookie, 'post', '/runs').send(launchBody(extra)).expect(201);
  await settle(t.launchpad);
  return res.body.id as string;
}

/** Launches a run that writes `report.md` and `data/issues.json`, then finishes. */
async function parentRun(): Promise<string> {
  const id = await launch(alice.cookie);
  const token = t.driver.lastConfig().runToken;
  await t.runner(token, 'put', '/outputs/report.md').send('# Report').expect(204);
  await t.runner(token, 'put', '/outputs/data/issues.json').send('[1,2]').expect(204);
  await t
    .runner(token, 'post', '/finish')
    .send({ outcome: 'succeeded', finalMessage: 'done', memory: null, error: null })
    .expect(200);
  await settle(t.launchpad);
  return id;
}

describe('chained runs', () => {
  it("starts an agent from another run's output files", async () => {
    const parentId = await parentRun();
    const childId = await launch(alice.cookie, {
      prompt: 'Turn the report into slides',
      parentRunId: parentId,
    });
    const child = await t.portal(alice.cookie, 'get', `/runs/${childId}`).expect(200);
    expect(child.body.parentRunId).toBe(parentId);

    const config = t.driver.lastConfig();
    expect(config.runId).toBe(childId);
    expect(config.inputs).toEqual([
      { path: 'data/issues.json', size: 5 },
      { path: 'report.md', size: 8 },
    ]);
    expect(config.systemPrompt).toContain('## Input files');
    expect(config.systemPrompt).toContain('`/home/agent/in/report.md`');
    expect(config.systemPrompt).toContain(parentId);

    // The runner downloads them with its run token.
    const file = await t
      .runner(config.runToken, 'get', '/inputs/data/issues.json')
      .buffer(true)
      .parse((r, done) => {
        let text = '';
        r.on('data', (b: Buffer) => (text += b.toString()));
        r.on('end', () => {
          done(null, text);
        });
      })
      .expect(200);
    expect(file.body).toBe('[1,2]');
    await t.runner(config.runToken, 'get', '/inputs/nope.txt').expect(404);

    // The parent lists the runs chained after it.
    const children = await t
      .portal(alice.cookie, 'get', `/runs?parentRunId=${parentId}`)
      .expect(200);
    expect((children.body as { id: string }[]).map((r) => r.id)).toEqual([childId]);
  });

  it('gives runs that are not chained no inputs', async () => {
    await launch(alice.cookie);
    const config = t.driver.lastConfig();
    expect(config.inputs).toBeUndefined();
    expect(config.systemPrompt).not.toContain('## Input files');
    await t.runner(config.runToken, 'get', '/inputs/report.md').expect(404);
  });

  it("refuses to chain after another member's run", async () => {
    const parentId = await parentRun();
    const bob = await t.member('bob');
    await t
      .portal(bob.cookie, 'post', '/runs')
      .send(launchBody({ parentRunId: parentId }))
      .expect(404);
  });

  it('refuses to chain after a run that is going or left no files', async () => {
    const going = await launch(alice.cookie);
    await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ parentRunId: going }))
      .expect(409);
    await t
      .runner(t.driver.lastConfig().runToken, 'post', '/finish')
      .send({ outcome: 'succeeded', finalMessage: null, memory: null, error: null })
      .expect(200);
    await settle(t.launchpad);
    const res = await t
      .portal(alice.cookie, 'post', '/runs')
      .send(launchBody({ parentRunId: going }))
      .expect(400);
    expect(res.body.message).toMatch(/no output files/);
  });

  it('shows the chain to the admin too', async () => {
    const parentId = await parentRun();
    const childId = await launch(alice.cookie, { parentRunId: parentId });
    const res = await t.admin('get', `/launchpad/runs?parentRunId=${parentId}`).expect(200);
    expect((res.body as { id: string }[]).map((r) => r.id)).toEqual([childId]);
  });
});

describe('runner inputs', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('downloads the input files and keeps them inside the input directory', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'in-'));
    const fetched: string[] = [];
    const problems = await downloadInputs(
      [
        { path: 'data/issues.json', size: 5 },
        { path: '../escape.txt', size: 1 },
      ],
      dir,
      {
        downloadInput: async (rel, file) => {
          fetched.push(rel);
          const { writeFile } = await import('node:fs/promises');
          await writeFile(file, '[1,2]');
        },
      },
    );
    expect(fetched).toEqual(['data/issues.json']);
    expect(readFileSync(path.join(dir, 'data/issues.json'), 'utf8')).toBe('[1,2]');
    expect(problems).toEqual(['skipped input ../escape.txt (invalid path)']);
  });

  it('reports the files it could not download', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'in-'));
    const problems = await downloadInputs([{ path: 'report.md', size: 8 }], dir, {
      downloadInput: () => Promise.reject(new Error('HTTP 404')),
    });
    expect(problems).toEqual(['could not download input report.md: HTTP 404']);
  });
});
