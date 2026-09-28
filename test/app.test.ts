import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;

const auth = (token: string): [string, string] => ['authorization', `Bearer ${token}`];

async function setup(templateOverrides: Record<string, unknown> = {}): Promise<{
  accountId: string;
  templateId: string;
}> {
  const acc = await request(app)
    .post('/api/admin/accounts')
    .set(...auth(admin))
    .send({ tool: 'github', label: 'Personal', secret: 'ghp_realtoken' })
    .expect(201);
  const tpl = await request(app)
    .post('/api/admin/templates')
    .set(...auth(admin))
    .send({
      tool: 'github',
      name: 'Issues RO',
      permissions: ['issues:read'],
      resources: ['o/r'],
      defaultTtlSeconds: 600,
      maxTtlSeconds: 3600,
      ...templateOverrides,
    })
    .expect(201);
  return { accountId: acc.body.id as string, templateId: tpl.body.id as string };
}

async function issue(templateId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post('/api/admin/sessions')
    .set(...auth(admin))
    .send({ templateId, ...extra })
    .expect(201);
  return res.body.key as string;
}

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
});

describe('admin API', () => {
  it('requires the admin token', async () => {
    await request(app).get('/api/admin/accounts').expect(401);
    await request(app)
      .get('/api/admin/accounts')
      .set(...auth('gwa_wrong'))
      .expect(401);
    await request(app)
      .get('/api/admin/accounts')
      .set(...auth(admin))
      .expect(200, []);
  });

  it('verifies credentials and never returns secrets', async () => {
    await setup();
    const res = await request(app)
      .get('/api/admin/accounts')
      .set(...auth(admin))
      .expect(200);
    expect(res.body[0]).toMatchObject({
      label: 'Personal',
      secretHint: '…oken',
      identity: { login: 'octocat', tokenType: 'classic PAT', connectedVia: 'pasted token' },
    });
    expect(JSON.stringify(res.body)).not.toContain('ghp_realtoken');
  });

  it('rejects credentials the tool refuses', async () => {
    const res = await request(app)
      .post('/api/admin/accounts')
      .set(...auth(admin))
      .send({ tool: 'github', label: 'x', secret: 'bad-token' })
      .expect(422);
    expect(res.body.message).toMatch(/HTTP 401/);
  });

  it('validates templates', async () => {
    const base = { tool: 'github', name: 'T', defaultTtlSeconds: 600, maxTtlSeconds: 3600 };
    const post = (body: object) =>
      request(app)
        .post('/api/admin/templates')
        .set(...auth(admin))
        .send(body);
    await post({ ...base, permissions: [] }).expect(400);
    await post({ ...base, permissions: ['nope:read'] }).expect(400);
    await post({ ...base, permissions: ['issues:read'], resources: ['bad pattern'] }).expect(400);
    await post({ ...base, permissions: ['issues:read'], defaultTtlSeconds: 7200 }).expect(400);
    await post({ ...base, permissions: ['issues:read'] }).expect(201);
    await post({ ...base, permissions: ['issues:read'] }).expect(409);
  });

  it('caps session TTL at the template maximum', async () => {
    const { templateId } = await setup();
    await request(app)
      .post('/api/admin/sessions')
      .set(...auth(admin))
      .send({ templateId, ttlSeconds: 7200 })
      .expect(400);
  });
});

describe('proxy', () => {
  it('forwards allowed requests with the real credential injected', async () => {
    const { templateId } = await setup();
    const key = await issue(templateId, { label: 'agent' });
    expect(key).toMatch(/^gws_/);

    const res = await request(app)
      .get('/proxy/github/repos/o/r/issues?state=open')
      .set(...auth(key))
      .expect(200);
    expect(res.body).toEqual({
      url: 'https://api.github.com/repos/o/r/issues?state=open',
      method: 'GET',
    });
    const call = h.upstreamCalls.at(-1);
    const sent = new Headers(call?.init.headers);
    expect(sent.get('authorization')).toBe('Bearer ghp_realtoken');
    expect(sent.get('x-github-api-version')).toBe('2022-11-28');
    // Pagination links point back at the gateway; cookies are dropped.
    expect(res.headers.link).toBe(
      '<http://gateway.test/proxy/github/repos/o/r/issues?page=2>; rel="next"',
    );
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('accepts the `token` scheme used by gh / Octokit', async () => {
    const { templateId } = await setup();
    const key = await issue(templateId);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set('authorization', `token ${key}`)
      .expect(200);
  });

  it('denies requests outside the template without calling upstream', async () => {
    const { templateId } = await setup();
    const key = await issue(templateId);
    const before = h.upstreamCalls.length;
    await request(app)
      .post('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .send({})
      .expect(403);
    await request(app)
      .get('/proxy/github/repos/o/other/issues')
      .set(...auth(key))
      .expect(403);
    await request(app)
      .get('/proxy/github/repos/o/r/../x/issues')
      .set(...auth(key))
      .expect(400);
    await request(app)
      .get('/proxy/github/repos/o/r/%2e%2e/x')
      .set(...auth(key))
      .expect(400);
    await request(app)
      .get('/proxy/gitlab/repos/o/r/issues')
      .set(...auth(key))
      .expect(403);
    expect(h.upstreamCalls.length).toBe(before);
  });

  it('rejects missing, unknown, expired and revoked keys', async () => {
    const { templateId } = await setup();
    await request(app).get('/proxy/github/repos/o/r/issues').expect(401);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth('gws_nope'))
      .expect(401);

    const key = await issue(templateId, { ttlSeconds: 60 });
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .expect(200);
    h.clock.now = new Date(h.clock.now.getTime() + 61_000);
    const expired = await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .expect(401);
    expect(expired.body.message).toMatch(/expired/);

    const key2 = await issue(templateId);
    const sessions = await request(app)
      .get('/api/admin/sessions')
      .set(...auth(admin));
    const active = (sessions.body as { id: string; status: string }[]).find(
      (s) => s.status === 'active',
    );
    await request(app)
      .post(`/api/admin/sessions/${active?.id ?? ''}/revoke`)
      .set(...auth(admin))
      .expect(200);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth(key2))
      .expect(401);
  });

  it('snapshots permissions: editing a template does not widen live keys', async () => {
    const { templateId } = await setup();
    const key = await issue(templateId);
    await request(app)
      .put(`/api/admin/templates/${templateId}`)
      .set(...auth(admin))
      .send({
        tool: 'github',
        name: 'Issues RW',
        permissions: ['issues:read', 'issues:write'],
        resources: [],
        defaultTtlSeconds: 600,
        maxTtlSeconds: 3600,
      })
      .expect(200);
    await request(app)
      .post('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .send({})
      .expect(403);
  });

  it('revokes sessions when their account is removed', async () => {
    const { accountId, templateId } = await setup();
    const key = await issue(templateId);
    await request(app)
      .delete(`/api/admin/accounts/${accountId}`)
      .set(...auth(admin))
      .expect(204);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .expect(401);
  });

  it('exposes session introspection and usage stats', async () => {
    const { templateId } = await setup();
    const key = await issue(templateId);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .expect(200);
    const info = await request(app)
      .get('/api/session')
      .set(...auth(key))
      .expect(200);
    expect(info.body).toMatchObject({
      tool: 'github',
      permissions: ['issues:read'],
      resources: ['o/r'],
      proxyBaseUrl: 'http://gateway.test/proxy/github',
    });
    await h.gateway.flush();
    const list = await request(app)
      .get('/api/admin/sessions')
      .set(...auth(admin));
    expect(list.body[0]).toMatchObject({ requestCount: 1, status: 'active' });
    expect(list.body[0].keyHash).toBeUndefined();
  });
});
