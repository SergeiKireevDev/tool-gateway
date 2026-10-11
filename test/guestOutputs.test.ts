import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { statusReason, uploadOutputs } from '../src/guest/runner.js';
import { RUNNER_LIMITS } from '../src/server/launchpad/protocol.js';

const VIDEO_BYTES = 17_200_000;

describe('runner outputs', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('uploads generated videos of tens of MiB', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'out-'));
    truncateSync(writeAndReturn(path.join(dir, 'video.mp4')), VIDEO_BYTES);
    const uploaded: [string, number][] = [];
    const problems = await uploadOutputs(dir, {
      uploadOutput: (rel, content) => {
        uploaded.push([rel, content.length]);
        return Promise.resolve();
      },
    });
    expect(problems).toEqual([]);
    expect(uploaded).toEqual([['video.mp4', VIDEO_BYTES]]);
  });

  it('reports files over the per-file limit instead of dropping them silently', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'out-'));
    writeFileSync(path.join(dir, 'report.md'), 'hello');
    truncateSync(writeAndReturn(path.join(dir, 'huge.bin')), RUNNER_LIMITS.outputFileBytes + 1);
    const uploaded: string[] = [];
    const problems = await uploadOutputs(dir, {
      uploadOutput: (rel) => {
        uploaded.push(rel);
        return Promise.resolve();
      },
    });
    expect(uploaded).toEqual(['report.md']);
    expect(problems).toEqual([expect.stringMatching(/^skipped huge\.bin \(.*per-file limit\)$/)]);
    expect(statusReason(null, problems)).toMatch(
      /^Some files in \/home\/agent\/out were not kept: skipped huge\.bin/,
    );
  });

  it('keeps the status reason within what the gateway accepts', () => {
    expect(statusReason(null, [])).toBeNull();
    expect(statusReason('claude-code exited with code 1', [])).toBe(
      'claude-code exited with code 1',
    );
    const many = Array.from({ length: 5000 }, (_, i) => `skipped file-${i} (too many files)`);
    expect(statusReason('boom', many)?.length).toBe(RUNNER_LIMITS.eventText);
  });
});

function writeAndReturn(file: string): string {
  writeFileSync(file, '');
  return file;
}
