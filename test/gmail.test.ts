import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createGmailProvider, parseAddressList, recipientsOf } from '../src/server/tools/gmail.js';
import type { AuthzDecision, Grant } from '../src/server/tools/types.js';
import { createHarness, fakeGmailFetch, type Harness } from './helpers.js';

const gmail = createGmailProvider(fakeGmailFetch([]));
const ME = '/gmail/v1/users/me';
const JSON_TYPE = 'application/json';
const context = { sessionId: 's', secret: 'unused', tokensRemaining: null };

interface Call {
  method?: string;
  path: string;
  search?: string;
  body?: unknown;
}

const authz = (grant: Grant, call: Call): Promise<AuthzDecision> =>
  Promise.resolve(
    gmail.authorize(
      {
        method: call.method ?? 'GET',
        segments: call.path.split('/').filter(Boolean),
        search: call.search ?? '',
        headers: new Headers(call.body === undefined ? {} : { 'content-type': JSON_TYPE }),
        body: call.body === undefined ? undefined : Buffer.from(JSON.stringify(call.body)),
      },
      grant,
      context,
    ),
  );
const ok = async (grant: Grant, call: Call) => (await authz(grant, call)).allowed;
const reason = async (grant: Grant, call: Call) => {
  const d = await authz(grant, call);
  return d.allowed ? null : d.reason;
};
const get = (path: string, search = ''): Call => ({ path: `${ME}/${path}`, search });
const post = (path: string, body: unknown = {}): Call => ({
  method: 'POST',
  path: `${ME}/${path}`,
  body,
});

/** A message whose body mentions an address that must not count as a recipient. */
const raw = (headers: string) =>
  Buffer.from(`${headers}\r\nSubject: hi\r\n\r\nTo: x@y.com\r\n`).toString('base64url');
const send = (headers: string, extra: Record<string, unknown> = {}): Call =>
  post('messages/send', { raw: raw(headers), ...extra });

const read: Grant = { permissions: ['mail:read'], resources: [] };
const sendAny: Grant = { permissions: ['mail:send'], resources: [] };
const sendAcme: Grant = {
  permissions: ['mail:send', 'drafts:write'],
  resources: ['*@acme.com', 'ada@example.com'],
};
const EVIL = 'Recipient eve@evil.com is not in the allowlist';

describe('Gmail authorization', () => {
  it('maps endpoints to permissions and denies the rest', async () => {
    expect(await ok(read, get('messages', '?q=is:unread'))).toBe(true);
    expect(await ok(read, get('threads/abc'))).toBe(true);
    expect(await ok(read, get('messages/m1/attachments/a1'))).toBe(true);
    expect(await reason(read, post('messages/m1/modify'))).toBe('Missing permission "mail:modify"');
    expect(await reason(read, get('drafts'))).toBe('Missing permission "drafts:read"');
    // Settings (forwarding, filters…), permanent deletes and imports are never covered
    expect(await reason(read, get('settings/forwardingAddresses'))).toMatch(/not covered/);
    expect(await reason(read, { ...get('messages/m1'), method: 'DELETE' })).toMatch(/not covered/);
    expect(await reason(read, post('messages/import'))).toMatch(/not covered/);
    // Only the signed-in mailbox, only the REST API
    const other = { path: '/gmail/v1/users/boss@acme.com/messages' };
    expect(await reason(read, other)).toMatch(/Only \/gmail\/v1\/users\/me/);
    expect(await reason(read, { path: `/upload${ME}/messages/send` })).toMatch(/Only/);
    expect(await ok({ permissions: [], resources: ['*@acme.com'] }, get('profile'))).toBe(true);
  });

  it('refuses query parameters that change authentication or uploads', async () => {
    const token = get('messages', '?access_token=ya29.other');
    expect(await reason(read, token)).toMatch(/"access_token" is not allowed/);
    const upload = { ...send('To: a@b.com'), search: '?uploadType=multipart' };
    expect(await reason(sendAny, upload)).toMatch(/"uploadType" is not allowed/);
  });

  it('checks every recipient of a sent message against the allowlist', async () => {
    expect(await ok(sendAcme, send('To: Bob <bob@acme.com>, ada@example.com'))).toBe(true);
    const quoted = send('To: "Smith, Bob" <BOB@ACME.COM>\r\nCc: x@acme.com');
    expect(await ok(sendAcme, quoted)).toBe(true);
    expect(await reason(sendAcme, send('To: bob@acme.com\r\nBcc: eve@evil.com'))).toBe(EVIL);
    expect(await reason(sendAcme, send('To: bob@acme.com,\r\n eve@evil.com'))).toBe(EVIL);
    expect(await reason(sendAcme, send('to: eve@acme.com.evil.com'))).toMatch(/not in the allow/);
    expect(await reason(sendAcme, send('Subject: none'))).toBe('The message has no recipients');
    const resent = send('Resent-To: eve@evil.com\r\nTo: bob@acme.com');
    expect(await reason(sendAcme, resent)).toMatch(/resent-to/);
    // Unrestricted grants send anywhere
    expect(await ok(sendAny, send('To: eve@evil.com'))).toBe(true);
  });

  it('refuses recipients Gmail might read differently', () => {
    expect(parseAddressList('a@b.com, "Doe, J" <j@d.com>')).toEqual(['a@b.com', 'j@d.com']);
    for (const value of [
      'undisclosed:a@b.com;',
      'a@b.com (eve@evil.com)',
      'eve@evil.com <a@b.com>',
      '<a@b.com> <eve@evil.com>',
      'a@b.com eve@evil.com',
      '"eve"@evil.com',
      'a@[1.2.3.4]',
      '"unterminated <a@b.com>',
    ]) {
      expect(() => parseAddressList(value), value).toThrow();
    }
    expect(() => recipientsOf('not base64!')).toThrow(/base64url/);
    const folded = Buffer.from(' folded\r\nTo: a@b.com').toString('base64url');
    expect(() => recipientsOf(folded)).toThrow(/folded/);
  });

  it('forwards the checked send body only', async () => {
    const d = await authz(sendAcme, send('To: bob@acme.com', { threadId: 't1' }));
    expect(d).toMatchObject({ allowed: true, detail: 'send to bob@acme.com' });
    const labels = send('To: bob@acme.com', { labelIds: ['SENT'] });
    expect(await reason(sendAcme, labels)).toBe('Field "labelIds" is not supported when sending');
    const rfc822 = {
      method: 'POST',
      segments: `${ME}/messages/send`.split('/').filter(Boolean),
      search: '',
      headers: new Headers({ 'content-type': 'message/rfc822' }),
      body: Buffer.from('To: eve@evil.com\r\n\r\nhi'),
    };
    expect(gmail.authorize(rfc822, sendAcme, context)).toMatchObject({
      allowed: false,
      reason: 'Send the message as a JSON body',
    });
  });

  it('only sends saved drafts on unrestricted templates', async () => {
    const draft = post('drafts/send', { id: 'd1' });
    expect(await reason(sendAcme, draft)).toMatch(/needs an unrestricted template/);
    expect(await ok(sendAny, draft)).toBe(true);
    // Saving a draft sends nothing, so it isn't limited by the recipient allowlist
    const save = post('drafts', { message: { raw: raw('To: eve@evil.com') } });
    expect(await ok(sendAcme, save)).toBe(true);
  });

  it('validates recipient patterns as resources', () => {
    expect(gmail.validateResource('ada@example.com')).toBeNull();
    expect(gmail.validateResource('*@Example.co.uk')).toBeNull();
    expect(gmail.validateResource('*')).not.toBeNull();
    expect(gmail.validateResource('example.com')).not.toBeNull();
    expect(gmail.validateResource('a*@example.com')).not.toBeNull();
  });

  it('only forwards its own headers upstream', () => {
    const incoming = new Headers({
      cookie: 'x',
      'x-http-method-override': 'DELETE',
      'content-type': 'text/plain',
    });
    const headers = gmail.upstreamHeaders('ya29.real', incoming);
    expect(headers.get('authorization')).toBe('Bearer ya29.real');
    expect(headers.get('content-type')).toBe(JSON_TYPE);
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-http-method-override')).toBeNull();
  });
});

describe('Gmail through the gateway', () => {
  let h: Harness;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  const auth = (key: string) => ['Authorization', `Bearer ${key}`] as const;

  beforeEach(async () => {
    h = await createHarness();
    app = createApp(h.gateway, h.config, { fetch: h.fetch });
    admin = await h.gateway.rotateAdminToken();
  });

  async function session(accountId: string, grant: Grant): Promise<string> {
    const tpl = await request(app)
      .post('/api/admin/templates')
      .set(...auth(admin))
      .send({
        name: 'Mail',
        grants: [{ tool: 'gmail', ...grant }],
        defaultTtlSeconds: 600,
        maxTtlSeconds: 3600,
      })
      .expect(201);
    const s = await request(app)
      .post('/api/admin/sessions')
      .set(...auth(admin))
      .send({ templateId: tpl.body.id, accountId })
      .expect(201);
    return s.body.key as string;
  }

  it('verifies pasted tokens with the profile endpoint', async () => {
    const acc = await request(app)
      .post('/api/admin/accounts')
      .set(...auth(admin))
      .send({ tool: 'gmail', label: 'Inbox', secret: 'ya29.real' })
      .expect(201);
    expect(acc.body.identity).toMatchObject({ login: 'ada@example.com', messages: '42' });
    expect(JSON.stringify(acc.body)).not.toContain('ya29.real');
    await request(app)
      .post('/api/admin/accounts')
      .set(...auth(admin))
      .send({ tool: 'gmail', label: 'Bad', secret: 'ya29.bad' })
      .expect(422);
  });

  it('signs in with Google, refreshes the token, and proxies checked sends', async () => {
    const start = await request(app)
      .post('/api/admin/sign-ins')
      .set(...auth(admin))
      .send({ tool: 'gmail', label: 'Ada' })
      .expect(201);
    const url = new URL(start.body.authorizeUrl as string);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('gmail-client');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.modify');
    expect(url.searchParams.get('access_type')).toBe('offline');
    const state = url.searchParams.get('state') ?? '';
    const done = await request(app)
      .post(`/api/admin/sign-ins/${start.body.flowId as string}/complete`)
      .set(...auth(admin))
      .send({ input: `http://127.0.0.1:8765/?state=${state}&code=good-code&scope=x` })
      .expect(201);
    expect(done.body).toMatchObject({ signedIn: true, identity: { login: 'ada@example.com' } });
    const exchange = h.upstreamCalls.find((c) => c.url === 'https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(new URLSearchParams(exchange?.init.body as string))).toMatchObject({
      client_secret: 'gmail-secret',
      code_verifier: state,
      redirect_uri: 'http://127.0.0.1:8765/',
    });

    // Later, once the access token has expired
    h.clock.now = new Date(h.clock.now.getTime() + 2 * 60 * 60 * 1000);
    const key = await session(done.body.id as string, {
      permissions: ['mail:send'],
      resources: ['*@acme.com'],
    });
    h.upstreamCalls.length = 0;
    const res = await request(app)
      .post(`/proxy/gmail${ME}/messages/send`)
      .set(...auth(key))
      .send({ raw: raw('To: bob@acme.com') })
      .expect(200);
    expect(res.body).toMatchObject({
      url: `https://gmail.googleapis.com${ME}/messages/send`,
      method: 'POST',
    });
    // Refreshed with Google's refresh token, which is kept
    const sent = h.upstreamCalls.at(-1);
    expect(new Headers(sent?.init.headers).get('authorization')).toBe('Bearer ya29.refreshed');

    const denied = await request(app)
      .post(`/proxy/gmail${ME}/messages/send`)
      .set(...auth(key))
      .send({ raw: raw('To: bob@acme.com\r\nCc: eve@evil.com') })
      .expect(403);
    expect(denied.body.message).toBe('Recipient eve@evil.com is not in the allowlist');
    expect(
      h.gateway.activity.recent().some((a) => a.detail === 'mail:send · send to bob@acme.com'),
    ).toBe(true);
  });

  it('has no sign-in without an OAuth client', () => {
    expect(createGmailProvider(fakeGmailFetch([])).oauthSignIn).toBeUndefined();
  });
});
