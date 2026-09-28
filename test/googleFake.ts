/** Test helpers: a fake Google OIDC provider and a full sign-in round trip against the app. */
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import * as oidc from 'openid-client';
import request from 'supertest';
import { expect } from 'vitest';
import { GoogleSignIn } from '../src/server/auth/google.js';
import { createApp } from '../src/server/http/app.js';
import { createHarness, type Harness } from './helpers.js';

export const ISSUER = 'https://accounts.fake-google.test';
export const CLIENT_ID = 'client-123.apps.googleusercontent.com';
export const HOST = 'gateway.test';

const signingKey = (async () => {
  const keys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  return { keys, jwk };
})();

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
    const { keys, jwk } = await signingKey;
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

export interface Ctx {
  h: Harness;
  app: ReturnType<typeof createApp>;
  claims: Record<string, unknown>;
  tokenRequests: URLSearchParams[];
}

export async function setup(adminEmails = ['admin@example.com']): Promise<Ctx> {
  const h = await createHarness();
  const ctx = { h, claims: {} } as Ctx;
  const provider = fakeProvider(() => ctx.claims);
  ctx.tokenRequests = provider.tokenRequests;
  h.gateway.setAdminEmails(adminEmails);
  const google = new GoogleSignIn(
    { clientId: CLIENT_ID, clientSecret: 'client-secret', adminEmails },
    `${h.config.publicUrl}/auth/google/callback`,
    () => Promise.resolve(provider.config),
  );
  ctx.app = createApp(h.gateway, h.config, { fetch: h.fetch, googleSignIn: google });
  return ctx;
}

export const cookieValue = (res: request.Response, name: string): string | undefined => {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const line = raw?.find((c) => c.startsWith(`${name}=`));
  return line?.slice(name.length + 1).split(';')[0];
};

/** Runs login → (user approves at Google) → callback. Returns the callback response. */
export async function signIn(ctx: Ctx, claims: Record<string, unknown>, tamper?: (u: URL) => void) {
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

/** Signs in with a verified email and returns the session cookie header value. */
export async function sessionCookie(ctx: Ctx, email: string): Promise<string> {
  const res = await signIn(ctx, { email, email_verified: true });
  const token = cookieValue(res, 'gw_session');
  if (!token) throw new Error(`sign-in failed: ${String(res.headers.location)}`);
  return `gw_session=${token}`;
}
