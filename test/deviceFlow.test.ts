import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ActivityLog } from '../src/server/activity.js';
import { Database, IN_MEMORY } from '../src/server/db/database.js';
import { Gateway } from '../src/server/gateway.js';
import { createApp } from '../src/server/http/app.js';
import { CryptoBox } from '../src/server/store/crypto.js';
import { EncryptedStore } from '../src/server/store/store.js';
import { createGitHubProvider } from '../src/server/tools/github.js';
import { ToolRegistry } from '../src/server/tools/registry.js';
import { createHarness } from './helpers.js';

/** Scripted GitHub: device code endpoint + a queue of access-token responses. */
function scriptedGitHub(tokenResponses: object[]) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl: typeof fetch = (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url, body });
    if (url === 'https://github.com/login/device/code') {
      return Promise.resolve(
        Response.json({
          device_code: 'dev-code-123',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
      );
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      return Promise.resolve(Response.json(tokenResponses.shift() ?? { error: 'bad' }));
    }
    if (url === 'https://api.github.com/user') {
      return Promise.resolve(
        Response.json({ login: 'octocat', id: 1 }, { headers: { 'x-oauth-scopes': 'repo' } }),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
  return { fetchImpl, calls };
}

async function setup(tokenResponses: object[]) {
  const { config } = await createHarness();
  const github = scriptedGitHub(tokenResponses);
  const crypto = await CryptoBox.fromKeyFile(config.keyFile);
  const store = await EncryptedStore.open(config.storeFile, crypto);
  const clock = { now: new Date('2026-01-01T00:00:00Z') };
  const gateway = new Gateway(
    store,
    crypto,
    new ToolRegistry([createGitHubProvider(github.fetchImpl)]),
    new ActivityLog(Database.open(IN_MEMORY)),
    () => clock.now,
  );
  const admin = await gateway.rotateAdminToken();
  const app = createApp(gateway, config);
  const as = (r: request.Test) => r.set('authorization', `Bearer ${admin}`);
  const advance = (seconds: number) => {
    clock.now = new Date(clock.now.getTime() + seconds * 1000);
  };
  return { app, as, advance, github, store };
}

describe('GitHub sign-in (device flow)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup([
      { error: 'authorization_pending' },
      { error: 'slow_down', interval: 10 },
      { access_token: 'gho_signedInToken', token_type: 'bearer', scope: 'repo' },
    ]);
  });

  it('requires an OAuth client ID first', async () => {
    const res = await ctx
      .as(request(ctx.app).post('/api/admin/device-flows'))
      .send({ tool: 'github', label: 'Me' })
      .expect(400);
    expect(res.body.message).toMatch(/client ID/);
  });

  it('connects an account once the user approves, respecting poll intervals', async () => {
    await ctx
      .as(request(ctx.app).put('/api/admin/tools/github/settings'))
      .send({ oauthClientId: 'Ov23liTEST' })
      .expect(200);
    const tools = await ctx.as(request(ctx.app).get('/api/admin/tools')).expect(200);
    expect(tools.body[0].signIn).toMatchObject({ oauthClientId: 'Ov23liTEST' });

    const start = await ctx
      .as(request(ctx.app).post('/api/admin/device-flows'))
      .send({ tool: 'github', label: 'Me', scopes: 'repo' })
      .expect(201);
    expect(start.body).toMatchObject({ userCode: 'ABCD-1234', intervalSeconds: 5 });
    expect(JSON.stringify(start.body)).not.toContain('dev-code-123');
    const poll = () =>
      ctx.as(request(ctx.app).post(`/api/admin/device-flows/${start.body.flowId}/poll`));

    const tokenCalls = () =>
      ctx.github.calls.filter((c) => c.url.endsWith('/login/oauth/access_token')).length;

    // Too early: no call to GitHub.
    await poll().expect(200, { status: 'pending' });
    expect(tokenCalls()).toBe(0);

    ctx.advance(5);
    await poll().expect(200, { status: 'pending' }); // authorization_pending
    ctx.advance(5);
    await poll().expect(200, { status: 'pending' }); // slow_down → interval 10s
    ctx.advance(5);
    await poll().expect(200, { status: 'pending' }); // throttled locally
    expect(tokenCalls()).toBe(2);
    ctx.advance(5);
    const done = await poll().expect(200);
    expect(done.body).toMatchObject({
      status: 'complete',
      account: {
        label: 'Me',
        identity: { login: 'octocat', tokenType: 'OAuth app', connectedVia: 'GitHub sign-in' },
      },
    });
    expect(ctx.store.read().accounts[0]?.secret).toBe('gho_signedInToken');
    expect(ctx.github.calls.at(-2)?.body).toContain('device_code=dev-code-123');

    // Flow is consumed.
    const again = await poll().expect(200);
    expect(again.body.status).toBe('failed');
  });

  it('reports denial', async () => {
    ctx = await setup([{ error: 'access_denied' }]);
    await ctx
      .as(request(ctx.app).put('/api/admin/tools/github/settings'))
      .send({ oauthClientId: 'Ov23liTEST' });
    const start = await ctx
      .as(request(ctx.app).post('/api/admin/device-flows'))
      .send({ tool: 'github', label: 'Me' })
      .expect(201);
    ctx.advance(5);
    const res = await ctx
      .as(request(ctx.app).post(`/api/admin/device-flows/${start.body.flowId}/poll`))
      .expect(200);
    expect(res.body).toEqual({ status: 'failed', message: 'Authorization was denied on GitHub' });
    expect(ctx.store.read().accounts).toHaveLength(0);
  });

  it('validates the client ID', async () => {
    await ctx
      .as(request(ctx.app).put('/api/admin/tools/github/settings'))
      .send({ oauthClientId: 'bad id; drop' })
      .expect(400);
  });
});
