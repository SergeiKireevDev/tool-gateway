import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;
let ids: { acc1: string; acc2: string; tplRead: string; tplWrite: string };

const bearer = (token: string): [string, string] => ['authorization', `Bearer ${token}`];
const adminPost = (path: string, body: object) =>
  request(app)
    .post(`/api/admin${path}`)
    .set(...bearer(admin))
    .send(body);

async function createMember(overrides: object = {}): Promise<{ key: string; id: string }> {
  const res = await adminPost('/members', {
    name: 'ci-bot',
    templateIds: [ids.tplRead],
    accountIds: [ids.acc1],
    ...overrides,
  }).expect(201);
  return { key: res.body.key as string, id: res.body.member.id as string };
}

const template = (name: string, permissions: string[]) => ({
  name,
  grants: [{ tool: 'github', permissions, resources: ['o/r'] }],
  defaultTtlSeconds: 600,
  maxTtlSeconds: 3600,
});

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
  const acc = (label: string) =>
    adminPost('/accounts', { tool: 'github', label, secret: `ghp_${label}` }).expect(201);
  const tpl = (name: string, perms: string[]) =>
    adminPost('/templates', template(name, perms)).expect(201);
  ids = {
    acc1: (await acc('one')).body.id,
    acc2: (await acc('two')).body.id,
    tplRead: (await tpl('read', ['issues:read'])).body.id,
    tplWrite: (await tpl('write', ['issues:read', 'issues:write'])).body.id,
  };
});

describe('member keys (admin side)', () => {
  it('creates a member whose key is shown once and never listed', async () => {
    const { key } = await createMember();
    expect(key).toMatch(/^gwm_/);
    const list = await request(app)
      .get('/api/admin/members')
      .set(...bearer(admin))
      .expect(200);
    expect(list.body[0]).toMatchObject({
      name: 'ci-bot',
      templateIds: [ids.tplRead],
      accountIds: [ids.acc1],
      activeSessions: 0,
      expired: false,
    });
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(list.body[0].keyHash).toBeUndefined();
  });

  it('validates members', async () => {
    await adminPost('/members', { name: 'x', templateIds: [], accountIds: [ids.acc1] }).expect(400);
    await adminPost('/members', {
      name: 'x',
      templateIds: ['nope'],
      accountIds: [ids.acc1],
    }).expect(400);
    await adminPost('/members', {
      name: 'x',
      templateIds: [ids.tplRead],
      accountIds: [ids.acc1],
      expiresAt: '2020-01-01T00:00:00Z',
    }).expect(400);
    await createMember();
    await adminPost('/members', {
      name: 'CI-BOT',
      templateIds: [ids.tplRead],
      accountIds: [ids.acc1],
    }).expect(409);
  });

  it('requires the admin to manage members', async () => {
    const { key } = await createMember();
    await request(app)
      .get('/api/admin/members')
      .set(...bearer(key))
      .expect(401);
    await request(app).get('/api/admin/members').expect(401);
  });
});

describe('member keys (self-serve)', () => {
  it('shows a member only what it may request', async () => {
    const { key } = await createMember();
    const res = await request(app)
      .get('/api/member')
      .set(...bearer(key))
      .expect(200);
    expect(res.body.name).toBe('ci-bot');
    expect((res.body.templates as { id: string }[]).map((t) => t.id)).toEqual([ids.tplRead]);
    expect(res.body.accounts).toEqual([
      { id: ids.acc1, tool: 'github', label: 'one', login: 'octocat', owned: false },
    ]);
  });

  it('issues a usable session key within the allowlists', async () => {
    const { key } = await createMember();
    // accountId omitted: exactly one allowed account for the tool
    const res = await request(app)
      .post('/api/sessions')
      .set(...bearer(key))
      .send({ templateId: ids.tplRead, ttlSeconds: 300, label: 'job 42' })
      .expect(201);
    expect(res.body.key).toMatch(/^gws_/);
    expect(res.body.session).toMatchObject({
      grants: [{ tool: 'github', accountId: ids.acc1 }],
      issuedBy: { kind: 'member', memberName: 'ci-bot' },
    });
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...bearer(res.body.key as string))
      .expect(200);
    const sent = new Headers(h.upstreamCalls.at(-1)?.init.headers);
    expect(sent.get('authorization')).toBe('Bearer ghp_one');
  });

  it('refuses templates and accounts outside the allowlists', async () => {
    const { key } = await createMember();
    const issue = (body: object) =>
      request(app)
        .post('/api/sessions')
        .set(...bearer(key))
        .send(body);
    await issue({ templateId: ids.tplWrite }).expect(403);
    await issue({ templateId: 'does-not-exist' }).expect(403);
    await issue({ templateId: ids.tplRead, accountId: ids.acc2 }).expect(403);
    await issue({ templateId: ids.tplRead, ttlSeconds: 7200 }).expect(400);
  });

  it('asks for an account when several are allowed', async () => {
    const { key } = await createMember({ accountIds: [ids.acc1, ids.acc2] });
    const res = await request(app)
      .post('/api/sessions')
      .set(...bearer(key))
      .send({ templateId: ids.tplRead })
      .expect(400);
    expect(res.body.message).toMatch(/exactly one in accountIds/);
    await request(app)
      .post('/api/sessions')
      .set(...bearer(key))
      .send({ templateId: ids.tplRead, accountId: ids.acc2 })
      .expect(201);
  });

  it('only accepts member keys on member endpoints', async () => {
    const { key } = await createMember();
    const issued = await request(app)
      .post('/api/sessions')
      .set(...bearer(key))
      .send({ templateId: ids.tplRead })
      .expect(201);
    await request(app)
      .get('/api/member')
      .set(...bearer(admin))
      .expect(401);
    await request(app)
      .get('/api/member')
      .set(...bearer(issued.body.key as string))
      .expect(401);
    await request(app)
      .get('/api/member')
      .set(...bearer('gwm_forged'))
      .expect(401);
    await request(app).get('/api/member').expect(401);
    // Other /api paths are unaffected by member auth.
    await request(app).get('/api/unknown').expect(404);
  });

  it('lets a member list and revoke only its own session keys', async () => {
    const a = await createMember();
    const b = await createMember({ name: 'other-bot' });
    const issue = (key: string) =>
      request(app)
        .post('/api/sessions')
        .set(...bearer(key))
        .send({ templateId: ids.tplRead });
    const mine = await issue(a.key).expect(201);
    const theirs = await issue(b.key).expect(201);
    await adminPost('/sessions', { templateId: ids.tplRead, accountId: ids.acc1 }).expect(201);

    const list = await request(app)
      .get('/api/sessions')
      .set(...bearer(a.key))
      .expect(200);
    expect((list.body as { id: string }[]).map((s) => s.id)).toEqual([mine.body.session.id]);

    await request(app)
      .post(`/api/sessions/${theirs.body.session.id as string}/revoke`)
      .set(...bearer(a.key))
      .expect(404);
    await request(app)
      .post(`/api/sessions/${mine.body.session.id as string}/revoke`)
      .set(...bearer(a.key))
      .expect(200);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...bearer(mine.body.key as string))
      .expect(401);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...bearer(theirs.body.key as string))
      .expect(200);
  });

  it('rotating or deleting a member invalidates its key and the keys it issued', async () => {
    const m = await createMember();
    const issued = await request(app)
      .post('/api/sessions')
      .set(...bearer(m.key))
      .send({ templateId: ids.tplRead })
      .expect(201);
    const sessionKey = issued.body.key as string;

    const rotated = await request(app)
      .post(`/api/admin/members/${m.id}/rotate`)
      .set(...bearer(admin))
      .expect(200);
    await request(app)
      .get('/api/member')
      .set(...bearer(m.key))
      .expect(401);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...bearer(sessionKey))
      .expect(401);
    const newKey = rotated.body.key as string;
    await request(app)
      .get('/api/member')
      .set(...bearer(newKey))
      .expect(200);

    await request(app)
      .delete(`/api/admin/members/${m.id}`)
      .set(...bearer(admin))
      .expect(204);
    await request(app)
      .get('/api/member')
      .set(...bearer(newKey))
      .expect(401);
  });

  it('expires member keys', async () => {
    const m = await createMember({ expiresAt: '2026-01-02T00:00:00Z' });
    await request(app)
      .get('/api/member')
      .set(...bearer(m.key))
      .expect(200);
    h.clock.now = new Date('2026-01-02T00:00:01Z');
    const res = await request(app)
      .get('/api/member')
      .set(...bearer(m.key))
      .expect(401);
    expect(res.body.message).toMatch(/expired/);
  });

  it('drops deleted templates and accounts from member allowlists', async () => {
    const m = await createMember({ templateIds: [ids.tplRead, ids.tplWrite] });
    await request(app)
      .delete(`/api/admin/templates/${ids.tplWrite}`)
      .set(...bearer(admin))
      .expect(204);
    await request(app)
      .delete(`/api/admin/accounts/${ids.acc1}`)
      .set(...bearer(admin))
      .expect(204);
    const view = await request(app)
      .get('/api/member')
      .set(...bearer(m.key))
      .expect(200);
    expect((view.body.templates as { id: string }[]).map((t) => t.id)).toEqual([ids.tplRead]);
    expect(view.body.accounts).toEqual([]);
    const list = await request(app)
      .get('/api/admin/members')
      .set(...bearer(admin));
    expect(list.body[0]).toMatchObject({ templateIds: [ids.tplRead], accountIds: [] });
  });

  it('attributes issued keys to the member in the admin view', async () => {
    const m = await createMember();
    await request(app)
      .post('/api/sessions')
      .set(...bearer(m.key))
      .send({ templateId: ids.tplRead });
    const sessions = await request(app)
      .get('/api/admin/sessions')
      .set(...bearer(admin));
    expect(sessions.body[0].issuedBy).toMatchObject({ kind: 'member', memberId: m.id });
    const members = await request(app)
      .get('/api/admin/members')
      .set(...bearer(admin));
    expect(members.body[0]).toMatchObject({ activeSessions: 1 });
    expect(members.body[0].lastUsedAt).toBeTruthy();
  });
});
