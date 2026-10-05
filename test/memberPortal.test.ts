import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Ctx, sessionCookie, setup, signIn } from './googleFake.js';

const ADMIN = 'admin@example.com';
let ctx: Ctx;
let adminToken: string;
let ids: { shared: string; tplRead: string; tplWrite: string };

const admin = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string) =>
  request(ctx.app)[method](`/api/admin${path}`).set('authorization', `Bearer ${adminToken}`);

/** Member portal request with the session cookie and CSRF header, like the UI sends. */
const portal = (cookie: string, method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
  request(ctx.app)[method](`/api/me${path}`).set('cookie', cookie).set('x-gateway-request', '1');

async function createMember(name: string, email: string | null, extra: object = {}) {
  const res = await admin('post', '/members')
    .send({ name, email, templateIds: [ids.tplRead], ...extra })
    .expect(201);
  return { id: res.body.member.id as string, key: res.body.key as string };
}

beforeEach(async () => {
  ctx = await setup([ADMIN]);
  adminToken = await ctx.h.gateway.rotateAdminToken();
  const tpl = (name: string, permissions: string[]) =>
    admin('post', '/templates')
      .send({
        name,
        grants: [{ tool: 'github', permissions, resources: [] }],
        defaultTtlSeconds: 600,
        maxTtlSeconds: 3600,
      })
      .expect(201);
  ids = {
    shared: (
      await admin('post', '/accounts')
        .send({ tool: 'github', label: 'shared', secret: 'ghp_shared' })
        .expect(201)
    ).body.id,
    tplRead: (await tpl('read', ['issues:read'])).body.id,
    tplWrite: (await tpl('write', ['issues:write'])).body.id,
  };
});

describe('member emails', () => {
  it('validates and normalizes member emails', async () => {
    const m = await createMember('alice', 'Alice@Example.com');
    const list = await admin('get', '/members').expect(200);
    expect(list.body[0]).toMatchObject({ id: m.id, email: 'alice@example.com', ownAccounts: 0 });
    // unique, not an admin email, well-formed
    await admin('post', '/members')
      .send({ name: 'x', email: 'ALICE@example.com', templateIds: [ids.tplRead] })
      .expect(409);
    await admin('post', '/members')
      .send({ name: 'x', email: ADMIN, templateIds: [ids.tplRead] })
      .expect(400);
    await admin('post', '/members')
      .send({ name: 'x', email: 'not-an-email', templateIds: [ids.tplRead] })
      .expect(400);
  });
});

describe('Google sign-in by role', () => {
  it('signs a member into the member portal, not the admin API', async () => {
    await createMember('alice', 'alice@example.com');
    const cookie = await sessionCookie(ctx, 'Alice@example.com');
    const me = await request(ctx.app).get('/api/auth/me').set('cookie', cookie).expect(200);
    expect(me.body).toMatchObject({
      role: 'member',
      email: 'alice@example.com',
      memberName: 'alice',
    });

    await request(ctx.app)
      .get('/api/admin/accounts')
      .set('cookie', cookie)
      .set('x-gateway-request', '1')
      .expect(401);
    const view = await portal(cookie, 'get', '/').expect(200);
    expect(view.body).toMatchObject({ name: 'alice', email: 'alice@example.com' });
    expect((view.body.templates as { id: string }[]).map((t) => t.id)).toEqual([ids.tplRead]);
  });

  it('signs admins in as admin and refuses unknown emails', async () => {
    const adminCookie = await sessionCookie(ctx, ADMIN);
    const me = await request(ctx.app).get('/api/auth/me').set('cookie', adminCookie).expect(200);
    expect(me.body.role).toBe('admin');
    await portal(adminCookie, 'get', '/').expect(401);

    const res = await signIn(ctx, { email: 'stranger@example.com', email_verified: true });
    expect(res.headers.location).toMatch(/stranger%40example.com%20is%20not%20allowed/);
  });

  it('drops sessions whose role no longer matches the email', async () => {
    const adminCookie = await sessionCookie(ctx, ADMIN);
    // The email stops being an admin and becomes a member's: the old admin session is dead.
    ctx.h.gateway.setAdminEmails([]);
    await createMember('former-admin', ADMIN);
    await admin('get', '/accounts').expect(200); // (admin token unaffected)
    await request(ctx.app)
      .get('/api/admin/accounts')
      .set('cookie', adminCookie)
      .set('x-gateway-request', '1')
      .expect(401);
    await portal(adminCookie, 'get', '/').expect(401);
    await request(ctx.app).get('/api/auth/me').set('cookie', adminCookie).expect(401);
  });

  it('never upgrades a member session to admin', async () => {
    await createMember('alice', 'alice@example.com');
    const cookie = await sessionCookie(ctx, 'alice@example.com');
    // Her email is later added to the admin list: the member session must not become admin.
    ctx.h.gateway.setAdminEmails([ADMIN, 'alice@example.com']);
    await request(ctx.app)
      .get('/api/admin/accounts')
      .set('cookie', cookie)
      .set('x-gateway-request', '1')
      .expect(401);
    await request(ctx.app).get('/api/auth/me').set('cookie', cookie).expect(401);
  });

  it('requires the CSRF header on portal calls', async () => {
    await createMember('alice', 'alice@example.com');
    const cookie = await sessionCookie(ctx, 'alice@example.com');
    await request(ctx.app).get('/api/me').set('cookie', cookie).expect(403);
  });

  it('ends a member session when its email changes or the member is deleted', async () => {
    const m = await createMember('alice', 'alice@example.com');
    const cookie = await sessionCookie(ctx, 'alice@example.com');
    await admin('put', `/members/${m.id}`)
      .send({ name: 'alice', email: 'alice2@example.com', templateIds: [ids.tplRead] })
      .expect(200);
    await portal(cookie, 'get', '/').expect(401);

    const cookie2 = await sessionCookie(ctx, 'alice2@example.com');
    await portal(cookie2, 'get', '/').expect(200);
    await admin('delete', `/members/${m.id}`).expect(204);
    await portal(cookie2, 'get', '/').expect(401);
  });
});

describe('member-owned accounts', () => {
  let alice: { id: string; key: string };
  let aliceCookie: string;
  let bobCookie: string;
  let aliceAccount: string;

  beforeEach(async () => {
    alice = await createMember('alice', 'alice@example.com', { accountIds: [ids.shared] });
    await createMember('bob', 'bob@example.com');
    aliceCookie = await sessionCookie(ctx, 'alice@example.com');
    bobCookie = await sessionCookie(ctx, 'bob@example.com');
    aliceAccount = (
      await portal(aliceCookie, 'post', '/accounts')
        .send({ tool: 'github', label: 'alice gh', secret: 'ghp_alice' })
        .expect(201)
    ).body.id;
  });

  it('lets members connect accounts that only they can use', async () => {
    const mine = await portal(aliceCookie, 'get', '/accounts').expect(200);
    expect(
      (mine.body as { id: string; owner: { kind: string } }[]).map((a) => [a.id, a.owner.kind]),
    ).toEqual([
      [ids.shared, 'shared'],
      [aliceAccount, 'member'],
    ]);
    expect(JSON.stringify(mine.body)).not.toContain('ghp_');

    // Bob sees neither Alice's account nor the shared one (not granted to him).
    const bobs = await portal(bobCookie, 'get', '/accounts').expect(200);
    expect(bobs.body).toEqual([]);
    await portal(bobCookie, 'patch', `/accounts/${aliceAccount}`).send({ label: 'x' }).expect(404);
    await portal(bobCookie, 'delete', `/accounts/${aliceAccount}`).expect(404);
  });

  it('issues keys on the member account, with the member key and in the portal', async () => {
    const viaPortal = await portal(aliceCookie, 'post', '/sessions')
      .send({ templateId: ids.tplRead, accountId: aliceAccount })
      .expect(201);
    await request(ctx.app)
      .get('/proxy/github/repos/o/r/issues')
      .set('authorization', `Bearer ${viaPortal.body.key as string}`)
      .expect(200);
    expect(new Headers(ctx.h.upstreamCalls.at(-1)?.init.headers).get('authorization')).toBe(
      'Bearer ghp_alice',
    );
    await request(ctx.app)
      .post('/api/sessions')
      .set('authorization', `Bearer ${alice.key}`)
      .send({ templateId: ids.tplRead, accountId: aliceAccount })
      .expect(201);
    // Not granted template, even on her own account
    await portal(aliceCookie, 'post', '/sessions')
      .send({ templateId: ids.tplWrite, accountId: aliceAccount })
      .expect(403);
    const list = await portal(aliceCookie, 'get', '/sessions').expect(200);
    expect(list.body).toHaveLength(2);
  });

  it('keeps member accounts out of the admin issuing path and grants', async () => {
    await admin('post', '/sessions')
      .send({ templateId: ids.tplRead, accountId: aliceAccount })
      .expect(404);
    await admin('post', '/members')
      .send({ name: 'carol', templateIds: [ids.tplRead], accountIds: [aliceAccount] })
      .expect(400);
  });

  it('shows member accounts to the admin, who can remove but not change them', async () => {
    const all = await admin('get', '/accounts').expect(200);
    const acc = (all.body as { id: string; owner: object }[]).find((a) => a.id === aliceAccount);
    expect(acc?.owner).toEqual({ kind: 'member', memberId: alice.id, memberName: 'alice' });
    await admin('patch', `/accounts/${aliceAccount}`).send({ label: 'hijack' }).expect(403);
    await admin('post', `/accounts/${aliceAccount}/verify`).expect(200);
    await admin('delete', `/accounts/${aliceAccount}`).expect(204);
    const mine = await portal(aliceCookie, 'get', '/accounts').expect(200);
    expect(mine.body).toHaveLength(1);
  });

  it('lets members manage their own accounts but not shared ones', async () => {
    await portal(aliceCookie, 'patch', `/accounts/${aliceAccount}`)
      .send({ label: 'renamed' })
      .expect(200);
    await portal(aliceCookie, 'patch', `/accounts/${ids.shared}`).send({ label: 'x' }).expect(404);
    await portal(aliceCookie, 'delete', `/accounts/${ids.shared}`).expect(404);
  });

  it('deleting a member removes its accounts and revokes their keys', async () => {
    const issued = await portal(aliceCookie, 'post', '/sessions')
      .send({ templateId: ids.tplRead, accountId: aliceAccount })
      .expect(201);
    await admin('delete', `/members/${alice.id}`).expect(204);
    const all = await admin('get', '/accounts').expect(200);
    expect((all.body as { id: string }[]).map((a) => a.id)).toEqual([ids.shared]);
    await request(ctx.app)
      .get('/proxy/github/repos/o/r/issues')
      .set('authorization', `Bearer ${issued.body.key as string}`)
      .expect(401);
  });

  it('keeps device sign-ins private to whoever started them', async () => {
    await admin('put', '/tools/github/settings').send({ oauthClientId: 'Ov23liTEST' }).expect(200);
    const flow = await portal(aliceCookie, 'post', '/device-flows')
      .send({ tool: 'github', label: 'via sign-in' })
      .expect(201);
    const flowId = flow.body.flowId as string;
    const bobPoll = await portal(bobCookie, 'post', `/device-flows/${flowId}/poll`).expect(200);
    expect(bobPoll.body.status).toBe('failed');
    const adminPoll = await admin('post', `/device-flows/${flowId}/poll`).expect(200);
    expect(adminPoll.body.status).toBe('failed');
    const alicePoll = await portal(aliceCookie, 'post', `/device-flows/${flowId}/poll`).expect(200);
    expect(alicePoll.body.status).toBe('pending');
  });

  it('never lets members see or rotate their member key', async () => {
    await portal(aliceCookie, 'post', '/rotate-key').expect(404);
    await request(ctx.app)
      .get('/api/member')
      .set('authorization', `Bearer ${alice.key}`)
      .expect(200);
  });
});
