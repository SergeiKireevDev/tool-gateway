import { once } from 'node:events';
import { get, type ClientRequest } from 'node:http';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;

const auth = (token: string): [string, string] => ['authorization', `Bearer ${token}`];

async function setup(templateOverrides: Record<string, unknown> = {}): Promise<{
  accountId: string;
  templateId: string;
}> {
  const acc = await request(app)
    .post('/api/admin/accounts')
    .set(...auth(admin))
    .send({ tool: 'github', label: 'Personal', secret: 'ghp_realtoken' })
    .expect(201);
  const tpl = await request(app)
    .post('/api/admin/templates')
    .set(...auth(admin))
    .send({
      name: 'Issues RO',
      grants: [{ tool: 'github', permissions: ['issues:read'], resources: ['o/r'] }],
      defaultTtlSeconds: 600,
      maxTtlSeconds: 3600,
      ...templateOverrides,
    })
    .expect(201);
  return { accountId: acc.body.id as string, templateId: tpl.body.id as string };
}

async function issue(templateId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post('/api/admin/sessions')
    .set(...auth(admin))
    .send({ templateId, ...extra })
    .expect(201);
  return res.body.key as string;
}

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
});

describe('admin API', () => {
  it('requires the admin token', async () => {
    await request(app).get('/api/admin/accounts').expect(401);
    await request(app)
      .get('/api/admin/accounts')
      .set(...auth('gwa_wrong'))
      .expect(401);
    await request(app)
      .get('/api/admin/accounts')
      .set(...auth(admin))
      .expect(200, []);
  });

  it('verifies credentials and never returns secrets', async () => {
    await setup();
    const res = await request(app)
      .get('/api/admin/accounts')
      .set(...auth(admin))
      .expect(200);
    expect(res.body[0]).toMatchObject({
      label: 'Personal',
      secretHint: '…oken',
      identity: { login: 'octocat', tokenType: 'classic PAT', connectedVia: 'pasted token' },
    });
    expect(JSON.stringify(res.body)).not.toContain('ghp_realtoken');
  });

  it('rejects credentials the tool refuses', async () => {
    const res = await request(app)
      .post('/api/admin/accounts')
      .set(...auth(admin))
      .send({ tool: 'github', label: 'x', secret: 'bad-token' })
      .expect(422);
    expect(res.body.message).toMatch(/HTTP 401/);
  });

  it('validates templates', async () => {
    const base = { name: 'T', defaultTtlSeconds: 600, maxTtlSeconds: 3600 };
    const gh = (permissions: string[], resources: string[] = []) => ({
      tool: 'github',
      permissions,
      resources,
    });
    const post = (body: object) =>
      request(app)
        .post('/api/admin/templates')
        .set(...auth(admin))
        .send(body);
    await post({ ...base, grants: [] }).expect(400);
    await post({ ...base, grants: [gh([])] }).expect(400);
    await post({ ...base, grants: [gh(['nope:read'])] }).expect(400);
    await post({ ...base, grants: [gh(['issues:read'], ['bad pattern'])] }).expect(400);
    await post({ ...base, grants: [{ tool: 'nope', permissions: ['x'] }] }).expect(400);
    await post({ ...base, grants: [gh(['issues:read']), gh(['pulls:read'])] }).expect(400);
    await post({ ...base, grants: [gh(['issues:read'])], defaultTtlSeconds: 7200 }).expect(400);
    // A grant's permissions are checked against its own tool.
    await post({ ...base, grants: [{ tool: 'monday', permissions: ['issues:read'] }] }).expect(400);
    await post({ ...base, grants: [gh(['issues:read'])] }).expect(201);
    await post({ ...base, grants: [gh(['issues:read'])] }).expect(409);
  });

  it('caps session TTL at the template maximum', async () => {
    const { templateId } = await setup();
    await request(app)
      .post('/api/admin/sessions')
      .set(...auth(admin))
      .send({ templateId, ttlSeconds: 7200 })
      .expect(400);
  });
});

describe('proxy', () => {
  it('forwards allowed requests with the real credential injected', async () => {
    const { templateId } = await setup();
    const key = await issue(templateId, { label: 'agent' });
    expect(key).toMatch(/^gws_/);

    const res = await request(app)
      .get('/proxy/github/repos/o/r/issues?state=open')
      .set(...auth(key))
      .expect(200);
    expect(res.body).toEqual({
      url: 'https://api.github.com/repos/o/r/issues?state=open',
      method: 'GET',
    });
    const call = h.upstreamCalls.at(-1);
    const sent = new Headers(call?.init.headers);
    expect(sent.get('authorization')).toBe('Bearer ghp_realtoken');
    expect(sent.get('x-github-api-version')).toBe('2022-11-28');
    // Pagination links point back at the gateway; cookies are dropped.
    expect(res.headers.link).toBe(
      '<http://gateway.test/proxy/github/repos/o/r/issues?page=2>; rel="next"',
    );
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('preserves the original request when there are no overrides and relays redirects', async () => {
    const { templateId } = await setup({
      grants: [{ tool: 'github', permissions: ['issues:write'], resources: ['o/r'] }],
    });
    const key = await issue(templateId);
    const location = 'https://elsewhere.test/issues';
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    app = createApp(h.gateway, h.config, { fetch: upstream });
    const body = JSON.stringify({ title: 'Keep these bytes' });

    await request(app)
      .post('/proxy/github/repos/o/r/issues?state=open')
      .set(...auth(key))
      .type('json')
      .send(body)
      .expect(302)
      .expect('location', location);

    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0] ?? [];
    expect(url).toBe('https://api.github.com/repos/o/r/issues?state=open');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(init?.body).toEqual(Buffer.from(body));
  });

  it('honors canonical method, body and empty-query overrides from the tool', async () => {
    const account = await h.gateway.createAccount({
      tool: 'slack',
      label: 'Bot',
      secret: 'xoxb-real',
    });
    const template = await h.gateway.createTemplate({
      name: 'Chat',
      grants: [{ tool: 'slack', permissions: ['chat:write'], resources: ['C1111'] }],
      defaultTtlSeconds: 600,
      maxTtlSeconds: 3600,
    });
    const { key } = await h.gateway.issueSession({
      templateId: template.id,
      accountId: account.id,
    });
    h.upstreamCalls.length = 0;

    await request(app)
      .get('/proxy/slack/api/chat.postMessage?channel=C1111&text=hello')
      .set(...auth(key))
      .expect(200);

    expect(h.upstreamCalls).toHaveLength(1);
    const call = h.upstreamCalls[0];
    expect(call?.url).toBe('https://slack.com/api/chat.postMessage');
    expect(call?.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(call?.init.body).toEqual(Buffer.from('channel=C1111&text=hello'));
    expect(new Headers(call?.init.headers).get('authorization')).toBe('Bearer xoxb-real');
    expect(h.gateway.activity.recent()[0]).toMatchObject({
      method: 'GET',
      decision: 'allowed',
      detail: 'chat:write · chat.postMessage C1111',
    });
  });

  it('reports upstream failures as allowed attempts with a 502 and records usage', async () => {
    const { templateId } = await setup();
    const key = await issue(templateId, { label: 'failed request' });
    const upstream = vi.fn<typeof fetch>().mockRejectedValue(new Error('Connection reset'));
    app = createApp(h.gateway, h.config, { fetch: upstream });

    const res = await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .expect(502);

    expect(res.body).toEqual({
      error: 'gateway_error',
      message: 'Upstream request failed: Connection reset',
    });
    expect(res.headers['x-gateway-denied']).toBeUndefined();
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(h.gateway.activity.recent()[0]).toMatchObject({
      kind: 'proxy',
      sessionLabel: 'failed request',
      tool: 'github',
      method: 'GET',
      path: '/repos/o/r/issues',
      status: 502,
      decision: 'allowed',
      detail: 'Upstream error: Connection reset',
    });
    expect(h.gateway.listSessions()[0]?.requestCount).toBe(1);
  });

  it('aborts an in-flight upstream request when the client disconnects', async () => {
    const { templateId } = await setup();
    const key = await issue(templateId);
    let signal: AbortSignal | null | undefined;
    const upstream = vi.fn<typeof fetch>((_input, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('Upstream aborted'));
          },
          { once: true },
        );
      });
    });
    app = createApp(h.gateway, h.config, { fetch: upstream });
    const server = app.listen(0, '127.0.0.1');
    let client: ClientRequest | undefined;
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      client = get({
        host: '127.0.0.1',
        port: address.port,
        path: '/proxy/github/repos/o/r/issues',
        headers: { authorization: `Bearer ${key}` },
        agent: false,
      });
      // Destroying a request before a response is expected to raise ECONNRESET.
      client.on('error', () => undefined);
      await vi.waitFor(() => {
        expect(signal).toBeInstanceOf(AbortSignal);
      });
      expect(signal?.aborted).toBe(false);

      client.destroy();

      await vi.waitFor(() => {
        expect(signal?.aborted).toBe(true);
      });
      await vi.waitFor(() => {
        expect(h.gateway.activity.recent()[0]).toMatchObject({
          kind: 'proxy',
          decision: 'allowed',
          status: 502,
          detail: 'Upstream error: Upstream aborted',
        });
      });
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(h.gateway.listSessions()[0]?.requestCount).toBe(1);
    } finally {
      client?.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  it('accepts the `token` scheme used by gh / Octokit', async () => {
    const { templateId } = await setup();
    const key = await issue(templateId);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set('authorization', `token ${key}`)
      .expect(200);
  });

  it('denies requests outside the template without calling upstream', async () => {
    const { templateId } = await setup();
    const key = await issue(templateId);
    const before = h.upstreamCalls.length;
    await request(app)
      .post('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .send({})
      .expect(403);
    await request(app)
      .get('/proxy/github/repos/o/other/issues')
      .set(...auth(key))
      .expect(403);
    await request(app)
      .get('/proxy/github/repos/o/r/../x/issues')
      .set(...auth(key))
      .expect(400);
    await request(app)
      .get('/proxy/github/repos/o/r/%2e%2e/x')
      .set(...auth(key))
      .expect(400);
    await request(app)
      .get('/proxy/gitlab/repos/o/r/issues')
      .set(...auth(key))
      .expect(403);
    expect(h.upstreamCalls.length).toBe(before);
    expect(h.gateway.listSessions()[0]?.requestCount).toBe(0);
  });

  it('rejects missing, unknown, expired and revoked keys', async () => {
    const { templateId } = await setup();
    await request(app).get('/proxy/github/repos/o/r/issues').expect(401);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth('gws_nope'))
      .expect(401);

    const key = await issue(templateId, { ttlSeconds: 60 });
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .expect(200);
    h.clock.now = new Date(h.clock.now.getTime() + 61_000);
    const expired = await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .expect(401);
    expect(expired.body.message).toMatch(/expired/);

    const key2 = await issue(templateId);
    const sessions = await request(app)
      .get('/api/admin/sessions')
      .set(...auth(admin));
    const active = (sessions.body as { id: string; status: string }[]).find(
      (s) => s.status === 'active',
    );
    await request(app)
      .post(`/api/admin/sessions/${active?.id ?? ''}/revoke`)
      .set(...auth(admin))
      .expect(200);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth(key2))
      .expect(401);
  });

  it('snapshots permissions: editing a template does not widen live keys', async () => {
    const { templateId } = await setup();
    const key = await issue(templateId);
    await request(app)
      .put(`/api/admin/templates/${templateId}`)
      .set(...auth(admin))
      .send({
        name: 'Issues RW',
        grants: [{ tool: 'github', permissions: ['issues:read', 'issues:write'], resources: [] }],
        defaultTtlSeconds: 600,
        maxTtlSeconds: 3600,
      })
      .expect(200);
    await request(app)
      .post('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .send({})
      .expect(403);
  });

  it('revokes sessions when their account is removed', async () => {
    const { accountId, templateId } = await setup();
    const key = await issue(templateId);
    await request(app)
      .delete(`/api/admin/accounts/${accountId}`)
      .set(...auth(admin))
      .expect(204);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .expect(401);
  });

  it('exposes session introspection and usage stats', async () => {
    const { templateId } = await setup();
    const key = await issue(templateId);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...auth(key))
      .expect(200);
    const info = await request(app)
      .get('/api/session')
      .set(...auth(key))
      .expect(200);
    expect(info.body).toMatchObject({
      template: 'Issues RO',
      grants: [
        {
          tool: 'github',
          account: { label: 'Personal' },
          permissions: ['issues:read'],
          resources: ['o/r'],
          proxyBaseUrl: 'http://gateway.test/proxy/github',
        },
      ],
    });
    await h.gateway.flush();
    const list = await request(app)
      .get('/api/admin/sessions')
      .set(...auth(admin));
    expect(list.body[0]).toMatchObject({ requestCount: 1, status: 'active' });
    expect(list.body[0].keyHash).toBeUndefined();
  });
});
