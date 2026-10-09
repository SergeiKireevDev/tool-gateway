import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createHarness, FAKE_LLM_TOTAL, type Harness } from './helpers.js';

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;

const TOKEN = 'custom-endpoint-token';
const BASE = 'https://llm.example.com/base';

const adminCall = (method: 'get' | 'post' | 'put', path: string, body?: object) => {
  const req = request(app)[method](`/api/admin${path}`).set('authorization', `Bearer ${admin}`);
  return body ? req.send(body) : req;
};

const template = (endpoint: object, extra: object = {}) => ({
  name: 'Custom model agents',
  grants: [{ tool: 'custom', permissions: ['llm:invoke'], resources: [], endpoint, ...extra }],
  defaultTtlSeconds: 600,
  maxTtlSeconds: 3600,
});

async function keyFrom(templateId: string, tokenBudget?: number): Promise<string> {
  const res = await adminCall('post', '/sessions', {
    templateId,
    ...(tokenBudget ? { tokenBudget } : {}),
  }).expect(201);
  return res.body.key as string;
}

const lastCall = () => {
  const call = h.upstreamCalls.at(-1);
  if (!call) throw new Error('no upstream call');
  return {
    url: call.url,
    headers: new Headers(call.init.headers),
    body: JSON.parse(Buffer.from(call.init.body as Buffer).toString('utf8')) as Record<
      string,
      unknown
    >,
  };
};

const chat = (key: string, model = 'llama-4') =>
  request(app)
    .post('/proxy/custom/v1/chat/completions')
    .set('authorization', `Bearer ${key}`)
    .send({ model, messages: [] });

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
});

describe('custom LLM templates', () => {
  it('is in the catalog as a model API configured in templates', async () => {
    const tools = await adminCall('get', '/tools').expect(200);
    const custom = (tools.body as { id: string; kind: string; endpointApis: unknown }[]).find(
      (t) => t.id === 'custom',
    );
    expect(custom).toMatchObject({ kind: 'llm', endpointApis: ['openai', 'anthropic'] });
    await adminCall('post', '/accounts', { tool: 'custom', label: 'x', secret: 'y' }).expect(422);
  });

  it('stores the endpoint but never returns its token', async () => {
    const created = await adminCall(
      'post',
      '/templates',
      template({ url: `${BASE}/`, api: 'openai', token: TOKEN }),
    ).expect(201);
    expect(created.body.grants[0].endpoint).toEqual({ url: BASE, api: 'openai', hasToken: true });
    const listed = await adminCall('get', '/templates').expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(TOKEN);

    const key = await keyFrom(created.body.id as string);
    const sessions = await adminCall('get', '/sessions').expect(200);
    expect(JSON.stringify(sessions.body)).not.toContain(TOKEN);
    const introspect = await request(app)
      .get('/api/session')
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    expect(JSON.stringify(introspect.body)).not.toContain(TOKEN);
    expect(introspect.body.grants[0]).toMatchObject({ tool: 'custom', kind: 'llm' });
  });

  it('requires a valid endpoint for custom grants, and only for them', async () => {
    await adminCall('post', '/templates', template({ url: 'ftp://x', api: 'openai' })).expect(400);
    await adminCall(
      'post',
      '/templates',
      template({ url: 'https://user:pw@llm.example.com', api: 'openai' }),
    ).expect(400);
    await adminCall('post', '/templates', template({ url: BASE, api: 'gemini' })).expect(400);
    const missing = template({});
    delete (missing.grants[0] as { endpoint?: object }).endpoint;
    await adminCall('post', '/templates', missing).expect(400);
    await adminCall('post', '/templates', {
      ...template({}),
      grants: [
        { tool: 'github', permissions: ['contents:read'], endpoint: { url: BASE, api: 'openai' } },
      ],
    }).expect(400);
  });

  it('keeps the token when an edit leaves it out', async () => {
    const created = await adminCall(
      'post',
      '/templates',
      template({ url: BASE, api: 'openai', token: TOKEN }),
    ).expect(201);
    const id = created.body.id as string;
    const edited = await adminCall(
      'put',
      `/templates/${id}`,
      template({ url: BASE, api: 'openai' }),
    ).expect(200);
    expect(edited.body.grants[0].endpoint.hasToken).toBe(true);
    await chat(await keyFrom(id)).expect(200);
    expect(lastCall().headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });
});

describe('custom LLM proxy', () => {
  it('forwards OpenAI-style calls to the endpoint with its token, checking models and budget', async () => {
    const created = await adminCall(
      'post',
      '/templates',
      template({ url: BASE, api: 'openai', token: TOKEN }, { resources: ['llama-*'] }),
    ).expect(201);
    const key = await keyFrom(created.body.id as string, 1000);
    await chat(key).expect(200);
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/v1/chat/completions`);
    expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call.body.max_completion_tokens).toBe(1000);
    const session = await request(app)
      .get('/api/session')
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    expect(session.body.tokensRemaining).toBe(1000 - FAKE_LLM_TOTAL);

    const denied = await chat(key, 'gpt-5').expect(403);
    expect(denied.body.message).toContain('allowlist');
    await request(app)
      .post('/proxy/custom/v1/messages')
      .set('authorization', `Bearer ${key}`)
      .send({ model: 'llama-4', messages: [] })
      .expect(403);
  });

  it('forwards Anthropic-style calls, accepting the key as x-api-key', async () => {
    const created = await adminCall(
      'post',
      '/templates',
      template({ url: BASE, api: 'anthropic', token: TOKEN }),
    ).expect(201);
    const key = await keyFrom(created.body.id as string);
    await request(app)
      .post('/proxy/custom/v1/messages')
      .set('x-api-key', key)
      .set('anthropic-version', '2023-06-01')
      .send({ model: 'qwen-3', max_tokens: 256, messages: [] })
      .expect(200);
    const call = lastCall();
    expect(call.url).toBe(`${BASE}/v1/messages`);
    expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call.headers.get('x-api-key')).toBeNull();
    expect(call.headers.get('anthropic-version')).toBe('2023-06-01');
  });

  it('sends no credential to endpoints without a token', async () => {
    const created = await adminCall('post', '/templates', template({ url: BASE, api: 'openai' }));
    await chat(await keyFrom(created.body.id as string)).expect(200);
    expect(lastCall().headers.get('authorization')).toBeNull();
  });

  it('keeps the endpoint a key was issued with when the template changes', async () => {
    const created = await adminCall(
      'post',
      '/templates',
      template({ url: BASE, api: 'openai', token: TOKEN }),
    ).expect(201);
    const id = created.body.id as string;
    const key = await keyFrom(id);
    await adminCall(
      'put',
      `/templates/${id}`,
      template({ url: 'https://llm.example.com/other', api: 'openai', token: 'new-token' }),
    ).expect(200);
    await chat(key).expect(200);
    expect(lastCall().url).toBe(`${BASE}/v1/chat/completions`);
    expect(lastCall().headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });
});
