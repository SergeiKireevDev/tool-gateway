import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { parseAuthorizationInput } from '../src/server/oauthSignIns.js';
import { CLAUDE_CODE_IDENTITY } from '../src/server/tools/llm/anthropic.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;

const asAdmin = (method: 'get' | 'post', path: string) =>
  request(app)[method](`/api/admin${path}`).set('authorization', `Bearer ${admin}`);

async function memberCookie(name: string): Promise<{ id: string; cookie: string }> {
  const tpl = h.gateway.listTemplates()[0];
  const res = await asAdmin('post', '/members')
    .send({ name, email: `${name}@example.com`, templateIds: [tpl?.id] })
    .expect(201);
  const identity = h.gateway.identify(`${name}@example.com`);
  if (identity?.role !== 'member') throw new Error('no member');
  const { token } = await h.gateway.createWebSession(identity);
  return { id: res.body.member.id as string, cookie: `gw_session=${token}` };
}

const portal = (cookie: string, method: 'get' | 'post' | 'delete', path: string) =>
  request(app)[method](`/api/me${path}`).set('cookie', cookie).set('x-gateway-request', '1');

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
  await asAdmin('post', '/templates')
    .send({
      name: 'claude',
      grants: [{ tool: 'anthropic', permissions: ['llm:invoke'], resources: [] }],
      defaultTtlSeconds: 600,
      maxTtlSeconds: 3600,
    })
    .expect(201);
});

/** Starts and completes "Sign in with Claude" as a member; returns the new account. */
async function signIn(cookie: string): Promise<{ id: string; signedIn: boolean }> {
  const start = await portal(cookie, 'post', '/sign-ins')
    .send({ tool: 'anthropic', label: 'My Claude' })
    .expect(201);
  const url = new URL(start.body.authorizeUrl as string);
  const state = url.searchParams.get('state') ?? '';
  const done = await portal(cookie, 'post', `/sign-ins/${start.body.flowId as string}/complete`)
    .send({ input: `http://localhost:53692/callback?code=good-code&state=${state}` })
    .expect(201);
  return done.body as { id: string; signedIn: boolean };
}

describe('Sign in with Claude', () => {
  it('builds a PKCE authorize URL', async () => {
    const { cookie } = await memberCookie('alice');
    const start = await portal(cookie, 'post', '/sign-ins')
      .send({ tool: 'anthropic', label: 'x' })
      .expect(201);
    const url = new URL(start.body.authorizeUrl as string);
    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:53692/callback');
    await portal(cookie, 'post', '/sign-ins').send({ tool: 'github', label: 'x' }).expect(400);
  });

  it('stores the tokens as the member’s own account, never returned', async () => {
    const { id, cookie } = await memberCookie('alice');
    const account = await signIn(cookie);
    expect(account).toMatchObject({
      signedIn: true,
      secretHint: 'signed in',
      owner: { kind: 'member', memberId: id },
      identity: { login: 'alice@claude.example', organization: 'Alice Max' },
    });
    const list = await portal(cookie, 'get', '/accounts').expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(/sk-ant-oat|"r1"|refreshToken/);
    const stored = h.gateway.listAccounts().find((a) => a.id === account.id);
    expect(stored?.signedIn).toBe(true);
  });

  it('refuses another sign-in’s state, other members and bad codes', async () => {
    const alice = await memberCookie('alice');
    const bob = await memberCookie('bob');
    const start = await portal(alice.cookie, 'post', '/sign-ins')
      .send({ tool: 'anthropic', label: 'x' })
      .expect(201);
    const flowId = start.body.flowId as string;
    await portal(bob.cookie, 'post', `/sign-ins/${flowId}/complete`)
      .send({ input: 'good-code' })
      .expect(404);
    await portal(alice.cookie, 'post', `/sign-ins/${flowId}/complete`)
      .send({ input: 'good-code#other-state' })
      .expect(400);
    await portal(alice.cookie, 'post', `/sign-ins/${flowId}/complete`)
      .send({ input: 'bad-code' })
      .expect(502);
  });

  it('calls Claude like Claude Code with the access token, and refreshes it', async () => {
    const alice = await memberCookie('alice');
    const account = await signIn(alice.cookie);
    const tpl = h.gateway.listTemplates()[0];
    const { key } = await portal(alice.cookie, 'post', '/sessions')
      .send({ templateId: tpl?.id, accountIds: [account.id], ttlSeconds: 3600 })
      .expect(201)
      .then((r) => r.body as { key: string });
    const call = () =>
      request(app)
        .post('/proxy/anthropic/v1/messages')
        .set('x-api-key', key)
        .set('anthropic-beta', 'fine-grained-tool-streaming-2025-05-14')
        .send({ model: 'claude-sonnet-5', max_tokens: 10, system: 'Be brief.', messages: [] })
        .expect(200);
    await call();
    const first = h.upstreamCalls.at(-1);
    const headers = new Headers(first?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-ant-oat01-token1');
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('anthropic-beta')?.split(',')).toEqual(
      expect.arrayContaining([
        'oauth-2025-04-20',
        'claude-code-20250219',
        'fine-grained-tool-streaming-2025-05-14',
      ]),
    );
    const body = JSON.parse(Buffer.from(first?.init.body as Buffer).toString()) as {
      system: { text: string }[];
    };
    expect(body.system.map((b) => b.text)).toEqual([CLAUDE_CODE_IDENTITY, 'Be brief.']);

    // The access token lasts 1 h; the gateway refreshes it 5 min early.
    h.clock.now = new Date(h.clock.now.getTime() + 56 * 60_000);
    await call();
    expect(new Headers(h.upstreamCalls.at(-1)?.init.headers).get('authorization')).toBe(
      'Bearer sk-ant-oat01-token2',
    );
  });
});

describe('parseAuthorizationInput', () => {
  it('accepts a redirect URL, code#state, a query string or a bare code', () => {
    expect(parseAuthorizationInput('http://localhost:53692/callback?code=a&state=b')).toEqual({
      code: 'a',
      state: 'b',
    });
    expect(parseAuthorizationInput('a#b')).toEqual({ code: 'a', state: 'b' });
    expect(parseAuthorizationInput('code=a&state=b')).toEqual({ code: 'a', state: 'b' });
    expect(parseAuthorizationInput(' a ')).toEqual({ code: 'a', state: null });
  });
});
