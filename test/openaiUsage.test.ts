import { deepStrictEqual, ok } from 'node:assert/strict';
import { describe, it } from 'vitest';
import { totalTokens } from '../src/server/tools/llm/common.js';
import { createOpenAIProvider } from '../src/server/tools/llm/openai.js';
import type { UsageMeter } from '../src/server/tools/types.js';

const model = 'gpt-5-codex';
const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 30 },
  output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 15 },
  total_tokens: 120,
};
const expected = { model, input: 30, output: 20, cacheRead: 40, cacheWrite: 30 };

async function meter(contentType: string): Promise<UsageMeter> {
  const decision = await createOpenAIProvider().authorize(
    {
      method: 'POST',
      segments: ['v1', 'responses'],
      search: '',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: Buffer.from(JSON.stringify({ model, input: 'hi', stream: true })),
    },
    { permissions: ['llm:invoke'], resources: [] },
    { sessionId: 'test', secret: 'sk-test', tokensRemaining: 1000 },
  );
  ok(decision.allowed);
  ok(decision.meter);
  return decision.meter(contentType);
}

describe('Codex Responses token accounting', () => {
  it('counts cache reads, writes and reasoning exactly once', async () => {
    const m = await meter('application/json');
    m.write(Buffer.from(JSON.stringify({ usage })));
    const result = m.end();
    deepStrictEqual(result, expected);
    ok(result);
    deepStrictEqual(totalTokens(result), usage.total_tokens);
  });

  it('accepts usage without optional input token details', async () => {
    const m = await meter('application/json');
    m.write(Buffer.from(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20 } })));
    deepStrictEqual(m.end(), { model, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 });
  });

  it('preserves cache-read accounting when cache writes are absent', async () => {
    const m = await meter('application/json');
    m.write(
      Buffer.from(
        JSON.stringify({ usage: { ...usage, input_tokens_details: { cached_tokens: 40 } } }),
      ),
    );
    deepStrictEqual(m.end(), { model, input: 60, output: 20, cacheRead: 40, cacheWrite: 0 });
  });

  for (const type of ['response.completed', 'response.incomplete', 'response.failed']) {
    it(`meters ${type} across SSE data lines and byte chunks`, async () => {
      const m = await meter('text/event-stream; charset=utf-8');
      const event = JSON.stringify({ type, response: { usage } }, null, 2);
      const stream = Buffer.from(
        ': keepalive\r\n\r\n' +
          `event: ${type}\r\n` +
          event
            .split('\n')
            .map((line) => `data: ${line}\r\n`)
            .join('') +
          '\r\ndata: [DONE]\r\n\r\n',
      );
      for (const byte of stream) m.write(Uint8Array.of(byte));
      deepStrictEqual(m.end(), expected);
    });
  }

  it('meters the final event even without a trailing newline', async () => {
    const m = await meter('text/event-stream');
    m.write(
      Buffer.from(`data: ${JSON.stringify({ type: 'response.completed', response: { usage } })}`),
    );
    deepStrictEqual(m.end(), expected);
  });

  it('ignores malformed events while preserving subsequent usage', async () => {
    const m = await meter('text/event-stream');
    m.write(Buffer.from('data: {broken\n\ndata: {"type":"response.created"}\n\n'));
    m.write(Buffer.from(`data: ${JSON.stringify({ response: { usage } })}\n\n`));
    deepStrictEqual(m.end(), expected);
  });
});
