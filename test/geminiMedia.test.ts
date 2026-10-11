import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createHarness, GEMINI_VIDEO_BYTES, type Harness } from './helpers.js';

const TOOL = 'gemini-media';
const BASE = `/proxy/${TOOL}/v1beta`;
const ALL = ['images:generate', 'videos:generate', 'models:read'];

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;

const adminPost = (path: string, body: object) =>
  request(app).post(`/api/admin${path}`).set('authorization', `Bearer ${admin}`).send(body);

async function keyFor(permissions: string[] = ALL, models: string[] = []): Promise<string> {
  const tpl = await adminPost('/templates', {
    name: `media ${permissions.join(' ')} ${models.join(' ')}`,
    grants: [{ tool: TOOL, permissions, resources: models }],
    defaultTtlSeconds: 600,
    maxTtlSeconds: 3600,
  }).expect(201);
  const res = await adminPost('/sessions', { templateId: tpl.body.id }).expect(201);
  return res.body.key as string;
}

const post = (key: string, path: string, body: object = {}) =>
  request(app).post(`${BASE}/${path}`).set('x-goog-api-key', key).send(body);
const get = (key: string, path: string) =>
  request(app).get(`${BASE}/${path}`).set('x-goog-api-key', key);

const lastCall = () => {
  const call = h.upstreamCalls.at(-1);
  if (!call) throw new Error('no upstream call');
  return { url: call.url, headers: new Headers(call.init.headers) };
};

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
  await adminPost('/accounts', { tool: TOOL, label: 'media', secret: 'real-media-secret' }).expect(
    201,
  );
});

describe('Gemini image & video generation', () => {
  it('is offered as a tool and verifies the API key', async () => {
    const tools = await request(app)
      .get('/api/admin/tools')
      .set('authorization', `Bearer ${admin}`)
      .expect(200);
    const media = (tools.body as { id: string; kind?: string }[]).find((t) => t.id === TOOL);
    expect(media).toBeDefined();
    await adminPost('/accounts', { tool: TOOL, label: 'bad', secret: 'bad-key' }).expect(422);
  });

  it('generates images with Imagen and Gemini image models, with the real key', async () => {
    const key = await keyFor(['images:generate']);
    await post(key, 'models/imagen-4.0-generate-001:predict', {
      instances: [{ prompt: 'a cat' }],
    }).expect(200);
    expect(lastCall().url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict',
    );
    expect(lastCall().headers.get('x-goog-api-key')).toBe('real-media-secret');
    await post(key, 'models/gemini-2.5-flash-image:generateContent', { contents: [] }).expect(200);
  });

  it('only serves each method for its own model family', async () => {
    const key = await keyFor();
    const text = await post(key, 'models/gemini-2.5-pro:generateContent', { contents: [] });
    expect(text.status).toBe(403);
    expect(text.body.message).toContain('not available');
    await post(key, 'models/gemini-2.5-flash-image:predict').expect(403);
    await post(key, 'models/imagen-4.0-generate-001:predictLongRunning').expect(403);
    await post(key, 'models/gemini-2.5-flash-image:streamGenerateContent').expect(403);
  });

  it('checks permissions and the model allowlist', async () => {
    const images = await keyFor(['images:generate'], ['imagen-4.0-*']);
    await post(images, 'models/imagen-3.0-generate-002:predict').expect(403);
    await post(images, 'models/veo-3.0-generate-001:predictLongRunning').expect(403);
    await get(images, 'models').expect(403);
    const videos = await keyFor(['videos:generate']);
    await post(videos, 'models/imagen-4.0-generate-001:predict').expect(403);
  });

  it('refuses server-side tools and API keys in the query', async () => {
    const key = await keyFor();
    await post(key, 'models/gemini-2.5-flash-image:generateContent', {
      contents: [],
      tools: [{ googleSearch: {} }],
    }).expect(403);
    await request(app)
      .post(`${BASE}/models/imagen-4.0-generate-001:predict?key=x`)
      .set('x-goog-api-key', key)
      .send({})
      .expect(403);
  });

  it('starts Veo videos, polls their operation and lists models', async () => {
    const key = await keyFor(['videos:generate', 'models:read'], ['veo-*']);
    await post(key, 'models/veo-3.0-generate-001:predictLongRunning', {
      instances: [{ prompt: 'waves' }],
    }).expect(200);
    await get(key, 'models/veo-3.0-generate-001/operations/abc123').expect(200);
    await get(key, 'models/imagen-4.0-generate-001/operations/abc123').expect(403);
    await get(key, 'models/veo-3.0-generate-001/operations').expect(403);
    await get(key, 'models?pageSize=5').expect(200);
    await get(key, 'operations/abc123').expect(403);
  });

  it('downloads videos, following redirects only within Google', async () => {
    const key = await keyFor(['videos:generate']);
    const video = await get(key, 'files/abc:download?alt=media').expect(200);
    expect(video.text).toBe(GEMINI_VIDEO_BYTES);
    expect(lastCall().url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/files/stored?alt=media',
    );
    expect(lastCall().headers.get('x-goog-api-key')).toBe('real-media-secret');

    const elsewhere = await get(key, 'files/elsewhere:download?alt=media');
    expect(elsewhere.status).toBe(302);
    expect(h.upstreamCalls.some((c) => c.url.startsWith('https://attacker.example'))).toBe(false);

    await get(key, 'files/abc:download?alt=json').expect(403);
    await get(key, 'files/abc').expect(403);
    await request(app).delete(`${BASE}/files/abc`).set('x-goog-api-key', key).expect(403);
  });
});
