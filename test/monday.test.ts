import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createMondayProvider } from '../src/server/tools/monday.js';
import type { AuthzDecision, Grant } from '../src/server/tools/types.js';
import {
  createHarness,
  fakeMondayFetch,
  MONDAY_PAGE_CURSOR as PAGE_CURSOR,
  type Harness,
} from './helpers.js';

const calls: { url: string; init: RequestInit }[] = [];
const monday = createMondayProvider(fakeMondayFetch(calls));

const post = (query: string, variables?: Record<string, unknown>, extra: object = {}) =>
  Buffer.from(JSON.stringify({ query, variables, ...extra }));

const authz = (
  grant: Grant,
  body: Buffer | undefined,
  { method = 'POST', segments = ['v2'], search = '', sessionId = 's1' } = {},
): Promise<AuthzDecision> =>
  Promise.resolve(
    monday.authorize({ method, segments, search, headers: new Headers(), body }, grant, {
      sessionId,
      secret: 'tok',
      tokensRemaining: null,
    }),
  );

const allowed = async (grant: Grant, query: string, variables?: Record<string, unknown>) =>
  (await authz(grant, post(query, variables))).allowed;

const reason = async (grant: Grant, query: string, variables?: Record<string, unknown>) => {
  const d = await authz(grant, post(query, variables));
  return d.allowed ? null : d.reason;
};

const read: Grant = { permissions: ['boards:read'], resources: [] };
const readBoard1: Grant = { permissions: ['boards:read'], resources: ['1'] };
const writeBoard1: Grant = { permissions: ['items:write'], resources: ['1'] };

describe('monday.com authorization', () => {
  it('only accepts POST /v2 with a JSON GraphQL body', async () => {
    const q = post('{ boards { id } }');
    expect((await authz(read, q, { method: 'GET' })).allowed).toBe(false);
    expect((await authz(read, q, { segments: ['v2', 'file'] })).allowed).toBe(false);
    expect((await authz(read, q, { search: '?query=x' })).allowed).toBe(false);
    expect((await authz(read, undefined)).allowed).toBe(false);
    expect((await authz(read, Buffer.from('[{"query":"{ me { id } }"}]'))).allowed).toBe(false);
    expect(await reason(read, '{ boards { id ')).toMatch(/Invalid GraphQL document/);
    expect(await reason(read, 'type Foo { id: ID }')).toMatch(/Only operations/);
  });

  it('maps root fields to permissions', async () => {
    expect(await allowed(read, '{ boards { id name } }')).toBe(true);
    expect(
      await allowed(read, 'mutation { create_item(board_id: 1, item_name: "x") { id } }'),
    ).toBe(false);
    const write: Grant = { permissions: ['items:write'], resources: [] };
    expect(
      await allowed(write, 'mutation { create_item(board_id: 1, item_name: "x") { id } }'),
    ).toBe(true);
    expect(await allowed(write, '{ boards { id } }')).toBe(false);
    expect(await reason(read, '{ me { id } }')).toBe(
      'Missing permission "account:read" (for "me")',
    );
    expect(
      await allowed({ permissions: ['account:read'], resources: [] }, '{ me { id name } }'),
    ).toBe(true);
  });

  it('denies fields no rule covers, and subscriptions', async () => {
    const all: Grant = {
      permissions: ['boards:read', 'boards:write', 'items:write', 'updates:write', 'account:read'],
      resources: [],
    };
    expect(
      await reason(
        all,
        'mutation { create_webhook(board_id: 1, url: "x", event: create_item) { id } }',
      ),
    ).toBe('mutation "create_webhook" is not covered by any gateway permission');
    expect(
      await allowed(all, 'mutation { add_users_to_board(board_id: 1, user_ids: [1]) { id } }'),
    ).toBe(false);
    expect(await allowed(all, 'subscription { boards { id } }')).toBe(false);
  });

  it('always allows complexity, versions and introspection', async () => {
    const none: Grant = { permissions: [], resources: ['1'] };
    expect(await allowed(none, '{ complexity { before after } version { value } }')).toBe(true);
    expect(await allowed(none, '{ __schema { types { name fields { name } } } }')).toBe(true);
  });

  it('checks every operation and aliased field in the document', async () => {
    const doc = 'query A { boards(ids: 1) { id } } mutation B { delete_item(item_id: 11) { id } }';
    const d = await authz(readBoard1, post(doc, {}, { operationName: 'A' }));
    expect(d).toMatchObject({
      allowed: false,
      reason: 'Missing permission "items:write" (for "delete_item")',
    });
    expect(
      await allowed(readBoard1, '{ mine: boards(ids: 1) { id } other: boards(ids: 2) { id } }'),
    ).toBe(false);
  });

  it('limits board-restricted grants to the allowlisted boards', async () => {
    expect(
      await allowed(readBoard1, '{ boards(ids: [1]) { id items_page { items { id name } } } }'),
    ).toBe(true);
    expect(await allowed(readBoard1, '{ boards(ids: "1") { id } }')).toBe(true);
    expect(await reason(readBoard1, '{ boards(ids: [1, 2]) { id } }')).toBe(
      'Board 2 is not in the allowlist',
    );
    expect(await reason(readBoard1, '{ boards { id } }')).toMatch(/must name its boards in "ids"/);
    expect(await allowed(readBoard1, '{ boards(ids: []) { id } }')).toBe(false);
    expect(await allowed(readBoard1, '{ boards(ids: ["1 OR 2"]) { id } }')).toBe(false);
    expect(await reason(readBoard1, '{ updates { id } }')).toMatch(
      /needs an unrestricted template/,
    );
    expect(await allowed(read, '{ updates { id } }')).toBe(true);
  });

  it('resolves variables, their defaults, and fragments', async () => {
    const q = 'query ($b: [ID!]) { boards(ids: $b) { id } }';
    expect(await allowed(readBoard1, q, { b: ['1'] })).toBe(true);
    expect(await allowed(readBoard1, q, { b: ['2'] })).toBe(false);
    expect(await allowed(readBoard1, q, {})).toBe(false);
    expect(await allowed(readBoard1, q, { b: null })).toBe(false);
    const withDefault = 'query ($b: [ID!] = [2]) { boards(ids: $b) { id } }';
    expect(await allowed(readBoard1, withDefault)).toBe(false);
    expect(await allowed(readBoard1, withDefault, { b: [1] })).toBe(true);
    const viaFragment = 'query { ...F } fragment F on Query { boards(ids: 2) { id } }';
    expect(await allowed(readBoard1, viaFragment)).toBe(false);
    const inline = 'query { ... on Query { boards(ids: 2) { id } } }';
    expect(await allowed(readBoard1, inline)).toBe(false);
  });

  it('looks up which board items are on (subitems count as their parent board)', async () => {
    calls.length = 0;
    expect(await allowed(writeBoard1, 'mutation { delete_item(item_id: 11) { id } }')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('tok');
    expect(await reason(writeBoard1, 'mutation { delete_item(item_id: 22) { id } }')).toBe(
      'Item 22 is not on an allowed board',
    );
    expect(await allowed(writeBoard1, 'mutation { archive_item(item_id: 33) { id } }')).toBe(true);
    expect(await reason(writeBoard1, 'mutation { archive_item(item_id: 404) { id } }')).toBe(
      'Item 404 was not found',
    );
    expect(
      await allowed(
        writeBoard1,
        'mutation { create_subitem(parent_item_id: 11, item_name: "x") { id } }',
      ),
    ).toBe(true);
    // Both the board and the item must be allowed
    const change = (board: number, item: number) =>
      `mutation { change_simple_column_value(board_id: ${board}, item_id: ${item}, column_id: "status", value: "Done") { id } }`;
    expect(await allowed(writeBoard1, change(1, 11))).toBe(true);
    expect(await allowed(writeBoard1, change(1, 22))).toBe(false);
    expect(await allowed(writeBoard1, change(2, 11))).toBe(false);
    expect(
      await allowed(
        writeBoard1,
        'mutation { move_item_to_board(board_id: 2, item_id: 11, group_id: "g") { id } }',
      ),
    ).toBe(false);
    // Unrestricted grants don't look anything up
    calls.length = 0;
    expect(await allowed({ permissions: ['items:write'], resources: [] }, change(2, 22))).toBe(
      true,
    );
    expect(calls).toHaveLength(0);
  });

  it('denies unknown nested objects and cross-board traversals', async () => {
    const linked =
      '{ boards(ids: 1) { items_page { items { column_values { ... on BoardRelationValue { linked_items { id name } } } } } } }';
    expect(await reason(readBoard1, linked)).toMatch(/"linked_items" reaches other boards/);
    expect(await allowed(read, linked)).toBe(true);
    const viaItemBoard = '{ items(ids: 11) { board { items_page { items { id } } } } }';
    expect(await allowed(readBoard1, viaItemBoard)).toBe(true);
    expect(await reason(read, '{ boards { some_new_field { id } } }')).toBe(
      'Nested field "some_new_field" is not supported by the gateway',
    );
    // A write grant can't read through a mutation result
    expect(
      await reason(
        writeBoard1,
        'mutation { create_item(board_id: 1, item_name: "x") { board { items_page { items { name } } } } }',
      ),
    ).toMatch(/needs "boards:read"/);
    expect(
      await allowed(
        writeBoard1,
        'mutation { create_item(board_id: 1, item_name: "x") { id name } }',
      ),
    ).toBe(true);
  });

  it('only accepts pagination cursors it returned to the same session', async () => {
    const next = `{ next_items_page(cursor: "${PAGE_CURSOR}") { cursor items { id } } }`;
    expect(await reason(readBoard1, next)).toMatch(/Unknown cursor/);
    const first = await authz(
      readBoard1,
      post('{ boards(ids: 1) { items_page { cursor items { id } } } }'),
      { sessionId: 'pager' },
    );
    expect(first.allowed && first.observeResponse).toBeTypeOf('function');
    if (first.allowed)
      first.observeResponse?.({ data: { boards: [{ items_page: { cursor: PAGE_CURSOR } }] } });
    expect((await authz(readBoard1, post(next), { sessionId: 'pager' })).allowed).toBe(true);
    expect((await authz(readBoard1, post(next), { sessionId: 'other' })).allowed).toBe(false);
    const nested = `{ boards(ids: 1) { items_page(cursor: "forged") { items { id } } } }`;
    expect((await authz(readBoard1, post(nested), { sessionId: 'pager' })).allowed).toBe(false);
    // Unrestricted grants page freely
    expect(await allowed(read, next)).toBe(true);
  });

  it('forwards the canonical document it checked', async () => {
    const raw = Buffer.from(
      '{"query":"{ boards(ids: 1) { id } }","query":"{ boards(ids: 1) { id name } }","extra":1}',
    );
    const d = await authz(readBoard1, raw);
    expect(d.allowed).toBe(true);
    if (!d.allowed) return;
    const sent = JSON.parse(String(d.body)) as Record<string, unknown>;
    expect(sent).toEqual({
      query: '{\n  boards(ids: 1) {\n    id\n    name\n  }\n}',
      variables: {},
    });
  });

  it('rejects documents that expand without bound', async () => {
    const cyclic =
      '{ items(ids: 11) { ...A } } fragment A on Item { board { ...B } } fragment B on Board { items_page { items { ...A } } }';
    expect(await reason(read, cyclic)).toMatch(/too many fields/);
    const defs = Array.from(
      { length: 20 },
      (_, i) => `fragment F${i} on Item { ...F${i + 1} ...F${i + 1} }`,
    ).join(' ');
    const bomb = `{ items(ids: 11) { ...F0 } } ${defs} fragment F20 on Item { id }`;
    expect(await reason(read, bomb)).toMatch(/too many fields/);
  });

  it('validates board IDs as resources', () => {
    expect(monday.validateResource('1234567890')).toBeNull();
    expect(monday.validateResource('octo/repo')).not.toBeNull();
    expect(monday.validateResource('*')).not.toBeNull();
  });

  it('sends the raw token upstream and forwards only safe headers', () => {
    const h = monday.upstreamHeaders(
      'secret',
      new Headers({ cookie: 'x', 'api-version': '2025-04', authorization: 'gws_x' }),
    );
    expect(h.get('authorization')).toBe('secret');
    expect(h.get('api-version')).toBe('2025-04');
    expect(h.get('cookie')).toBeNull();
    expect(h.get('content-type')).toBe('application/json');
  });
});

describe('monday.com through the proxy', () => {
  let h: Harness;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  const auth = (key: string) => ['Authorization', `Bearer ${key}`] as const;

  beforeEach(async () => {
    h = await createHarness();
    app = createApp(h.gateway, h.config, { fetch: h.fetch });
    admin = await h.gateway.rotateAdminToken();
  });

  async function sessionKey(resources: string[]): Promise<string> {
    const acc = await request(app)
      .post('/api/admin/accounts')
      .set(...auth(admin))
      .send({ tool: 'monday', label: 'Work', secret: 'monday-token' })
      .expect(201);
    expect(acc.body.identity).toMatchObject({ login: 'ada@example.com', account: 'Acme' });
    expect(JSON.stringify(acc.body)).not.toContain('monday-token');
    const tpl = await request(app)
      .post('/api/admin/templates')
      .set(...auth(admin))
      .send({
        name: 'Board 1',
        grants: [{ tool: 'monday', permissions: ['boards:read'], resources }],
        defaultTtlSeconds: 600,
        maxTtlSeconds: 3600,
      })
      .expect(201);
    const s = await request(app)
      .post('/api/admin/sessions')
      .set(...auth(admin))
      .send({ templateId: tpl.body.id, accountId: acc.body.id })
      .expect(201);
    return s.body.key as string;
  }

  it('lists monday.com in the tool catalog', async () => {
    const res = await request(app)
      .get('/api/admin/tools')
      .set(...auth(admin))
      .expect(200);
    const tool = (res.body as { id: string }[]).find((t) => t.id === 'monday');
    expect(tool).toMatchObject({
      name: 'monday.com',
      signIn: null,
      example: { method: 'POST', path: '/v2' },
    });
  });

  it('rejects tokens monday.com refuses', async () => {
    await request(app)
      .post('/api/admin/accounts')
      .set(...auth(admin))
      .send({ tool: 'monday', label: 'Bad', secret: 'bad-token' })
      .expect(422);
  });

  it('proxies allowed queries with the real token, and denies the rest', async () => {
    const key = await sessionKey(['1']);
    h.upstreamCalls.length = 0;
    // monday clients send the raw key without "Bearer"
    const res = await request(app)
      .post('/proxy/monday/v2')
      .set('Authorization', key)
      .send({ query: '{ boards(ids: 1) { id items_page { cursor } } }' })
      .expect(200);
    expect(res.body.data.echo).toContain('boards(ids: 1)');
    expect(h.upstreamCalls).toHaveLength(1);
    expect(h.upstreamCalls[0]?.url).toBe('https://api.monday.com/v2');
    expect(new Headers(h.upstreamCalls[0]?.init.headers).get('authorization')).toBe('monday-token');

    // The cursor from that response can be used by this session
    await request(app)
      .post('/proxy/monday/v2')
      .set(...auth(key))
      .send({ query: `{ next_items_page(cursor: "${PAGE_CURSOR}") { items { id } } }` })
      .expect(200);

    const denied = await request(app)
      .post('/proxy/monday/v2')
      .set(...auth(key))
      .send({ query: '{ boards(ids: 2) { id } }' })
      .expect(403);
    expect(denied.body.message).toBe('Board 2 is not in the allowlist');
    expect(denied.headers['x-gateway-denied']).toBe('true');

    const activity = h.gateway.activity.recent();
    expect(activity.some((a) => a.detail === 'boards:read · query boards')).toBe(true);
  });

  it('rejects templates with non-board resources', async () => {
    await request(app)
      .post('/api/admin/templates')
      .set(...auth(admin))
      .send({
        name: 'x',
        grants: [{ tool: 'monday', permissions: ['boards:read'], resources: ['o/r'] }],
        defaultTtlSeconds: 600,
        maxTtlSeconds: 3600,
      })
      .expect(400);
  });
});
