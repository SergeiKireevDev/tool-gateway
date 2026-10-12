import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { RunEvent, RunnerFinishBody } from '../server/launchpad/protocol.js';
import { RUNNER_LIMITS } from '../server/launchpad/protocol.js';
import type { EventDraft } from './harnesses.js';

const FLUSH_INTERVAL_MS = 1000;
const FLUSH_AT_EVENTS = 100;
const RETRIES = 5;
const RETRY_BASE_MS = 500;
const HTTP_SERVER_ERROR = 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Sends the runner's reports to the gateway (`/runner/*`, run token): transcript events in
 * batches, output files, and the final result. Retries transient failures.
 */
export class Reporter {
  private seq = 0;
  private queue: RunEvent[] = [];
  private flushing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly gatewayUrl: string,
    private readonly runToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  push(draft: EventDraft): void {
    this.queue.push({ ...draft, seq: this.seq, at: this.now().toISOString() });
    this.seq += 1;
    if (this.queue.length >= FLUSH_AT_EVENTS) void this.flush();
  }

  /** Sends queued events; batches go out one at a time, in order. */
  flush(): Promise<void> {
    this.flushing = this.flushing
      .then(async () => {
        while (this.queue.length > 0) {
          const batch = this.queue.slice(0, RUNNER_LIMITS.batchEvents);
          await this.send(
            'POST',
            '/runner/events',
            JSON.stringify({ events: batch }),
            'application/json',
          );
          this.queue = this.queue.slice(batch.length);
        }
      })
      .catch((err: unknown) => {
        console.error('runner: could not report events', err);
      });
    return this.flushing;
  }

  /** Uploads an output file, streamed from disk (files reach 1 GiB, more than a VM may hold). */
  async uploadOutput(relativePath: string, file: string): Promise<void> {
    const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
    await this.send(
      'PUT',
      `/runner/outputs/${encoded}`,
      () => Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
      'application/octet-stream',
    );
  }

  /**
   * Downloads an input file of a chained run (an output file of its parent) to `file`, streamed to
   * disk.
   */
  async downloadInput(relativePath: string, file: string): Promise<void> {
    const encoded = relativePath.split('/').map(encodeURIComponent).join('/');
    const res = await this.fetchImpl(`${this.gatewayUrl}/runner/inputs/${encoded}`, {
      headers: { authorization: `Bearer ${this.runToken}` },
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(
      Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>),
      createWriteStream(file, { mode: 0o600 }),
    );
  }

  async finish(body: RunnerFinishBody): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
    await this.send('POST', '/runner/finish', JSON.stringify(body), 'application/json');
  }

  private async send(
    method: string,
    path: string,
    body: string | (() => ReadableStream<Uint8Array>),
    type: string,
  ): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.gatewayUrl}${path}`, {
          method,
          headers: { authorization: `Bearer ${this.runToken}`, 'content-type': type },
          // A stream is consumed by one attempt: each retry opens a fresh one.
          ...(typeof body === 'string' ? { body } : { body: body(), duplex: 'half' }),
        });
        if (res.ok) return;
        const text = await res.text();
        // Client errors won't get better by retrying.
        if (res.status < HTTP_SERVER_ERROR)
          throw new PermanentError(`${method} ${path}: HTTP ${res.status} ${text}`);
        lastError = new Error(`${method} ${path}: HTTP ${res.status}`);
      } catch (err) {
        if (err instanceof PermanentError) throw err;
        lastError = err;
      }
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

class PermanentError extends Error {}
