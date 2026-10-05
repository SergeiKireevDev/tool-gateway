import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createHarness, FAKE_LLM_TOTAL, type Harness } from './helpers.js';

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;
let keyCount = 0;
let connected: Set<string>;

const adminPost = (path: string, body: object) =>
  request(app).post(`/api/admin${path}`).set('authorization', `Bearer ${admin}`).send(body);

/** Connects an account for the provider and issues a key from a one-grant template. */
async function keyFor(
  tool: string,
  opts: { permissions?: string[]; models?: string[]; tokenBudget?: number } = {},
): Promise<string> {
  keyCount += 1;
  if (!connected.has(tool)) {
    connected.add(tool);
    await adminPost('/accounts', { tool, label: tool, secret: `real-${tool}-secret` }).expect(201);
  }
  const tpl = await adminPost('/templates', {
    name: `${tool} agents ${keyCount}`,
    grants: [
      { tool, permissions: opts.permissions ?? ['llm:invoke'], resources: opts.models ?? [] },
    ],
    defaultTtlSeconds: 600,
    maxTtlSeconds: 3600,
  }).expect(201);
  const res = await adminPost('/sessions', {
    templateId: tpl.body.id,
    ...(opts.tokenBudget ? { tokenBudget: opts.tokenBudget } : {}),
  }).expect(201);
  return res.body.key as string;
}

const lastCall = () => {
  const call = h.upstreamCalls.at(-1);
  if (!call) throw new Error('no upstream call');
  return {
    url: call.url,
    headers: new Headers(call.init.headers),
    body: call.init.body
      ? (JSON.parse(Buffer.from(call.init.body as Buffer).toString('utf8')) as Record<
          string,
          unknown
        >)
      : null,
  };
};

const introspect = async (key: string): Promise<{ id: string; tokensRemaining: number | null }> =>
  (await request(app).get('/api/session').set('authorization', `Bearer ${key}`).expect(200))
    .body as { id: string; tokensRemaining: number | null };

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
  connected = new Set();
});

describe('LLM accounts', () => {
  it('verifies API keys against the provider', async () => {
    await adminPost('/accounts', { tool: 'anthropic', label: 'x', secret: 'bad-key' }).expect(422);
    await adminPost('/accounts', { tool: 'gemini', label: 'x', secret: 'AIza-ok' }).expect(201);
  });

  it('lists LLM providers in the catalog with model allowlists', async () => {
    const tools = await request(app)
      .get('/api/admin/tools')
      .set('authorization', `Bearer ${admin}`)
      .expect(200);
    const ids = (tools.body as { id: string }[]).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['anthropic', 'openai', 'gemini']));
  });
});

describe('Anthropic', () => {
  const messages = (key: string, body: object, header = 'x-api-key') =>
    request(app)
      .post('/proxy/anthropic/v1/messages?beta=true')
      .set(header, header === 'authorization' ? `Bearer ${key}` : key)
      .set('anthropic-version', '2023-06-01')
      .send({ model: 'claude-sonnet-5', max_tokens: 4096, messages: [], ...body });

  it('swaps the session key for the API key and meters usage', async () => {
    const key = await keyFor('anthropic', { models: ['claude-sonnet-*'], tokenBudget: 1000 });
    await messages(key, {}).expect(200);
    const call = lastCall();
    expect(call.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    expect(call.headers.get('x-api-key')).toBe('real-anthropic-secret');
    expect(call.headers.get('authorization')).toBeNull();
    expect(call.body?.max_tokens).toBe(1000);
    expect((await introspect(key)).tokensRemaining).toBe(1000 - FAKE_LLM_TOTAL);
  });

  it('accepts the key as a bearer token and meters streams', async () => {
    const key = await keyFor('anthropic', { tokenBudget: 10_000 });
    const res = await messages(key, { stream: true }, 'authorization').expect(200);
    expect(res.text).toContain('message_delta');
    expect((await introspect(key)).tokensRemaining).toBe(10_000 - FAKE_LLM_TOTAL);
  });

  it('denies models outside the allowlist and spent budgets', async () => {
    // The first call is capped to 150 output tokens but uses 165 in all: the budget is spent.
    const key = await keyFor('anthropic', { models: ['claude-haiku-*'], tokenBudget: 150 });
    const denied = await messages(key, {}).expect(403);
    expect(denied.headers['x-gateway-denied']).toBe('true');
    expect(denied.body.message).toContain('allowlist');
    await messages(key, { model: 'claude-haiku-4-5' }).expect(200);
    await messages(key, { model: 'claude-haiku-4-5' }).expect(403);
  });

  it('keeps extended thinking valid when capping, and refuses when too little is left', async () => {
    const key = await keyFor('anthropic', { tokenBudget: 3000 });
    await messages(key, { thinking: { type: 'enabled', budget_tokens: 4000 } }).expect(200);
    expect(lastCall().body).toMatchObject({ max_tokens: 3000, thinking: { budget_tokens: 2999 } });
    const small = await keyFor('anthropic', { tokenBudget: 1000 });
    await messages(small, { thinking: { type: 'enabled', budget_tokens: 2000 } }).expect(403);
  });

  it('needs a permission for server-side tools', async () => {
    const key = await keyFor('anthropic');
    const webFetch = { tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] };
    await messages(key, webFetch).expect(403);
    await messages(key, { mcp_servers: [{ url: 'https://evil.example' }] }).expect(403);
    await messages(key, {
      tools: [
        { name: 'f', input_schema: {} },
        { type: 'bash_20250124', name: 'bash' },
      ],
    }).expect(200);
    const open = await keyFor('anthropic', { permissions: ['llm:invoke', 'llm:server-tools'] });
    await messages(open, webFetch).expect(200);
  });

  it('denies unknown endpoints and query strings', async () => {
    const key = await keyFor('anthropic');
    await request(app).post('/proxy/anthropic/v1/files').set('x-api-key', key).send({}).expect(403);
    await request(app)
      .post('/proxy/anthropic/v1/messages?x=1')
      .set('x-api-key', key)
      .send({ model: 'm', max_tokens: 1 })
      .expect(403);
    await request(app).get('/proxy/anthropic/v1/models').set('x-api-key', key).expect(403);
  });
});

describe('OpenAI', () => {
  it('meters streamed responses and caps output tokens', async () => {
    const key = await keyFor('openai', { tokenBudget: 500 });
    await request(app)
      .post('/proxy/openai/v1/responses')
      .set('authorization', `Bearer ${key}`)
      .send({ model: 'gpt-5', input: 'hi', stream: true, max_output_tokens: 9000 })
      .expect(200);
    expect(lastCall().headers.get('authorization')).toBe('Bearer real-openai-secret');
    expect(lastCall().body?.max_output_tokens).toBe(500);
    expect((await introspect(key)).tokensRemaining).toBe(500 - FAKE_LLM_TOTAL);
  });

  it('asks streamed chat completions for usage', async () => {
    const key = await keyFor('openai', { tokenBudget: 500 });
    await request(app)
      .post('/proxy/openai/v1/chat/completions')
      .set('authorization', `Bearer ${key}`)
      .send({ model: 'gpt-5', messages: [], stream: true, max_tokens: 9000 })
      .expect(200);
    expect(lastCall().body).toMatchObject({
      stream_options: { include_usage: true },
      max_completion_tokens: 500,
    });
    expect(lastCall().body).not.toHaveProperty('max_tokens');
    expect((await introspect(key)).tokensRemaining).toBe(500 - FAKE_LLM_TOTAL);
  });

  it('needs a permission for hosted tools', async () => {
    const key = await keyFor('openai');
    await request(app)
      .post('/proxy/openai/v1/responses')
      .set('authorization', `Bearer ${key}`)
      .send({ model: 'gpt-5', input: 'hi', tools: [{ type: 'mcp', server_url: 'https://x' }] })
      .expect(403);
    await request(app)
      .post('/proxy/openai/v1/responses')
      .set('authorization', `Bearer ${key}`)
      .send({ model: 'gpt-5', input: 'hi', tools: [{ type: 'function', name: 'f' }] })
      .expect(200);
  });
});

describe('Gemini', () => {
  const generate = (key: string, model: string, search = '?alt=sse') =>
    request(app)
      .post(`/proxy/gemini/v1beta/models/${model}:streamGenerateContent${search}`)
      .set('x-goog-api-key', key)
      .send({ contents: [], generationConfig: { maxOutputTokens: 8192 } });

  it('checks the model in the path, caps output and meters streams', async () => {
    const key = await keyFor('gemini', { models: ['gemini-2.5-*'], tokenBudget: 300 });
    await generate(key, 'gemini-2.5-pro').expect(200);
    expect(lastCall().headers.get('x-goog-api-key')).toBe('real-gemini-secret');
    expect(lastCall().body).toMatchObject({ generationConfig: { maxOutputTokens: 300 } });
    expect((await introspect(key)).tokensRemaining).toBe(300 - FAKE_LLM_TOTAL);
    await generate(key, 'gemini-1.5-pro').expect(403);
  });

  it('refuses keys in the query string and unknown methods', async () => {
    const key = await keyFor('gemini');
    await generate(key, 'gemini-2.5-pro', `?key=${key}`).expect(403);
    await request(app)
      .post('/proxy/gemini/v1beta/models/gemini-2.5-pro:embedContent')
      .set('x-goog-api-key', key)
      .send({})
      .expect(403);
    await request(app)
      .post('/proxy/gemini/v1beta/models/gemini-2.5-pro:generateContent')
      .set('x-goog-api-key', key)
      .send({ contents: [], tools: [{ googleSearch: {} }] })
      .expect(403);
  });
});

describe('usage', () => {
  it('sums usage per model for a set of sessions', async () => {
    const key = await keyFor('anthropic');
    await request(app)
      .post('/proxy/anthropic/v1/messages')
      .set('x-api-key', key)
      .send({ model: 'claude-sonnet-5', max_tokens: 10, messages: [] })
      .expect(200);
    const { id } = await introspect(key);
    expect(h.gateway.llmUsage.byModel([id])).toEqual([
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        calls: 1,
        total: FAKE_LLM_TOTAL,
      }),
    ]);
    expect(h.gateway.llmUsage.totalsFor([]).total).toBe(0);
  });
});
