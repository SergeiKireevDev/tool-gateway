import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createHarness, FAL_FILE_BYTES, type Harness } from './helpers.js';

const TOOL = 'fal';
const BASE = `/proxy/${TOOL}`;
const UPSTREAM = 'https://queue.fal.run';
const ALL = ['requests:submit', 'requests:read', 'requests:cancel'];
const ENDPOINT = '/fal-ai/flux/dev';
const REQUEST = '/fal-ai/flux/requests/req-1';
const PROMPT = { prompt: 'Waves at dusk' };
const FILE = 'https://v3.fal.media/files/rabbit/abc.png';

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;

const adminPost = (path: string, body: object) =>
  request(app).post(`/api/admin${path}`).set('authorization', `Bearer ${admin}`).send(body);

async function keyFor(permissions: string[] = ALL, endpoints: string[] = []): Promise<string> {
  const tpl = await adminPost('/templates', {
    name: `fal ${permissions.join(' ')} ${endpoints.join(' ')}`,
    grants: [{ tool: TOOL, permissions, resources: endpoints }],
    defaultTtlSeconds: 600,
    maxTtlSeconds: 3600,
  }).expect(201);
  const res = await adminPost('/sessions', { templateId: tpl.body.id }).expect(201);
  return res.body.key as string;
}

const submit = (key: string, body: object, path = ENDPOINT) =>
  request(app).post(`${BASE}${path}`).set('authorization', `Key ${key}`).send(body);
const get = (key: string, path: string) =>
  request(app).get(`${BASE}${path}`).set('authorization', `Bearer ${key}`);
const put = (key: string, path: string) =>
  request(app).put(`${BASE}${path}`).set('authorization', `Bearer ${key}`);

const lastCall = () => {
  const call = h.upstreamCalls.at(-1);
  if (!call) throw new Error('no upstream call');
  return { url: call.url, method: call.init.method, headers: new Headers(call.init.headers) };
};

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
  await adminPost('/accounts', { tool: TOOL, label: 'fal', secret: 'real-fal-secret' }).expect(201);
});

describe('fal.ai', () => {
  it('is offered as a tool and verifies the API key', async () => {
    const tools = await request(app)
      .get('/api/admin/tools')
      .set('authorization', `Bearer ${admin}`)
      .expect(200);
    expect((tools.body as { id: string }[]).some((t) => t.id === TOOL)).toBe(true);
    await adminPost('/accounts', { tool: TOOL, label: 'bad', secret: 'bad-key' }).expect(422);
  });

  it('queues requests with the real key', async () => {
    const key = await keyFor(['requests:submit']);
    await submit(key, PROMPT)
      .set('x-fal-queue-priority', 'low')
      .set('x-fal-target-url', 'https://attacker.example/')
      .expect(200);
    expect(lastCall().url).toBe(`${UPSTREAM}${ENDPOINT}`);
    expect(lastCall().headers.get('authorization')).toBe('Key real-fal-secret');
    expect(lastCall().headers.get('x-fal-queue-priority')).toBe('low');
    expect(lastCall().headers.get('x-fal-target-url')).toBeNull();
    await submit(key, PROMPT, '/workflows/acme/pipeline').expect(200);
    await submit(key, { ...PROMPT, image_url: 'data:image/png;base64,AAAA' }).expect(200);
    await submit(key, { ...PROMPT, image_urls: [FILE] }).expect(200);
  });

  it('checks the endpoint allowlist', async () => {
    const key = await keyFor(['requests:submit'], ['fal-ai/flux/*']);
    await submit(key, PROMPT).expect(200);
    const other = await submit(key, PROMPT, '/fal-ai/kling-video/v2/text-to-video');
    expect(other.status).toBe(403);
    expect(other.body.message).toContain('not in the allowlist');
    await submit(key, PROMPT, '/fal-ai').expect(403);
    await submit(key, PROMPT, '/workflows/fal-ai').expect(403);
  });

  it('refuses webhooks and remote media without permission', async () => {
    const remote = { ...PROMPT, image: { url: 'https://example.com/a.png' } };
    const key = await keyFor(['requests:submit']);
    const hook = await submit(key, PROMPT, `${ENDPOINT}?fal_webhook=https://attacker.example/`);
    expect(hook.status).toBe(403);
    expect(hook.body.message).toContain('Webhooks');
    await submit(key, remote).expect(403);
    await submit(key, { ...PROMPT, video_url: 'ftp://example.com/a.mp4' }).expect(403);
    await submit(key, { ...PROMPT, image_url: 'https://fal.media.attacker.example/a.png' }).expect(
      403,
    );
    const allowed = await keyFor(['requests:submit', 'media:remote-urls']);
    await submit(allowed, remote).expect(200);
  });

  it('polls, reads and cancels requests with the matching permissions', async () => {
    const key = await keyFor(['requests:read']);
    await get(key, `${REQUEST}/status?logs=1`).expect(200);
    expect(lastCall().url).toBe(`${UPSTREAM}${REQUEST}/status?logs=1`);
    await get(key, REQUEST).expect(200);
    await get(key, `${REQUEST}/status/stream`).expect(200);
    await get(key, `${REQUEST}/status?other=1`).expect(403);
    await get(key, `${REQUEST}/other`).expect(403);
    await put(key, `${REQUEST}/cancel`).expect(403);
    await submit(key, PROMPT).expect(403);

    const cancel = await keyFor(['requests:cancel']);
    await put(cancel, `${REQUEST}/cancel`).expect(200);
    expect(lastCall().method).toBe('PUT');
    await get(cancel, REQUEST).expect(403);
    await request(app)
      .delete(`${BASE}${REQUEST}`)
      .set('authorization', `Bearer ${cancel}`)
      .expect(403);
  });

  it("downloads files from fal's storage only, without the API key", async () => {
    const key = await keyFor(['requests:read']);
    const file = await get(key, `/files?url=${encodeURIComponent(FILE)}`).expect(200);
    expect(file.text).toBe(FAL_FILE_BYTES);
    expect(lastCall().url).toBe(FILE);
    expect(lastCall().headers.get('authorization')).toBeNull();

    const before = h.upstreamCalls.length;
    for (const url of [
      'https://attacker.example/a.png',
      'http://v3.fal.media/files/a.png',
      'https://user:pw@fal.media/a.png',
      'https://storage.googleapis.com/other-bucket/a.png',
    ]) {
      await get(key, `/files?url=${encodeURIComponent(url)}`).expect(403);
    }
    await get(key, '/files').expect(403);
    expect(h.upstreamCalls.length).toBe(before);
    const none = await keyFor(['requests:submit']);
    await get(none, `/files?url=${encodeURIComponent(FILE)}`).expect(403);
  });
});
