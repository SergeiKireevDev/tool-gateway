import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createSlackProvider } from '../src/server/tools/slack.js';
import type { AuthzDecision, Grant } from '../src/server/tools/types.js';
import { createHarness, fakeSlackFetch, type Harness } from './helpers.js';

const slack = createSlackProvider(fakeSlackFetch([]));

interface Call {
  method?: string;
  path?: string;
  search?: string;
  body?: string;
  type?: string;
}

const authz = (grant: Grant, call: Call): Promise<AuthzDecision> =>
  Promise.resolve(
    slack.authorize(
      {
        method: call.method ?? 'POST',
        segments: (call.path ?? '/api/chat.postMessage').split('/').filter(Boolean),
        search: call.search ?? '',
        headers: new Headers(call.type ? { 'content-type': call.type } : {}),
        body: call.body === undefined ? undefined : Buffer.from(call.body),
      },
      grant,
      { sessionId: 's', secret: 'unused' },
    ),
  );

const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json; charset=utf-8';
const post = (path: string, args: Record<string, unknown>): Call => ({
  path,
  body: JSON.stringify(args),
  type: JSON_TYPE,
});
const reason = async (grant: Grant, call: Call) => {
  const d = await authz(grant, call);
  return d.allowed ? null : d.reason;
};

const write: Grant = { permissions: ['chat:write'], resources: [] };
const writeC1: Grant = { permissions: ['chat:write', 'history:read'], resources: ['C1111'] };

describe('Slack authorization', () => {
  it('maps methods to permissions and denies the rest', async () => {
    expect(
      (await authz(write, post('/api/chat.postMessage', { channel: 'C9', text: 'hi' }))).allowed,
    ).toBe(true);
    expect(
      await reason(write, {
        method: 'GET',
        path: '/api/conversations.history',
        search: '?channel=C9',
      }),
    ).toBe('Missing permission "history:read"');
    expect(await reason(write, post('/api/admin.users.remove', { user: 'U1' }))).toBe(
      '"admin.users.remove" is not covered by any gateway permission',
    );
    expect(await reason(write, post('/api/files.upload', { channels: 'C9' }))).toMatch(
      /not covered/,
    );
    expect(
      (await authz({ permissions: [], resources: ['C1111'] }, { path: '/api/auth.test' })).allowed,
    ).toBe(true);
  });

  it('only accepts GET/POST on /api/<method>', async () => {
    expect(await reason(write, { method: 'DELETE', path: '/api/chat.delete' })).toBe(
      'Only GET and POST are supported',
    );
    expect(await reason(write, { path: '/api/chat.postMessage/x' })).toMatch(
      /Only \/api\/<method>/,
    );
    expect(await reason(write, { path: '/other/chat.postMessage' })).toMatch(
      /Only \/api\/<method>/,
    );
  });

  it('limits channel-restricted grants to the allowlisted channel IDs', async () => {
    const msg = (channel: unknown) => post('/api/chat.postMessage', { channel, text: 'hi' });
    expect((await authz(writeC1, msg('C1111'))).allowed).toBe(true);
    expect(await reason(writeC1, msg('C2222'))).toBe('Channel C2222 is not in the allowlist');
    expect(await reason(writeC1, msg('#general'))).toMatch(/needs a channel ID/);
    expect(await reason(writeC1, msg('U1111'))).toMatch(/needs a channel ID/);
    expect(await reason(writeC1, msg(['C1111']))).toMatch(/needs a channel ID/);
    expect(await reason(writeC1, post('/api/chat.postMessage', { text: 'hi' }))).toMatch(
      /needs a channel ID/,
    );
    expect(await reason(writeC1, post('/api/conversations.open', { users: 'U2' }))).toMatch(
      /needs an unrestricted template/,
    );
    expect((await authz(write, post('/api/conversations.open', { users: 'U2' }))).allowed).toBe(
      true,
    );
    const dir: Grant = { permissions: ['users:read', 'channels:read'], resources: ['C1111'] };
    expect((await authz(dir, { method: 'GET', path: '/api/users.list' })).allowed).toBe(true);
    expect((await authz(dir, { method: 'GET', path: '/api/conversations.list' })).allowed).toBe(
      true,
    );
  });

  it('checks the channel wherever it is passed, and rejects ambiguity', async () => {
    const hist = '/api/conversations.history';
    expect(
      (await authz(writeC1, { method: 'GET', path: hist, search: '?channel=C1111' })).allowed,
    ).toBe(true);
    expect((await authz(writeC1, { path: hist, body: 'channel=C1111', type: FORM })).allowed).toBe(
      true,
    );
    expect(await reason(writeC1, { path: hist, body: 'channel=C2222', type: FORM })).toBe(
      'Channel C2222 is not in the allowlist',
    );
    // Query + body, or the same argument twice, could be read differently upstream
    expect(
      await reason(writeC1, {
        path: hist,
        search: '?channel=C1111',
        body: 'channel=C2222',
        type: FORM,
      }),
    ).toBe('Argument "channel" is given more than once');
    expect(
      await reason(writeC1, { method: 'GET', path: hist, search: '?channel=C1111&channel=C2222' }),
    ).toMatch(/more than once/);
    expect(
      await reason(writeC1, { path: hist, body: 'channel=C1111&token=xoxp-other', type: FORM }),
    ).toMatch(/Authorization header/);
    expect(
      await reason(writeC1, { path: hist, body: '{"channel":"C1111"}', type: 'text/plain' }),
    ).toMatch(/Unsupported content type/);
    expect(await reason(writeC1, { path: hist, body: '[1]', type: JSON_TYPE })).toMatch(
      /object of arguments/,
    );
  });

  it('forwards one canonical form POST with every argument', async () => {
    const d = await authz(writeC1, {
      path: '/api/chat.postMessage',
      search: '?unfurl_links=false',
      body: JSON.stringify({
        channel: 'C1111',
        text: 'hi',
        blocks: [{ type: 'divider' }],
        mrkdwn: true,
      }),
      type: JSON_TYPE,
    });
    expect(d).toMatchObject({
      allowed: true,
      method: 'POST',
      search: '',
      detail: 'chat.postMessage C1111',
    });
    if (!d.allowed) return;
    expect(Object.fromEntries(new URLSearchParams(String(d.body)))).toEqual({
      unfurl_links: 'false',
      channel: 'C1111',
      text: 'hi',
      blocks: '[{"type":"divider"}]',
      mrkdwn: 'true',
    });
    const headers = slack.upstreamHeaders(
      'xoxb-real',
      new Headers({ cookie: 'x', 'content-type': JSON_TYPE }),
    );
    expect(headers.get('authorization')).toBe('Bearer xoxb-real');
    expect(headers.get('content-type')).toBe(FORM);
    expect(headers.get('cookie')).toBeNull();
  });

  it('validates channel IDs as resources', () => {
    expect(slack.validateResource('C0123456789')).toBeNull();
    expect(slack.validateResource('G01ABCDEF')).toBeNull();
    expect(slack.validateResource('#general')).not.toBeNull();
    expect(slack.validateResource('c0123')).not.toBeNull();
    expect(slack.validateResource('U0123456')).not.toBeNull();
  });
});

describe('Slack through the proxy', () => {
  let h: Harness;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  const auth = (key: string) => ['Authorization', `Bearer ${key}`] as const;

  beforeEach(async () => {
    h = await createHarness();
    app = createApp(h.gateway, h.config, { fetch: h.fetch });
    admin = await h.gateway.rotateAdminToken();
  });

  it('verifies tokens with auth.test', async () => {
    const acc = await request(app)
      .post('/api/admin/accounts')
      .set(...auth(admin))
      .send({ tool: 'slack', label: 'Bot', secret: 'xoxb-real' })
      .expect(201);
    expect(acc.body.identity).toMatchObject({
      login: 'gatebot',
      team: 'Acme',
      tokenType: 'bot token',
      scopes: 'chat:write,channels:history',
    });
    expect(JSON.stringify(acc.body)).not.toContain('xoxb-real');
    await request(app)
      .post('/api/admin/accounts')
      .set(...auth(admin))
      .send({ tool: 'slack', label: 'Bad', secret: 'xoxb-bad' })
      .expect(422);
  });

  it('proxies allowed calls canonically with the real token, and denies the rest', async () => {
    const acc = await request(app)
      .post('/api/admin/accounts')
      .set(...auth(admin))
      .send({ tool: 'slack', label: 'Bot', secret: 'xoxb-real' })
      .expect(201);
    const tpl = await request(app)
      .post('/api/admin/templates')
      .set(...auth(admin))
      .send({
        tool: 'slack',
        name: 'Post to #eng',
        permissions: ['chat:write'],
        resources: ['C1111'],
        defaultTtlSeconds: 600,
        maxTtlSeconds: 3600,
      })
      .expect(201);
    const session = await request(app)
      .post('/api/admin/sessions')
      .set(...auth(admin))
      .send({ templateId: tpl.body.id, accountId: acc.body.id })
      .expect(201);
    const key = session.body.key as string;

    h.upstreamCalls.length = 0;
    const res = await request(app)
      .post('/proxy/slack/api/chat.postMessage')
      .set(...auth(key))
      .send({ channel: 'C1111', text: 'deployed ✅' })
      .expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      url: 'https://slack.com/api/chat.postMessage',
      method: 'POST',
    });
    expect(Object.fromEntries(new URLSearchParams(res.body.body as string))).toEqual({
      channel: 'C1111',
      text: 'deployed ✅',
    });
    expect(new Headers(h.upstreamCalls[0]?.init.headers).get('authorization')).toBe(
      'Bearer xoxb-real',
    );

    // Methods outside the template are denied before reaching Slack
    const noPerm = await request(app)
      .get('/proxy/slack/api/chat.getPermalink?channel=C1111&message_ts=1.2')
      .set(...auth(key))
      .expect(403);
    expect(noPerm.body.message).toBe('Missing permission "history:read"');
    const denied = await request(app)
      .post('/proxy/slack/api/chat.postMessage')
      .set(...auth(key))
      .type('form')
      .send('channel=C2222&text=nope')
      .expect(403);
    expect(denied.body.message).toBe('Channel C2222 is not in the allowlist');
    expect(h.upstreamCalls).toHaveLength(1);
    expect(
      h.gateway.activity.recent().some((a) => a.detail === 'chat:write · chat.postMessage C1111'),
    ).toBe(true);
  });

  it('rejects templates with non-channel resources', async () => {
    await request(app)
      .post('/api/admin/templates')
      .set(...auth(admin))
      .send({
        tool: 'slack',
        name: 'x',
        permissions: ['chat:write'],
        resources: ['#general'],
        defaultTtlSeconds: 600,
        maxTtlSeconds: 3600,
      })
      .expect(400);
  });
});
