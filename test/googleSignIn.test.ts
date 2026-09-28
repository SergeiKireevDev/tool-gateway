import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import * as oidc from 'openid-client';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GoogleSignIn } from '../src/server/auth/google.js';
import { createApp } from '../src/server/http/app.js';
import { createHarness, type Harness } from './helpers.js';

const ISSUER = 'https://accounts.fake-google.test';
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const HOST = 'gateway.test';

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
});

/** Fake Google: serves JWKS and a token endpoint that issues a signed ID token. */
function fakeProvider(claims: () => Record<string, unknown>) {
  const tokenRequests: URLSearchParams[] = [];
  const config = new oidc.Configuration(
    {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/certs`,
      id_token_signing_alg_values_supported: ['RS256'],
    },
    CLIENT_ID,
    'client-secret',
  );
  config[oidc.customFetch] = async (url, options) => {
    if (url === `${ISSUER}/certs`) return Response.json({ keys: [jwk] });
    if (url === `${ISSUER}/token`) {
      tokenRequests.push(new URLSearchParams(options.body as URLSearchParams | string));
      const idToken = await new SignJWT(claims())
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject('google-user-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey);
      return Response.json({ access_token: 'at', token_type: 'Bearer', id_token: idToken });
    }
    return new Response('not found', { status: 404 });
  };
  return { config, tokenRequests };
}

interface Ctx {
  h: Harness;
  app: ReturnType<typeof createApp>;
  claims: Record<string, unknown>;
  tokenRequests: URLSearchParams[];
}

async function setup(adminEmails = ['admin@example.com']): Promise<Ctx> {
  const h = await createHarness();
  const ctx = { h, claims: {} } as Ctx;
  const provider = fakeProvider(() => ctx.claims);
  ctx.tokenRequests = provider.tokenRequests;
  const google = new GoogleSignIn(
    { clientId: CLIENT_ID, clientSecret: 'client-secret', adminEmails },
    `${h.config.publicUrl}/auth/google/callback`,
    () => Promise.resolve(provider.config),
  );
  ctx.app = createApp(h.gateway, h.config, { fetch: h.fetch, googleSignIn: google });
  return ctx;
}

const cookieValue = (res: request.Response, name: string): string | undefined => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const line = raw?.find((c) => c.startsWith(`${name}=`));
  return line?.slice(name.length + 1).split(';')[0];
};

/** Runs login → (user approves at Google) → callback. Returns the callback response. */
async function signIn(ctx: Ctx, claims: Record<string, unknown>, tamper?: (u: URL) => void) {
  const login = await request(ctx.app).get('/auth/google/login').set('host', HOST).expect(302);
  const authUrl = new URL(login.headers.location ?? '');
  const loginCookie = cookieValue(login, 'gw_login');
  expect(login.headers['set-cookie']?.[0]).toMatch(/HttpOnly; SameSite=Lax/);

  ctx.claims = { nonce: authUrl.searchParams.get('nonce'), ...claims };
  const callback = new URL('/auth/google/callback', 'http://x');
  callback.searchParams.set('code', 'auth-code');
  callback.searchParams.set('state', authUrl.searchParams.get('state') ?? '');
  tamper?.(callback);
  return request(ctx.app)
    .get(callback.pathname + callback.search)
    .set('host', HOST)
    .set('cookie', loginCookie ? `gw_login=${loginCookie}` : '');
}

describe('Google admin sign-in', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('advertises Google sign-in to the login screen', async () => {
    await request(ctx.app).get('/api/auth/config').expect(200, { google: true });
  });

  it('builds a PKCE authorization request to Google', async () => {
    const res = await request(ctx.app).get('/auth/google/login').set('host', HOST).expect(302);
    const url = new URL(res.headers.location ?? '');
    expect(url.origin + url.pathname).toBe(`${ISSUER}/o/oauth2/v2/auth`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: 'http://gateway.test/auth/google/callback',
      response_type: 'code',
      scope: 'openid email',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
  });

  it('redirects to the public host before starting (cookies are per host)', async () => {
    const res = await request(ctx.app).get('/auth/google/login').set('host', '127.0.0.1:7420');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://gateway.test/auth/google/login');
  });

  it('signs in an allowlisted admin and uses a cookie session for the admin API', async () => {
    const res = await signIn(ctx, { email: 'Admin@Example.com', email_verified: true });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/');
    const session = cookieValue(res, 'gw_admin');
    expect(session).toMatch(/^gwc_/);
    expect((res.headers['set-cookie'] as unknown as string[]).join()).toMatch(
      /gw_admin=[^;]+; Path=\/; Expires=[^;]+; HttpOnly; SameSite=Strict/,
    );
    // PKCE verifier was sent with the code exchange.
    expect(ctx.tokenRequests[0]?.get('code_verifier')).toBeTruthy();

    const cookie = `gw_admin=${session ?? ''}`;
    await request(ctx.app)
      .get('/api/auth/me')
      .set('cookie', cookie)
      .expect(200)
      .expect((r) => {
        expect(r.body.email).toBe('admin@example.com');
      });
    await request(ctx.app)
      .get('/api/admin/accounts')
      .set('cookie', cookie)
      .set('x-gateway-request', '1')
      .expect(200);
    // Cookie alone is not enough: CSRF header required.
    await request(ctx.app).get('/api/admin/accounts').set('cookie', cookie).expect(403);

    await request(ctx.app)
      .post('/api/auth/logout')
      .set('cookie', cookie)
      .set('x-gateway-request', '1')
      .expect(204);
    await request(ctx.app).get('/api/auth/me').set('cookie', cookie).expect(401);
    await request(ctx.app)
      .get('/api/admin/accounts')
      .set('cookie', cookie)
      .set('x-gateway-request', '1')
      .expect(401);
  });

  const rejects = (res: request.Response, message: RegExp): void => {
    expect(res.status).toBe(303);
    const location = new URL(res.headers.location ?? '', 'http://x');
    expect(location.pathname).toBe('/');
    expect(location.searchParams.get('login_error')).toMatch(message);
    expect(cookieValue(res, 'gw_admin')).toBeUndefined();
  };

  it('rejects accounts that are not on the allowlist', async () => {
    rejects(
      await signIn(ctx, { email: 'intruder@example.com', email_verified: true }),
      /intruder@example.com is not allowed/,
    );
  });

  it('rejects unverified emails', async () => {
    rejects(
      await signIn(ctx, { email: 'admin@example.com', email_verified: false }),
      /no verified email/,
    );
  });

  it('rejects a tampered state', async () => {
    rejects(
      await signIn(ctx, { email: 'admin@example.com', email_verified: true }, (u) => {
        u.searchParams.set('state', 'forged');
      }),
      /sign-in failed/,
    );
  });

  it('rejects an ID token with the wrong nonce', async () => {
    rejects(
      await signIn(ctx, { email: 'admin@example.com', email_verified: true, nonce: 'replayed' }),
      /sign-in failed/,
    );
  });

  it('rejects callbacks without the login cookie (login CSRF)', async () => {
    const login = await request(ctx.app).get('/auth/google/login').set('host', HOST);
    const state = new URL(login.headers.location ?? '').searchParams.get('state') ?? '';
    const res = await request(ctx.app)
      .get(`/auth/google/callback?code=c&state=${state}`)
      .set('host', HOST);
    rejects(res, /expired or was started in another browser/);
  });

  it('reports a cancelled consent screen', async () => {
    rejects(
      await signIn(ctx, {}, (u) => {
        u.search = '';
        u.searchParams.set('error', 'access_denied');
      }),
      /cancelled/,
    );
  });

  it('keeps the admin token working alongside Google sign-in', async () => {
    const token = await ctx.h.gateway.rotateAdminToken();
    await request(ctx.app)
      .get('/api/admin/accounts')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
  });
});

describe('without Google configured', () => {
  it('reports it as disabled', async () => {
    const h = await createHarness();
    const app = createApp(h.gateway, h.config, { fetch: h.fetch });
    await request(app).get('/api/auth/config').expect(200, { google: false });
    const res = await request(app).get('/auth/google/login').expect(303);
    expect(res.headers.location).toMatch(/login_error=Google%20sign-in%20is%20not%20configured/);
  });
});
