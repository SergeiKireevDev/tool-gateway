import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { migrate } from '../src/server/store/migrate.js';
import { STORE_VERSION } from '../src/server/store/types.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;
let ids: { github: string; monday: string; template: string };

const bearer = (token: string): [string, string] => ['authorization', `Bearer ${token}`];
const adminPost = (path: string, body: object) =>
  request(app)
    .post(`/api/admin${path}`)
    .set(...bearer(admin))
    .send(body);
const account = async (tool: string, label: string, secret: string): Promise<string> =>
  (await adminPost('/accounts', { tool, label, secret }).expect(201)).body.id as string;

/** Open pull requests on o/r, and read board 1 / write its items on monday.com. */
const HYBRID = {
  name: 'Release agent',
  grants: [
    { tool: 'github', permissions: ['pulls:write'], resources: ['o/r'] },
    { tool: 'monday', permissions: ['boards:read', 'items:write'], resources: ['1'] },
  ],
  defaultTtlSeconds: 600,
  maxTtlSeconds: 3600,
};

const mondayQuery = (key: string, query: string) =>
  request(app)
    .post('/proxy/monday/v2')
    .set(...bearer(key))
    .send({ query });

async function issue(body: object = {}): Promise<string> {
  const res = await adminPost('/sessions', { templateId: ids.template, ...body }).expect(201);
  return res.body.key as string;
}

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
  ids = {
    github: await account('github', 'GitHub bot', 'ghp_hybrid'),
    monday: await account('monday', 'Work', 'monday-token'),
    template: (await adminPost('/templates', HYBRID).expect(201)).body.id as string,
  };
});

describe('templates spanning several tools', () => {
  it('issues one key bound to an account per tool', async () => {
    const res = await adminPost('/sessions', { templateId: ids.template }).expect(201);
    expect(res.body.session.grants).toEqual([
      { tool: 'github', accountId: ids.github, permissions: ['pulls:write'], resources: ['o/r'] },
      {
        tool: 'monday',
        accountId: ids.monday,
        permissions: ['boards:read', 'items:write'],
        resources: ['1'],
      },
    ]);
  });

  it('authorizes each tool with its own grant and credential', async () => {
    const key = await issue();
    h.upstreamCalls.length = 0;

    await request(app)
      .post('/proxy/github/repos/o/r/pulls')
      .set(...bearer(key))
      .send({ title: 'Release', head: 'release', base: 'main' })
      .expect(200);
    expect(new Headers(h.upstreamCalls.at(-1)?.init.headers).get('authorization')).toBe(
      'Bearer ghp_hybrid',
    );

    await mondayQuery(key, '{ boards(ids: 1) { id } }').expect(200);
    expect(new Headers(h.upstreamCalls.at(-1)?.init.headers).get('authorization')).toBe(
      'monday-token',
    );
    await mondayQuery(
      key,
      'mutation { create_item(board_id: 1, item_name: "Ship") { id } }',
    ).expect(200);
    const callsSoFar = h.upstreamCalls.length;

    // Each tool keeps its own resource allowlist and permissions.
    await request(app)
      .post('/proxy/github/repos/x/y/pulls')
      .set(...bearer(key))
      .send({})
      .expect(403);
    await request(app)
      .get('/proxy/github/repos/o/r/issues')
      .set(...bearer(key))
      .expect(403);
    await mondayQuery(key, '{ boards(ids: 2) { id } }').expect(403);
    expect(h.upstreamCalls).toHaveLength(callsSoFar);
  });

  it('denies tools the key does not cover', async () => {
    const key = await issue();
    const res = await request(app)
      .post('/proxy/slack/api/chat.postMessage')
      .set(...bearer(key))
      .send({ channel: 'C1111', text: 'hi' })
      .expect(403);
    expect(res.body.message).toBe('This session key is for "github", "monday", not "slack"');
  });

  it('introspects every grant', async () => {
    const key = await issue();
    const info = await request(app)
      .get('/api/session')
      .set(...bearer(key))
      .expect(200);
    expect(info.body).toMatchObject({
      template: 'Release agent',
      grants: [
        {
          tool: 'github',
          account: { label: 'GitHub bot' },
          proxyBaseUrl: 'http://gateway.test/proxy/github',
        },
        {
          tool: 'monday',
          account: { label: 'Work' },
          proxyBaseUrl: 'http://gateway.test/proxy/monday',
        },
      ],
    });
    expect(JSON.stringify(info.body)).not.toContain('ghp_hybrid');
  });

  it('picks accounts per tool, and asks when a tool has several', async () => {
    const second = await account('github', 'Other bot', 'ghp_other');
    const ambiguous = await adminPost('/sessions', { templateId: ids.template }).expect(400);
    expect(ambiguous.body.message).toMatch(/Several github accounts/);
    await adminPost('/sessions', {
      templateId: ids.template,
      accountIds: [ids.github, second],
    }).expect(400);

    // Only the ambiguous tool needs naming; monday still has a single account.
    const res = await adminPost('/sessions', {
      templateId: ids.template,
      accountIds: [second],
    }).expect(201);
    expect(res.body.session.grants).toMatchObject([
      { accountId: second },
      { accountId: ids.monday },
    ]);
    // The single-account form still works.
    await adminPost('/sessions', { templateId: ids.template, accountId: second }).expect(201);
  });

  it('refuses accounts for tools outside the template', async () => {
    const slack = await account('slack', 'Bot', 'xoxb-real');
    const res = await adminPost('/sessions', {
      templateId: ids.template,
      accountIds: [ids.github, slack],
    }).expect(400);
    expect(res.body.message).toMatch(/does not cover slack/);
  });

  it('needs an account for every tool of the template', async () => {
    await request(app)
      .delete(`/api/admin/accounts/${ids.monday}`)
      .set(...bearer(admin))
      .expect(204);
    const res = await adminPost('/sessions', { templateId: ids.template }).expect(400);
    expect(res.body.message).toBe('No monday account available');
  });

  it('revokes the whole key when any of its accounts is removed', async () => {
    const key = await issue();
    await request(app)
      .delete(`/api/admin/accounts/${ids.monday}`)
      .set(...bearer(admin))
      .expect(204);
    await request(app)
      .post('/proxy/github/repos/o/r/pulls')
      .set(...bearer(key))
      .send({})
      .expect(401);
  });

  it('lets members issue hybrid keys only with accounts they may use for every tool', async () => {
    const member = await adminPost('/members', {
      name: 'release-bot',
      templateIds: [ids.template],
      accountIds: [ids.monday],
    }).expect(201);
    const memberKey = member.body.key as string;
    const asMember = (body: object) =>
      request(app)
        .post('/api/sessions')
        .set(...bearer(memberKey))
        .send({ templateId: ids.template, ...body });

    // The shared GitHub account was not granted, so the member has none for that tool.
    expect((await asMember({}).expect(400)).body.message).toBe('No github account available');
    await asMember({ accountIds: [ids.github] }).expect(403);

    await request(app)
      .put(`/api/admin/members/${member.body.member.id as string}`)
      .set(...bearer(admin))
      .send({
        name: 'release-bot',
        templateIds: [ids.template],
        accountIds: [ids.monday, ids.github],
      })
      .expect(200);
    const res = await asMember({}).expect(201);
    expect(res.body.session.issuedBy).toMatchObject({ kind: 'member', memberName: 'release-bot' });

    const view = await request(app)
      .get('/api/member')
      .set(...bearer(memberKey))
      .expect(200);
    expect(view.body.templates[0].grants).toMatchObject([{ tool: 'github' }, { tool: 'monday' }]);
  });
});

describe('store migration', () => {
  it('turns single-tool templates and sessions into one grant', () => {
    const state = migrate({
      version: 1,
      templates: [
        {
          id: 't1',
          tool: 'github',
          name: 'RO',
          description: '',
          permissions: ['issues:read'],
          resources: ['o/r'],
          defaultTtlSeconds: 60,
          maxTtlSeconds: 60,
          createdAt: '',
          updatedAt: '',
        },
      ],
      sessions: [
        {
          id: 's1',
          keyHash: 'h',
          keyHint: 'gws_x',
          label: '',
          tool: 'github',
          accountId: 'a1',
          templateId: 't1',
          templateName: 'RO',
          permissions: ['issues:read'],
          resources: ['o/r'],
          createdAt: '',
          expiresAt: '',
          revokedAt: null,
          lastUsedAt: null,
          requestCount: 0,
        },
      ],
    });
    expect(state.version).toBe(STORE_VERSION);
    expect(state.members).toEqual([]);
    expect(state.templates[0]).toEqual({
      id: 't1',
      name: 'RO',
      description: '',
      grants: [{ tool: 'github', permissions: ['issues:read'], resources: ['o/r'] }],
      defaultTtlSeconds: 60,
      maxTtlSeconds: 60,
      createdAt: '',
      updatedAt: '',
    });
    expect(state.sessions[0]?.grants).toEqual([
      { tool: 'github', accountId: 'a1', permissions: ['issues:read'], resources: ['o/r'] },
    ]);
    expect(state.sessions[0]).not.toHaveProperty('accountId');
  });
});

describe('store migration to v3', () => {
  it('gives existing members key generation 0', () => {
    const state = migrate({
      version: 2,
      members: [
        {
          id: 'm1',
          name: 'bot',
          keyHash: 'h',
          keyHint: 'gwm_x',
          templateIds: [],
          accountIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: null,
          lastUsedAt: null,
        },
      ],
    });
    expect(state.members[0]?.keyGeneration).toBe(0);
  });
});
