import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it } from 'vitest';
import { MIB, OUTPUT_CHUNK_BYTES, RUNNER_LIMITS } from '../src/server/launchpad/protocol.js';
import { createLaunchHarness, type LaunchHarness, settle } from './launchpadHelpers.js';

let t: LaunchHarness;
let cookie = '';
let runId = '';
let runToken = '';

beforeEach(async () => {
  t = await createLaunchHarness();
  ({ cookie } = await t.member('alice'));
  const res = await t
    .portal(cookie, 'post', '/runs')
    .send({ prompt: 'Make a video', templateId: t.ids.template, harness: 'claude-code' })
    .expect(201);
  await settle(t.launchpad);
  runId = res.body.id as string;
  runToken = t.driver.lastConfig().runToken;
});

const chunkCount = (): number =>
  (t.db.sql.prepare('SELECT COUNT(*) AS n FROM run_output_chunks').get() as { n: number }).n;

/** A file larger than two chunks, with bytes that differ from chunk to chunk. */
function bigFile(): Buffer {
  const content = Buffer.alloc(2 * OUTPUT_CHUNK_BYTES + MIB);
  for (let i = 0; i < content.length; i += 1) content[i] = (i * 31 + (i >> 20)) % 256;
  return content;
}

async function download(path: string): Promise<Buffer> {
  const res = await t
    .portal(cookie, 'get', `/runs/${runId}/outputs/${path}`)
    .buffer(true)
    .parse((r, done) => {
      const parts: Buffer[] = [];
      r.on('data', (b: Buffer) => parts.push(b));
      r.on('end', () => {
        done(null, Buffer.concat(parts));
      });
    })
    .expect(200);
  expect(res.headers['content-length']).toBe(String(res.body.length));
  return res.body as Buffer;
}

describe('run output files', () => {
  it('stores large files in chunks and downloads them intact', async () => {
    const content = bigFile();
    await t.runner(runToken, 'put', '/outputs/video.mp4').send(content).expect(204);
    expect(chunkCount()).toBe(3);
    expect((await download('video.mp4')).equals(content)).toBe(true);
    expect(t.launchpad.runs.require(runId).outputsBytes).toBe(content.length);
  });

  it('replaces a file and its chunks when it is uploaded again', async () => {
    await t.runner(runToken, 'put', '/outputs/video.mp4').send(bigFile()).expect(204);
    await t.runner(runToken, 'put', '/outputs/video.mp4').send('short').expect(204);
    expect(chunkCount()).toBe(1);
    expect((await download('video.mp4')).toString()).toBe('short');
    expect(t.launchpad.runs.require(runId).outputsBytes).toBe('short'.length);
  });

  it('refuses files over the per-file limit before reading them', async () => {
    const server = http.createServer(t.vmApp);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port,
          method: 'PUT',
          path: '/runner/outputs/huge.bin',
          headers: {
            authorization: `Bearer ${runToken}`,
            'content-length': String(RUNNER_LIMITS.outputFileBytes + 1),
          },
        });
        req.on('response', (res) => {
          resolve(res.statusCode);
          req.destroy();
        });
        req.on('error', reject);
        req.flushHeaders();
      });
      expect(status).toBe(400);
    } finally {
      server.close();
    }
    expect(t.launchpad.runs.outputs(runId)).toEqual([]);
  });

  it('drops a partial upload that goes over the run total', async () => {
    t.db.sql
      .prepare('UPDATE runs SET outputs_bytes = ? WHERE id = ?')
      .run(RUNNER_LIMITS.outputTotalBytes - MIB, runId);
    const run = t.launchpad.runs.require(runId);
    await expect(t.launchpad.reportOutput(run, 'video.mp4', [bigFile()])).rejects.toThrow(
      'Output files exceed the run total',
    );
    expect(chunkCount()).toBe(0);
    expect(t.launchpad.runs.outputs(runId)).toEqual([]);
  });

  it('still reads files stored before chunking', async () => {
    t.db.sql
      .prepare(
        `INSERT INTO run_outputs (run_id, path, size, content, created_at, expires_at)
         VALUES (?, 'old.md', 3, ?, '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')`,
      )
      .run(runId, Buffer.from('old'));
    expect(t.launchpad.runs.output(runId, 'old.md')?.toString()).toBe('old');
    expect((await download('old.md')).toString()).toBe('old');
  });

  it('purges the chunks of expired files and of abandoned uploads', async () => {
    await t.runner(runToken, 'put', '/outputs/a.txt').send('kept until it expires').expect(204);
    t.launchpad.runs.putOutputChunk(runId, 'abandoned', 0, Buffer.from('partial'));
    await t
      .runner(runToken, 'post', '/finish')
      .send({ outcome: 'succeeded', finalMessage: null, memory: null, error: null })
      .expect(200);
    expect(chunkCount()).toBe(2);

    const now = t.clock.now.getTime();
    const days = (n: number): string => new Date(now + n * 86_400_000).toISOString();
    t.launchpad.runs.purgeExpiredOutputs(days(2));
    expect(chunkCount()).toBe(1);
    expect(t.launchpad.runs.output(runId, 'a.txt')?.toString()).toBe('kept until it expires');

    t.launchpad.runs.purgeExpiredOutputs(days(365));
    expect(chunkCount()).toBe(0);
    expect(t.launchpad.runs.outputs(runId)).toEqual([]);
  });
});
