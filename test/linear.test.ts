import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createHarness, type Harness } from './helpers.js';

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;
let accountId: string;
let n = 0;

const adminPost = (path: string, body: object) =>
  request(app).post(`/api/admin${path}`).set('authorization', `Bearer ${admin}`).send(body);

async function keyFor(permissions: string[], teams: string[] = []): Promise<string> {
  n += 1;
  const tpl = await adminPost('/templates', {
    name: `linear ${String(n)}`,
    grants: [{ tool: 'linear', permissions, resources: teams }],
    defaultTtlSeconds: 600,
    maxTtlSeconds: 600,
  }).expect(201);
  const res = await adminPost('/sessions', {
    templateId: tpl.body.id,
    accountIds: [accountId],
  }).expect(201);
  return res.body.key as string;
}

const gql = (key: string, query: string, variables: object = {}) =>
  request(app)
    .post('/proxy/linear/graphql')
    .set('authorization', `Bearer ${key}`)
    .send({ query, variables });

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
  const acc = await adminPost('/accounts', {
    tool: 'linear',
    label: 'Acme',
    secret: 'lin_api_real',
  }).expect(201);
  accountId = acc.body.id as string;
});

describe('Linear accounts', () => {
  it('verifies the API key and shows who it is', async () => {
    const acc = (
      await request(app)
        .get('/api/admin/accounts')
        .set('authorization', `Bearer ${admin}`)
        .expect(200)
    ).body as {
      identity: Record<string, string>;
      kind: string;
    }[];
    expect(acc[0]).toMatchObject({
      kind: 'tool',
      identity: { login: 'ada@example.com', workspace: 'Acme' },
    });
    await adminPost('/accounts', { tool: 'linear', label: 'bad', secret: 'lin_api_bad' }).expect(
      422,
    );
  });
});

describe('Linear permissions', () => {
  it('maps root fields to permissions and sends the real key bare', async () => {
    const key = await keyFor(['issues:read', 'workspace:read']);
    await gql(
      key,
      'query { issues { nodes { id title assignee { name } } } viewer { id } }',
    ).expect(200);
    const call = h.upstreamCalls.at(-1);
    expect(call?.url).toBe('https://api.linear.app/graphql');
    expect(new Headers(call?.init.headers).get('authorization')).toBe('lin_api_real');
    const denied = await gql(
      key,
      'mutation { issueCreate(input: { teamId: "team-eng", title: "x" }) { success } }',
    ).expect(403);
    expect(denied.body.message).toContain('issues:write');
    await gql(key, 'mutation { webhookCreate(input: { url: "https://evil" }) { success } }').expect(
      403,
    );
    await gql(key, 'query { apiKeys { nodes { id } } }').expect(403);
    await request(app)
      .get('/proxy/linear/graphql')
      .set('authorization', `Bearer ${key}`)
      .expect(403);
  });
});

describe('team-restricted templates', () => {
  let key: string;
  beforeEach(async () => {
    key = await keyFor(
      ['issues:read', 'issues:write', 'comments:write', 'workspace:read', 'projects:read'],
      ['ENG'],
    );
  });

  it('checks the team of every issue, team and comment the request names', async () => {
    await gql(key, 'query { issue(id: "ENG-1") { title state { name } } }').expect(200);
    await gql(key, 'query ($id: String!) { issue(id: $id) { title } }', {
      id: 'issue-uuid-eng',
    }).expect(200);
    const other = await gql(key, 'query { issue(id: "OPS-1") { title } }').expect(403);
    expect(other.body.message).toBe('Team OPS is not in the allowlist');
    await gql(key, 'query { issue(id: "NOPE-9") { title } }').expect(403);
    await gql(
      key,
      'mutation { issueCreate(input: { teamId: "team-eng", title: "x" }) { success } }',
    ).expect(200);
    await gql(
      key,
      'mutation { issueCreate(input: { teamId: "team-ops", title: "x" }) { success } }',
    ).expect(403);
    await gql(
      key,
      'mutation { issueUpdate(id: "ENG-1", input: { teamId: "team-ops" }) { success } }',
    ).expect(403);
    await gql(
      key,
      'mutation { commentCreate(input: { issueId: "ENG-1", body: "hi" }) { success } }',
    ).expect(200);
    await gql(key, 'mutation { commentDelete(id: "c-ops") { success } }').expect(403);
    await gql(key, 'query { teams { nodes { key } } }').expect(200);
  });

  it('needs issue lists to filter on allowed teams', async () => {
    await gql(
      key,
      'query { issues(filter: { team: { key: { eq: "ENG" } } }) { nodes { id } } }',
    ).expect(200);
    await gql(
      key,
      'query { issues(filter: { team: { key: { in: ["ENG", "OPS"] } } }) { nodes { id } } }',
    ).expect(403);
    await gql(key, 'query { issues { nodes { id } } }').expect(403);
    await gql(
      key,
      'query { issues(filter: { team: { key: { eq: "ENG" } }, or: [{ priority: { eq: 1 } }] }) { nodes { id } } }',
    ).expect(403);
    await gql(key, 'query { searchIssues(term: "x") { nodes { id } } }').expect(403);
    await gql(key, 'query { projects { nodes { id } } }').expect(403);
  });

  it('keeps nested reads within the issue or team', async () => {
    await gql(
      key,
      'query { issue(id: "ENG-1") { comments { nodes { body user { name } } } } }',
    ).expect(200);
    const res = await gql(
      key,
      'query { issue(id: "ENG-1") { project { issues { nodes { id } } } } }',
    ).expect(403);
    expect(res.body.message).toContain('"project"');
    await gql(key, 'query { issue(id: "ENG-1") { children { nodes { id } } } }').expect(403);
    await gql(key, 'query { viewer { assignedIssues { nodes { id } } } }').expect(403);
  });
});
