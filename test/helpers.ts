import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ActivityLog } from '../src/server/activity.js';
import type { GatewayConfig } from '../src/server/config.js';
import { Gateway } from '../src/server/gateway.js';
import { CryptoBox } from '../src/server/store/crypto.js';
import { EncryptedStore } from '../src/server/store/store.js';
import { createGitHubProvider } from '../src/server/tools/github.js';
import { createMondayProvider } from '../src/server/tools/monday.js';
import { ToolRegistry } from '../src/server/tools/registry.js';
import { createSlackProvider } from '../src/server/tools/slack.js';

export interface Harness {
  gateway: Gateway;
  config: GatewayConfig;
  clock: { now: Date };
  fetch: typeof fetch;
  upstreamCalls: { url: string; init: RequestInit }[];
}

/** Fake GitHub: /user answers for any token, everything else echoes the request. */
export function fakeGitHubFetch(calls: Harness['upstreamCalls']): typeof fetch {
  return (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    const auth = new Headers(init.headers).get('authorization');
    if (auth === 'Bearer bad-token') {
      return Promise.resolve(new Response('{"message":"Bad credentials"}', { status: 401 }));
    }
    if (url === 'https://github.com/login/device/code') {
      return Promise.resolve(
        Response.json({
          device_code: 'dev-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
      );
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      return Promise.resolve(Response.json({ error: 'authorization_pending' }));
    }
    if (url === 'https://api.github.com/user') {
      return Promise.resolve(
        Response.json(
          { login: 'octocat', id: 1, name: 'Mona' },
          { headers: { 'x-oauth-scopes': 'repo, read:org' } },
        ),
      );
    }
    return Promise.resolve(
      Response.json(
        { url, method: init.method ?? 'GET' },
        {
          headers: {
            link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"',
            'set-cookie': 'nope=1',
          },
        },
      ),
    );
  };
}

/** Fake Slack: `auth.test` identifies any token but `xoxb-bad`; other methods echo their call. */
export function fakeSlackFetch(calls: Harness['upstreamCalls']): typeof fetch {
  return (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    if (new Headers(init.headers).get('authorization') === 'Bearer xoxb-bad') {
      return Promise.resolve(Response.json({ ok: false, error: 'invalid_auth' }));
    }
    if (url === 'https://slack.com/api/auth.test') {
      return Promise.resolve(
        Response.json(
          {
            ok: true,
            url: 'https://acme.slack.com/',
            team: 'Acme',
            user: 'gatebot',
            team_id: 'T1',
            user_id: 'U1',
          },
          { headers: { 'x-oauth-scopes': 'chat:write,channels:history' } },
        ),
      );
    }
    return Promise.resolve(
      Response.json({
        ok: true,
        url,
        method: init.method,
        body: Buffer.isBuffer(init.body) ? init.body.toString('utf8') : null,
      }),
    );
  };
}

/** Routes upstream calls to the fake API of the tool they are for. */
function fakeUpstreams(calls: Harness['upstreamCalls']): typeof fetch {
  const github = fakeGitHubFetch(calls);
  const monday = fakeMondayFetch(calls);
  const slack = fakeSlackFetch(calls);
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://api.monday.com/')) return monday(input, init);
    return url.startsWith('https://slack.com/') ? slack(input, init) : github(input, init);
  };
}

/** Items known to the fake monday API: item id → board id (and parent board for subitems). */
const ITEMS: Record<string, { board: string; parentBoard?: string }> = {
  '11': { board: '1' },
  '22': { board: '2' },
  '33': { board: '9001', parentBoard: '1' },
};

export const MONDAY_PAGE_CURSOR = 'MSw5NzI4MDA5MDA';

function bodyOf(init: RequestInit): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
}

/** Fake monday.com: `me`, the gateway's item→board lookups, and an echo for everything else. */
export function fakeMondayFetch(calls: { url: string; init: RequestInit }[]): typeof fetch {
  return (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    if (new Headers(init.headers).get('authorization') === 'bad-token') {
      return Promise.resolve(
        Response.json({ errors: [{ message: 'Not Authenticated' }] }, { status: 401 }),
      );
    }
    const { query, variables } = bodyOf(init);
    if (query.includes('me {') && query.includes('account {')) {
      return Promise.resolve(
        Response.json({
          data: {
            me: {
              id: '7',
              name: 'Ada',
              email: 'ada@example.com',
              account: { id: '3', name: 'Acme', slug: 'acme' },
            },
          },
        }),
      );
    }
    if (query.includes('parent_item { board { id } }')) {
      const ids = variables.ids as string[];
      const items = ids
        .filter((id) => id in ITEMS)
        .map((id) => ({
          id,
          board: { id: ITEMS[id]?.board },
          parent_item: ITEMS[id]?.parentBoard ? { board: { id: ITEMS[id].parentBoard } } : null,
        }));
      return Promise.resolve(Response.json({ data: { items } }));
    }
    return Promise.resolve(
      Response.json({
        data: { echo: query, boards: [{ items_page: { cursor: MONDAY_PAGE_CURSOR } }] },
      }),
    );
  };
}

export async function createHarness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gateway-test-'));
  const config: GatewayConfig = {
    host: '127.0.0.1',
    port: 0,
    storeFile: path.join(dir, 'data', 'store.enc'),
    keyFile: path.join(dir, 'key', 'master.key'),
    publicUrl: 'http://gateway.test',
    google: null,
  };
  const upstreamCalls: Harness['upstreamCalls'] = [];
  const fetch = fakeUpstreams(upstreamCalls);
  const crypto = await CryptoBox.fromKeyFile(config.keyFile);
  const store = await EncryptedStore.open(config.storeFile, crypto);
  const clock = { now: new Date('2026-01-01T00:00:00Z') };
  const gateway = new Gateway(
    store,
    crypto,
    new ToolRegistry([
      createGitHubProvider(fetch),
      createMondayProvider(fetch),
      createSlackProvider(fetch),
    ]),
    new ActivityLog(),
    () => clock.now,
  );
  return { gateway, config, clock, fetch, upstreamCalls };
}
