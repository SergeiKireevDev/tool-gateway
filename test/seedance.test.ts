import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createHarness, SEEDANCE_VIDEO_BYTES, type Harness } from './helpers.js';

const TOOL = 'seedance';
const BASE = `/proxy/${TOOL}/api/v3/contents/generations/tasks`;
const UPSTREAM = 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks';
const ALL = ['videos:generate', 'videos:read', 'videos:cancel'];
const MODEL = 'seedance-2-5-pro-261001';
const PROMPT = { type: 'text', text: 'Waves at dusk --duration 5' };

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;

const adminPost = (path: string, body: object) =>
  request(app).post(`/api/admin${path}`).set('authorization', `Bearer ${admin}`).send(body);

async function keyFor(permissions: string[] = ALL, models: string[] = []): Promise<string> {
  const tpl = await adminPost('/templates', {
    name: `seedance ${permissions.join(' ')} ${models.join(' ')}`,
    grants: [{ tool: TOOL, permissions, resources: models }],
    defaultTtlSeconds: 600,
    maxTtlSeconds: 3600,
  }).expect(201);
  const res = await adminPost('/sessions', { templateId: tpl.body.id }).expect(201);
  return res.body.key as string;
}

const create = (key: string, body: object) =>
  request(app).post(BASE).set('authorization', `Bearer ${key}`).send(body);
const get = (key: string, path = '') =>
  request(app).get(`${BASE}${path}`).set('authorization', `Bearer ${key}`);

const lastCall = () => {
  const call = h.upstreamCalls.at(-1);
  if (!call) throw new Error('no upstream call');
  return { url: call.url, headers: new Headers(call.init.headers) };
};

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
  await adminPost('/accounts', { tool: TOOL, label: 'ark', secret: 'real-ark-secret' }).expect(201);
});

describe('Seedance video generation', () => {
  it('is offered as a tool and verifies the API key', async () => {
    const tools = await request(app)
      .get('/api/admin/tools')
      .set('authorization', `Bearer ${admin}`)
      .expect(200);
    expect((tools.body as { id: string }[]).some((t) => t.id === TOOL)).toBe(true);
    await adminPost('/accounts', { tool: TOOL, label: 'bad', secret: 'bad-key' }).expect(422);
  });

  it('creates tasks with the real key', async () => {
    const key = await keyFor(['videos:generate']);
    await create(key, { model: MODEL, content: [PROMPT] }).expect(200);
    expect(lastCall().url).toBe(UPSTREAM);
    expect(lastCall().headers.get('authorization')).toBe('Bearer real-ark-secret');
    await create(key, {
      model: MODEL,
      content: [PROMPT, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    }).expect(200);
  });

  it('checks the model allowlist and only serves Seedance models', async () => {
    const key = await keyFor(['videos:generate'], ['seedance-2-5-*']);
    await create(key, { model: 'seedance-1-0-pro-250528', content: [PROMPT] }).expect(403);
    const open = await keyFor(['videos:generate']);
    const other = await create(open, { model: 'seedream-4-0-250828', content: [PROMPT] });
    expect(other.status).toBe(403);
    expect(other.body.message).toContain('not a Seedance model');
    await create(open, { content: [PROMPT] }).expect(403);
  });

  it('refuses callbacks and remote media without permission', async () => {
    const remote = { type: 'image_url', image_url: { url: 'https://example.com/a.png' } };
    const key = await keyFor(['videos:generate']);
    await create(key, {
      model: MODEL,
      content: [PROMPT],
      callback_url: 'https://attacker.example/hook',
    }).expect(403);
    await create(key, { model: MODEL, content: [PROMPT, remote] }).expect(403);
    await create(key, {
      model: MODEL,
      content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }],
    }).expect(403);
    const allowed = await keyFor(['videos:generate', 'media:remote-urls']);
    await create(allowed, { model: MODEL, content: [PROMPT, remote] }).expect(200);
  });

  it('polls, lists and cancels tasks with the matching permissions', async () => {
    const key = await keyFor(['videos:read']);
    await get(key, '/cgt-1').expect(200);
    expect(lastCall().url).toBe(`${UPSTREAM}/cgt-1`);
    await get(key, '?page_num=1&page_size=10&filter.status=succeeded').expect(200);
    await get(key, '?callback=x').expect(403);
    await get(key, '/cgt-1/other').expect(403);
    await request(app).delete(`${BASE}/cgt-1`).set('authorization', `Bearer ${key}`).expect(403);
    await create(key, { model: MODEL, content: [PROMPT] }).expect(403);

    const cancel = await keyFor(['videos:cancel']);
    await request(app).delete(`${BASE}/cgt-1`).set('authorization', `Bearer ${cancel}`).expect(200);
    await request(app).delete(BASE).set('authorization', `Bearer ${cancel}`).expect(403);
    await request(app)
      .post(`/proxy/${TOOL}/api/v3/chat/completions`)
      .set('authorization', `Bearer ${cancel}`)
      .send({})
      .expect(403);
  });

  it('downloads finished videos from BytePlus storage only', async () => {
    const key = await keyFor(['videos:read']);
    const video = await get(key, '/done/video').expect(200);
    expect(video.text).toBe(SEEDANCE_VIDEO_BYTES);
    expect(lastCall().url).toContain('.bytepluses.com/v.mp4?sig=1');
    expect(lastCall().headers.get('authorization')).toBeNull();

    const running = await get(key, '/cgt-1/video').expect(404);
    expect(running.body.error.message).toContain('status: running');
    await get(key, '/elsewhere/video').expect(404);
    expect(h.upstreamCalls.some((c) => c.url.startsWith('https://attacker.example'))).toBe(false);
    await get(key, '/done/last-frame').expect(404);
  });
});
