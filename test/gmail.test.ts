import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createGmailProvider } from '../src/server/tools/gmail.js';
import type { ToolRequest } from '../src/server/tools/types.js';
import { createHarness, fakeGmailFetch } from './helpers.js';

const gmail = createGmailProvider(fakeGmailFetch([]));
const ROOT = '/gmail/v1/users/me';
const authz = (
  permission: string,
  method: string,
  path: string,
  extra: Partial<ToolRequest> = {},
  resources: string[] = [],
) =>
  gmail.authorize(
    {
      method,
      segments: `${ROOT}/${path}`.split('/').filter(Boolean),
      search: '',
      headers: new Headers(),
      body: undefined,
      ...extra,
    },
    { permissions: [permission], resources },
    { sessionId: 's', secret: 'unused', tokensRemaining: null },
  );

const ENDPOINTS = [
  [
    'messages:read',
    'GET',
    [
      'profile',
      'messages',
      'messages/abc',
      'messages/abc/attachments/xyz',
      'threads',
      'threads/abc',
      'drafts',
      'drafts/abc',
      'history',
    ],
  ],
  [
    'messages:write',
    'POST',
    [
      'messages/abc/modify',
      'messages/abc/trash',
      'messages/abc/untrash',
      'messages/batchModify',
      'threads/abc/modify',
      'threads/abc/trash',
      'threads/abc/untrash',
    ],
  ],
  ['messages:send', 'POST', ['messages/send', 'drafts/send']],
  ['messages:delete', 'DELETE', ['messages/abc', 'threads/abc']],
  ['messages:delete', 'POST', ['messages/batchDelete']],
  ['drafts:write', 'POST', ['drafts']],
  ['drafts:write', 'PUT', ['drafts/abc']],
  ['drafts:write', 'DELETE', ['drafts/abc']],
  ['labels:read', 'GET', ['labels', 'labels/abc']],
  ['labels:write', 'POST', ['labels']],
  ['labels:write', 'PUT', ['labels/abc']],
  ['labels:write', 'PATCH', ['labels/abc']],
  ['labels:write', 'DELETE', ['labels/abc']],
] as const;

describe('Gmail authorization', () => {
  for (const [permission, method, paths] of ENDPOINTS) {
    it(`maps ${method} ${paths.join(', ')} to ${permission}`, async () => {
      for (const path of paths) {
        expect(await authz(permission, method, path)).toMatchObject({ allowed: true, permission });
        expect(await authz('unrelated', method, path)).toMatchObject({
          allowed: false,
          reason: `Missing permission "${permission}"`,
        });
      }
    });
  }

  it('denies unrecognized endpoints and verbs', async () => {
    for (const path of [
      'settings/forwardingAddresses',
      'settings/delegates',
      'watch',
      'stop',
      'messages/import',
      'messages/insert',
      'messages/abc/send',
      'profile/extra',
    ]) {
      expect(await authz('messages:write', 'POST', path)).toMatchObject({ allowed: false });
    }
    expect(await authz('messages:read', 'HEAD', 'messages')).toMatchObject({ allowed: false });
    expect(await authz('messages:write', 'POST', 'messages/send')).toMatchObject({ allowed: false });
    expect(await authz('drafts:write', 'POST', 'drafts/send')).toMatchObject({ allowed: false });
    expect(await authz('messages:write', 'DELETE', 'messages/abc')).toMatchObject({ allowed: false });
  });

  it('only permits the connected mailbox and rejects resource restrictions', async () => {
    for (const path of [
      '/gmail/v1/users/other@example.com/messages',
      '/gmail/v1/users/me',
      '/batch/gmail/v1',
      '/upload/gmail/v1/users/me/messages/send',
    ]) {
      const result = await authz('messages:read', 'GET', '', {
        segments: path.split('/').filter(Boolean),
      });
      expect(result).toMatchObject({ allowed: false });
    }
    expect(await authz('messages:read', 'GET', 'messages', {}, ['INBOX'])).toMatchObject({
      allowed: false,
    });
    expect(gmail.validateResource('INBOX')).not.toBeNull();
  });

  it('rejects query credentials, method overrides and ambiguous parameters', async () => {
    const result = await authz('messages:read', 'GET', 'messages', {
      search: '?q=is%3Aunread&labelIds=INBOX&labelIds=STARRED&maxResults=10',
    });
    expect(result).toMatchObject({ allowed: true });
    for (const search of [
      '?access_token=secret',
      '?key=secret',
      '?$httpMethod=DELETE',
      '?_method=DELETE',
      '?alt=media',
      '?alt=proto',
      '?q=a&q=b',
      '?unknown=x',
    ]) {
      expect(await authz('messages:read', 'GET', 'messages', { search })).toMatchObject({
        allowed: false,
      });
    }
    const writeQuery = await authz('messages:send', 'POST', 'messages/send', { search: '?q=x' });
    expect(writeQuery).toMatchObject({ allowed: false });
    const responseQuery = await authz('messages:send', 'POST', 'messages/send', {
      search: '?alt=json&fields=id',
    });
    expect(responseQuery).toMatchObject({ allowed: true });
  });

  it('checks JSON bodies and forwards canonical JSON with safe headers', async () => {
    const extra = {
      headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
      body: Buffer.from(' { "raw": "YWJj" } '),
    };
    const decision = await authz('messages:send', 'POST', 'messages/send', extra);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.body?.toString()).toBe('{"raw":"YWJj"}');
    for (const body of ['[]', 'null', 'invalid']) {
      const invalid = await authz('messages:send', 'POST', 'messages/send', {
        ...extra,
        body: Buffer.from(body),
      });
      expect(invalid).toMatchObject({ allowed: false });
    }
    const mimeBody = await authz('messages:send', 'POST', 'messages/send', {
      ...extra,
      headers: new Headers({ 'content-type': 'message/rfc822' }),
    });
    expect(mimeBody).toMatchObject({ allowed: false });
    expect(await authz('messages:read', 'GET', 'messages', extra)).toMatchObject({ allowed: false });
    expect(await authz('messages:delete', 'DELETE', 'messages/abc', extra)).toMatchObject({
      allowed: false,
    });
    const headers = gmail.upstreamHeaders(
      'real-token',
      new Headers({ authorization: 'fake', cookie: 'x', 'x-http-method-override': 'DELETE' }),
    );
    expect(headers.get('authorization')).toBe('Bearer real-token');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-http-method-override')).toBeNull();
  });

  it('verifies tokens with the profile without exposing Google error bodies', async () => {
    expect(await gmail.verifyCredential('real-token')).toEqual({ login: 'agent@example.com' });
    await expect(gmail.verifyCredential('bad-token')).rejects.toThrow(/HTTP 401/);
    const invalid = createGmailProvider(() => Promise.resolve(Response.json({ emailAddress: 42 })));
    await expect(invalid.verifyCredential('token')).rejects.toThrow(/Gmail rejected/);
  });
});

describe('Gmail through the proxy', () => {
  it('connects accounts and enforces session permissions before forwarding', async () => {
    const h = await createHarness();
    const app = createApp(h.gateway, h.config, { fetch: h.fetch });
    const admin = await h.gateway.rotateAdminToken();
    const auth = (key: string) => ['Authorization', `Bearer ${key}`] as const;
    const tools = await request(app).get('/api/admin/tools').set(...auth(admin)).expect(200);
    expect(JSON.stringify(tools.body)).toContain('gmail');
    const account = await request(app)
      .post('/api/admin/accounts')
      .set(...auth(admin))
      .send({ tool: 'gmail', label: 'Mailbox', secret: 'real-token' })
      .expect(201);
    expect(account.body.identity.login).toBe('agent@example.com');
    expect(JSON.stringify(account.body)).not.toContain('real-token');
    await request(app)
      .post('/api/admin/accounts')
      .set(...auth(admin))
      .send({ tool: 'gmail', label: 'Bad', secret: 'bad-token' })
      .expect(422);
    const grant = { tool: 'gmail', permissions: ['messages:send'], resources: [] };
    const template = await request(app)
      .post('/api/admin/templates')
      .set(...auth(admin))
      .send({
        name: 'Send mail',
        grants: [grant],
        defaultTtlSeconds: 600,
        maxTtlSeconds: 3600,
      })
      .expect(201);
    const session = await request(app)
      .post('/api/admin/sessions')
      .set(...auth(admin))
      .send({ templateId: template.body.id, accountId: account.body.id })
      .expect(201);
    const key = session.body.key as string;
    h.upstreamCalls.length = 0;
    const result = await request(app)
      .post(`/proxy/gmail${ROOT}/messages/send`)
      .set(...auth(key))
      .send({ raw: 'YWJj' })
      .expect(200);
    expect(result.body).toMatchObject({
      url: `https://gmail.googleapis.com${ROOT}/messages/send`,
      method: 'POST',
      body: '{"raw":"YWJj"}',
    });
    expect(new Headers(h.upstreamCalls[0]?.init.headers).get('authorization')).toBe(
      'Bearer real-token',
    );
    for (const path of [`${ROOT}/messages`, '/gmail/v1/users/other@example.com/messages']) {
      await request(app).get(`/proxy/gmail${path}`).set(...auth(key)).expect(403);
    }
    await request(app)
      .post(`/proxy/gmail${ROOT}/messages/send?$httpMethod=DELETE`)
      .set(...auth(key))
      .send({ raw: 'YWJj' })
      .expect(403);
    expect(h.upstreamCalls).toHaveLength(1);
    await request(app)
      .post('/api/admin/templates')
      .set(...auth(admin))
      .send({
        name: 'Label scoped',
        grants: [{ ...grant, resources: ['INBOX'] }],
        defaultTtlSeconds: 600,
        maxTtlSeconds: 3600,
      })
      .expect(400);
  });
});
