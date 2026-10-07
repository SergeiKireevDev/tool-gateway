import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createHarness, FAKE_LLM_TOTAL, fakeChatGptToken, type Harness } from './helpers.js';

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;

const asAdmin = (method: 'get' | 'post', path: string) =>
  request(app)[method](`/api/admin${path}`).set('authorization', `Bearer ${admin}`);

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
});

interface SignedInAccount {
  id: string;
  signedIn: boolean;
  kind: string;
  identity: Record<string, string>;
}

/** Runs "Sign in with ChatGPT" to completion (one pending poll first) and returns the account. */
async function signIn(): Promise<SignedInAccount> {
  const start = await asAdmin('post', '/device-flows')
    .send({ tool: 'openai', label: 'ChatGPT Pro' })
    .expect(201);
  expect(start.body).toMatchObject({
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://auth.openai.com/codex/device',
  });
  const poll = () =>
    asAdmin('post', `/device-flows/${start.body.flowId as string}/poll`).expect(200);
  h.clock.now = new Date(h.clock.now.getTime() + 6000);
  expect((await poll()).body).toEqual({ status: 'pending' });
  expect((await poll()).body).toEqual({ status: 'pending' }); // within the interval: not polled
  h.clock.now = new Date(h.clock.now.getTime() + 6000);
  const done = await poll();
  expect(done.body.status).toBe('complete');
  return done.body.account as SignedInAccount;
}

describe('Sign in with ChatGPT (device code)', () => {
  it('needs no OAuth app and is labelled for ChatGPT', async () => {
    const tools = (await asAdmin('get', '/tools').expect(200)).body as {
      id: string;
      signIn: Record<string, unknown> | null;
    }[];
    expect(tools.find((t) => t.id === 'openai')?.signIn).toMatchObject({
      builtIn: true,
      label: 'Sign in with ChatGPT',
      oauthClientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    });
  });

  it('connects a refreshable account from the device code flow', async () => {
    const account = await signIn();
    expect(account).toMatchObject({
      signedIn: true,
      kind: 'llm',
      identity: {
        login: 'ada@chatgpt.example',
        plan: 'pro',
        keyType: 'ChatGPT subscription (sign-in)',
      },
    });
    const exchange = h.upstreamCalls.find((c) => c.url === 'https://auth.openai.com/oauth/token');
    expect(new URLSearchParams(exchange?.init.body as string).get('redirect_uri')).toBe(
      'https://auth.openai.com/deviceauth/callback',
    );
    const listed = await asAdmin('get', '/accounts').expect(200);
    expect(JSON.stringify(listed.body)).not.toMatch(/eyJ|cr1/);
  });

  it('routes Codex calls to the ChatGPT backend and refreshes the token', async () => {
    const account = await signIn();
    const tpl = await asAdmin('post', '/templates')
      .send({
        name: 'codex',
        grants: [{ tool: 'openai', permissions: ['llm:invoke'], resources: [] }],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 7200,
      })
      .expect(201);
    const { key } = (
      await asAdmin('post', '/sessions')
        .send({ templateId: tpl.body.id, accountIds: [account.id], tokenBudget: 10_000 })
        .expect(201)
    ).body as { key: string };
    const responses = () =>
      request(app)
        .post('/proxy/openai/v1/responses')
        .set('authorization', `Bearer ${key}`)
        .send({
          model: 'gpt-5-codex',
          input: 'hi',
          stream: true,
          store: true,
          max_output_tokens: 99_999,
        })
        .expect(200);
    await responses();
    const call = h.upstreamCalls.at(-1);
    expect(call?.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${fakeChatGptToken(1)}`);
    expect(headers.get('chatgpt-account-id')).toBe('acct_1');
    expect(headers.get('openai-beta')).toBe('responses=experimental');
    const body = JSON.parse(Buffer.from(call?.init.body as Buffer).toString()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ store: false, model: 'gpt-5-codex' });
    expect(body).not.toHaveProperty('max_output_tokens');
    const session = await request(app)
      .get('/api/session')
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    expect(session.body.tokensRemaining).toBe(10_000 - FAKE_LLM_TOTAL);

    await request(app)
      .post('/proxy/openai/v1/chat/completions')
      .set('authorization', `Bearer ${key}`)
      .send({ model: 'gpt-5', messages: [] })
      .expect(403);

    h.clock.now = new Date(h.clock.now.getTime() + 56 * 60_000);
    await responses();
    expect(new Headers(h.upstreamCalls.at(-1)?.init.headers).get('authorization')).toBe(
      `Bearer ${fakeChatGptToken(2)}`,
    );
  });

  it('lets members sign in with their own ChatGPT account', async () => {
    const tpl = await asAdmin('post', '/templates')
      .send({
        name: 't',
        grants: [{ tool: 'openai', permissions: ['llm:invoke'], resources: [] }],
        defaultTtlSeconds: 600,
        maxTtlSeconds: 600,
      })
      .expect(201);
    await asAdmin('post', '/members')
      .send({ name: 'alice', email: 'alice@example.com', templateIds: [tpl.body.id] })
      .expect(201);
    const identity = h.gateway.identify('alice@example.com');
    if (identity?.role !== 'member') throw new Error('no member');
    const cookie = `gw_session=${(await h.gateway.createWebSession(identity)).token}`;
    const portal = (method: 'post', path: string) =>
      request(app)[method](`/api/me${path}`).set('cookie', cookie).set('x-gateway-request', '1');
    const start = await portal('post', '/device-flows')
      .send({ tool: 'openai', label: 'Mine' })
      .expect(201);
    h.clock.now = new Date(h.clock.now.getTime() + 6000);
    await portal('post', `/device-flows/${start.body.flowId as string}/poll`).expect(200);
    h.clock.now = new Date(h.clock.now.getTime() + 6000);
    const done = await portal('post', `/device-flows/${start.body.flowId as string}/poll`).expect(
      200,
    );
    expect(done.body.account).toMatchObject({ signedIn: true, owner: { kind: 'member' } });
  });
});
