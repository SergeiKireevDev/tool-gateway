import { createHmac } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { Webhooks } from '../src/server/webhooks.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;

const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');
/** An HS256 JWT like monday.com apps send. */
function jwt(secret: string, claims: object, alg = 'HS256'): string {
  const head = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const asAdmin = (method: 'get' | 'post' | 'delete', path: string) =>
  request(app)[method](`/api/admin/webhooks${path}`).set('authorization', `Bearer ${admin}`);

async function create(body: object): Promise<{ id: string; path: string; bearerSecret?: string }> {
  const res = await asAdmin('post', '').send(body).expect(201);
  const url = new URL(res.body.url as string);
  return {
    id: res.body.webhook.id as string,
    path: url.pathname,
    bearerSecret: res.body.bearerSecret as string | undefined,
  };
}

const deliver = (path: string, payload: object | string, authorization?: string) => {
  const req = request(app).post(path).set('content-type', 'application/json');
  if (authorization) req.set('authorization', authorization);
  return req.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
};

const nowSeconds = () => Math.floor(h.clock.now.getTime() / 1000);

beforeEach(async () => {
  h = await createHarness();
  const webhooks = new Webhooks(
    h.store,
    h.crypto,
    h.db,
    h.gateway.activity,
    h.config.publicUrl,
    () => h.clock.now,
  );
  app = createApp(h.gateway, h.config, { fetch: h.fetch, webhooks });
  admin = await h.gateway.rotateAdminToken();
});

describe('webhook addresses', () => {
  it('accepts deliveries on the address only, and logs them', async () => {
    const hook = await create({ name: 'board', source: 'monday', auth: 'url' });
    expect(hook.path).toMatch(/^\/hooks\/[\w-]{43}$/);
    await deliver(hook.path, {
      event: { type: 'update_column_value', boardId: 1, token: 'gws_leak123' },
    }).expect(200);
    await deliver('/hooks/not-the-address', { event: {} }).expect(404);
    const events = await asAdmin('get', `/${hook.id}/events`).expect(200);
    expect(events.body).toEqual([
      expect.objectContaining({ accepted: true, eventType: 'update_column_value' }),
    ]);
    expect(JSON.stringify(events.body)).not.toContain('leak123');
    const list = await asAdmin('get', '').expect(200);
    expect(list.body[0]).toMatchObject({ name: 'board', auth: 'url', accepted: 1, rejected: 0 });
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash|hooks\//);
  });

  it('rotates the address', async () => {
    const hook = await create({ name: 'g', source: 'generic', auth: 'url' });
    const rotated = await asAdmin('post', `/${hook.id}/rotate`).expect(200);
    await deliver(hook.path, {}).expect(404);
    await deliver(new URL(rotated.body.url as string).pathname, {}).expect(200);
  });

  it('answers monday.com’s challenge, and rejects bodies that are not JSON', async () => {
    const hook = await create({ name: 'm', source: 'monday', auth: 'jwt', signingSecret: 'shh' });
    const res = await deliver(hook.path, { challenge: 'abc123' }).expect(200);
    expect(res.body).toEqual({ challenge: 'abc123' });
    await deliver(hook.path, 'not json').expect(400);
  });
});

describe('Authorization checks', () => {
  it('verifies HS256 JWTs signed with the signing secret', async () => {
    const hook = await create({ name: 'm', source: 'monday', auth: 'jwt', signingSecret: 'shh' });
    const valid = jwt('shh', { exp: nowSeconds() + 60, iat: nowSeconds() });
    await deliver(hook.path, { event: { type: 'create_item' } }, valid).expect(200);
    await deliver(hook.path, { event: {} }, `Bearer ${valid}`).expect(200);
    await deliver(hook.path, { event: {} }).expect(401);
    await deliver(hook.path, { event: {} }, jwt('wrong', { exp: nowSeconds() + 60 })).expect(401);
    await deliver(hook.path, { event: {} }, jwt('shh', { exp: nowSeconds() - 3600 })).expect(401);
    await deliver(hook.path, { event: {} }, jwt('shh', {}, 'none')).expect(401);
    await deliver(hook.path, { event: {} }, 'a.b').expect(401);
    const events = (await asAdmin('get', `/${hook.id}/events`).expect(200)).body as {
      accepted: boolean;
      reason: string | null;
    }[];
    expect(events.filter((e) => e.accepted)).toHaveLength(2);
    expect(events.map((e) => e.reason)).toEqual(
      expect.arrayContaining([
        'Missing Authorization token',
        'Invalid token signature',
        'Expired token',
        'Unsupported token algorithm',
      ]),
    );
    expect(JSON.stringify((await asAdmin('get', '').expect(200)).body)).not.toContain('shh');
  });

  it('checks bearer secrets, shown once', async () => {
    const hook = await create({ name: 'ci', source: 'generic', auth: 'bearer' });
    expect(hook.bearerSecret).toMatch(/^gwk_/);
    await deliver(hook.path, { type: 'build' }, `Bearer ${hook.bearerSecret ?? ''}`).expect(200);
    await deliver(hook.path, { type: 'build' }, 'Bearer gwk_wrong').expect(401);
    await deliver(hook.path, { type: 'build' }).expect(401);
  });

  it('rate-limits each webhook', async () => {
    const hook = await create({ name: 'busy', source: 'generic', auth: 'url' });
    for (let i = 0; i < 120; i++) await deliver(hook.path, {}).expect(200);
    await deliver(hook.path, {}).expect(429);
    h.clock.now = new Date(h.clock.now.getTime() + 61_000);
    await deliver(hook.path, {}).expect(200);
  });
});

describe('signed bodies (Linear, GitHub)', () => {
  const sign = (secret: string, body: string) =>
    createHmac('sha256', secret).update(body).digest('hex');
  const post = (path: string, body: string, headers: Record<string, string>) => {
    const req = request(app).post(path).set('content-type', 'application/json');
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req.send(body);
  };

  it('verifies Linear-Signature and a fresh webhookTimestamp', async () => {
    const hook = await create({
      name: 'linear',
      source: 'linear',
      auth: 'hmac',
      signingSecret: 'lin_wh_secret',
    });
    const fresh = JSON.stringify({
      type: 'Issue',
      action: 'create',
      webhookTimestamp: h.clock.now.getTime(),
    });
    await post(hook.path, fresh, { 'linear-signature': sign('lin_wh_secret', fresh) }).expect(200);
    await post(hook.path, fresh, { 'linear-signature': sign('other', fresh) }).expect(401);
    await post(hook.path, fresh, {}).expect(401);
    const tampered = fresh.replace('create', 'remove');
    await post(hook.path, tampered, { 'linear-signature': sign('lin_wh_secret', fresh) }).expect(
      401,
    );
    const old = JSON.stringify({
      type: 'Issue',
      action: 'create',
      webhookTimestamp: h.clock.now.getTime() - 120_000,
    });
    await post(hook.path, old, { 'linear-signature': sign('lin_wh_secret', old) }).expect(401);
    const events = (await asAdmin('get', `/${hook.id}/events`).expect(200)).body as {
      accepted: boolean;
      eventType: string | null;
      reason: string | null;
    }[];
    expect(events.find((e) => e.accepted)?.eventType).toBe('Issue.create');
    expect(events.map((e) => e.reason)).toEqual(
      expect.arrayContaining([
        'Invalid body signature',
        'Missing body signature',
        'Stale or missing webhookTimestamp',
      ]),
    );
  });

  it('verifies X-Hub-Signature-256 and logs the GitHub event', async () => {
    const hook = await create({
      name: 'gh',
      source: 'github',
      auth: 'hmac',
      signingSecret: 'gh-secret',
    });
    const body = JSON.stringify({ action: 'opened', number: 1 });
    await post(hook.path, body, {
      'x-hub-signature-256': `sha256=${sign('gh-secret', body)}`,
      'x-github-event': 'pull_request',
    }).expect(200);
    await post(hook.path, body, { 'x-hub-signature-256': sign('gh-secret', body) }).expect(401);
    const events = (await asAdmin('get', `/${hook.id}/events`).expect(200)).body as {
      eventType: string | null;
    }[];
    expect(events.at(-1)?.eventType).toBe('pull_request.opened');
  });

  it('can be given its signing secret after creation (Linear shows it only then)', async () => {
    const hook = await create({ name: 'linear', source: 'linear', auth: 'url' });
    await request(app)
      .put(`/api/admin/webhooks/${hook.id}/auth`)
      .set('authorization', `Bearer ${admin}`)
      .send({ auth: 'hmac', signingSecret: 'later' })
      .expect(200);
    const body = JSON.stringify({
      type: 'Issue',
      action: 'update',
      webhookTimestamp: h.clock.now.getTime(),
    });
    await post(hook.path, body, {}).expect(401);
    await post(hook.path, body, { 'linear-signature': sign('later', body) }).expect(200);
  });

  it('only offers signed bodies for senders whose signature it knows', async () => {
    await asAdmin('post', '')
      .send({ name: 'x', source: 'monday', auth: 'hmac', signingSecret: 's' })
      .expect(400);
  });
});

describe('ownership', () => {
  it('lets members manage only their own webhooks', async () => {
    const tpl = await request(app)
      .post('/api/admin/templates')
      .set('authorization', `Bearer ${admin}`)
      .send({
        name: 't',
        grants: [{ tool: 'github', permissions: ['issues:read'], resources: [] }],
        defaultTtlSeconds: 600,
        maxTtlSeconds: 600,
      })
      .expect(201);
    const cookie = async (name: string): Promise<string> => {
      await request(app)
        .post('/api/admin/members')
        .set('authorization', `Bearer ${admin}`)
        .send({ name, email: `${name}@example.com`, templateIds: [tpl.body.id] })
        .expect(201);
      const identity = h.gateway.identify(`${name}@example.com`);
      if (identity?.role !== 'member') throw new Error('no member');
      return `gw_session=${(await h.gateway.createWebSession(identity)).token}`;
    };
    const alice = await cookie('alice');
    const bob = await cookie('bob');
    const portal = (c: string, method: 'get' | 'post' | 'delete', path: string) =>
      request(app)
        [method](`/api/me/webhooks${path}`)
        .set('cookie', c)
        .set('x-gateway-request', '1');
    const mine = await portal(alice, 'post', '')
      .send({ name: 'mine', source: 'monday', auth: 'url' })
      .expect(201);
    const id = mine.body.webhook.id as string;
    expect(mine.body.webhook.ownerMemberId).not.toBeNull();
    expect((await portal(bob, 'get', '').expect(200)).body).toEqual([]);
    await portal(bob, 'get', `/${id}/events`).expect(404);
    await portal(bob, 'delete', `/${id}`).expect(404);
    expect((await asAdmin('get', '').expect(200)).body).toHaveLength(1);
    await portal(alice, 'delete', `/${id}`).expect(204);
  });
});
