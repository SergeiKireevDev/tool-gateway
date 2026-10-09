import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ActivityLog } from '../src/server/activity.js';
import { Database, IN_MEMORY } from '../src/server/db/database.js';
import { LlmUsageLog } from '../src/server/llmUsage.js';
import type { GatewayConfig } from '../src/server/config.js';
import { Gateway } from '../src/server/gateway.js';
import { CryptoBox } from '../src/server/store/crypto.js';
import { EncryptedStore } from '../src/server/store/store.js';
import { createGitHubProvider } from '../src/server/tools/github.js';
import { createLinearProvider } from '../src/server/tools/linear.js';
import { createAnthropicProvider } from '../src/server/tools/llm/anthropic.js';
import { createCustomLlmProvider } from '../src/server/tools/llm/custom.js';
import { createGeminiProvider } from '../src/server/tools/llm/gemini.js';
import { createOpenAIProvider } from '../src/server/tools/llm/openai.js';
import { createMondayProvider } from '../src/server/tools/monday.js';
import { ToolRegistry } from '../src/server/tools/registry.js';
import { createGmailProvider } from '../src/server/tools/gmail.js';
import { createSlackProvider } from '../src/server/tools/slack.js';

export interface Harness {
  gateway: Gateway;
  store: EncryptedStore;
  db: Database;
  crypto: CryptoBox;
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
    if (url === 'https://api.github.com/repos/o/r') {
      return Promise.resolve(
        Response.json({ url, method: init.method ?? 'GET', default_branch: 'main' }),
      );
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

/** A custom LLM endpoint: answers like Anthropic on `/v1/messages`, like OpenAI elsewhere. */
export const CUSTOM_LLM_URL = 'https://llm.example.com/';
/** What the fake custom LLM endpoint lists at `GET /v1/models`. */
export const CUSTOM_LLM_MODELS = ['qwen3', 'llama-4', 'gpt-6', 'qwen3'];

/** Usage every fake LLM answer reports: 100 input, 50 output, 10 cache reads, 5 cache writes. */
export const FAKE_LLM_TOTAL = 165;

const sse = (events: object[]): Response =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

function fakeLlmAnswer(url: string, body: Record<string, unknown>): Response {
  const stream = body.stream === true || url.includes(':streamGenerateContent');
  if (url.startsWith('https://api.anthropic.com/')) {
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    };
    if (!stream) return Response.json({ type: 'message', usage: { ...usage, output_tokens: 50 } });
    return sse([
      { type: 'message_start', message: { usage: { ...usage, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { text: 'hi' } },
      { type: 'message_delta', usage: { output_tokens: 50 } },
    ]);
  }
  if (url.startsWith('https://api.openai.com/v1/responses')) {
    const usage = {
      input_tokens: 110,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens: 55,
    };
    if (!stream) return Response.json({ usage });
    return sse([
      { type: 'response.output_text.delta' },
      { type: 'response.completed', response: { usage } },
    ]);
  }
  if (url.startsWith('https://api.openai.com/')) {
    const usage = {
      prompt_tokens: 110,
      prompt_tokens_details: { cached_tokens: 10 },
      completion_tokens: 55,
    };
    return stream ? sse([{ choices: [] }, { choices: [], usage }]) : Response.json({ usage });
  }
  const usageMetadata = {
    promptTokenCount: 115,
    cachedContentTokenCount: 10,
    candidatesTokenCount: 40,
    thoughtsTokenCount: 10,
  };
  return stream
    ? sse([{ usageMetadata: { ...usageMetadata, candidatesTokenCount: 1 } }, { usageMetadata }])
    : Response.json({ usageMetadata });
}

/** Fake Anthropic / OpenAI / Gemini: rejects key `bad-key`, answers with fixed token usage. */
export function fakeLlmFetch(calls: Harness['upstreamCalls']): typeof fetch {
  const openAiAuth = { polls: 0 };
  return (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    if (url.startsWith('https://auth.openai.com/')) {
      return Promise.resolve(fakeOpenAiAuth(url, init, openAiAuth));
    }
    if (url === 'https://chatgpt.com/backend-api/codex/responses') {
      const usage = {
        input_tokens: 110,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens: 55,
      };
      return Promise.resolve(sse([{ type: 'response.completed', response: { usage } }]));
    }
    if (url === 'https://platform.claude.com/v1/oauth/token') {
      return Promise.resolve(
        fakeClaudeToken(JSON.parse(init.body as string) as Record<string, string>),
      );
    }
    const headers = new Headers(init.headers);
    const key =
      headers.get('x-api-key') ?? headers.get('x-goog-api-key') ?? headers.get('authorization');
    if (key?.endsWith('bad-key')) return Promise.resolve(new Response('{}', { status: 401 }));
    if (url.startsWith(`${CUSTOM_LLM_URL}v1/models`)) {
      return Promise.resolve(Response.json({ data: CUSTOM_LLM_MODELS.map((id) => ({ id })) }));
    }
    if ((init.method ?? 'GET') === 'GET') return Promise.resolve(Response.json({ data: [] }));
    // A key revoked after it was connected: providers echo part of it in their error.
    if (key?.endsWith('revoked-key')) {
      return Promise.resolve(Response.json({ error: `Incorrect API key ${key}` }, { status: 401 }));
    }
    const body = JSON.parse(Buffer.from(init.body as Buffer).toString('utf8')) as Record<
      string,
      unknown
    >;
    return Promise.resolve(fakeLlmAnswer(customAsOfficial(url), body));
  };
}

/** The official API URL a custom endpoint's request mimics. */
function customAsOfficial(url: string): string {
  if (!url.startsWith(CUSTOM_LLM_URL)) return url;
  const path = new URL(url).pathname;
  const host = path.endsWith('/v1/messages')
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com';
  return `${host}${path.slice(path.indexOf('/v1/'))}`;
}

/** A ChatGPT access token (unsigned JWT) for account `acct_1`, generation `n`. */
export function fakeChatGptToken(n: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [
    part({ alg: 'none' }),
    part({
      n,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'pro' },
      'https://api.openai.com/profile': { email: 'ada@chatgpt.example' },
    }),
    'sig',
  ].join('.');
}

/** Fake OpenAI auth server: device code, approval after one pending poll, token exchange, refresh. */
function fakeOpenAiAuth(url: string, init: RequestInit, state: { polls: number }): Response {
  if (url.endsWith('/api/accounts/deviceauth/usercode')) {
    return Response.json({ device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '5' });
  }
  if (url.endsWith('/api/accounts/deviceauth/token')) {
    state.polls += 1;
    if (state.polls === 1) return new Response('', { status: 403 });
    return Response.json({ authorization_code: 'auth-code', code_verifier: 'verifier' });
  }
  const form = new URLSearchParams(init.body as string);
  const n =
    form.get('grant_type') === 'authorization_code' && form.get('code') === 'auth-code'
      ? 1
      : form.get('grant_type') === 'refresh_token' &&
          /^cr\d+$/.test(form.get('refresh_token') ?? '')
        ? Number(form.get('refresh_token')?.slice(2)) + 1
        : 0;
  if (n === 0) return Response.json({ error: 'invalid_grant' }, { status: 400 });
  return Response.json({
    access_token: fakeChatGptToken(n),
    refresh_token: `cr${String(n)}`,
    expires_in: 3600,
  });
}

/** Fake Claude OAuth token endpoint: code `good-code`, then refresh tokens r1 → r2 → … */
function fakeClaudeToken(body: Record<string, string>): Response {
  const n =
    body.grant_type === 'authorization_code' && body.code === 'good-code'
      ? 1
      : body.grant_type === 'refresh_token' && /^r\d+$/.test(body.refresh_token ?? '')
        ? Number(body.refresh_token?.slice(1)) + 1
        : 0;
  if (n === 0) return Response.json({ error: 'invalid_grant' }, { status: 400 });
  return Response.json({
    access_token: `sk-ant-oat01-token${String(n)}`,
    refresh_token: `r${String(n)}`,
    expires_in: 3600,
    account: { email_address: 'alice@claude.example' },
    organization: { name: 'Alice Max' },
  });
}

/** Teams of the entities the fake Linear API knows: issues, teams (by id) and comments. */
const LINEAR_TEAMS: Record<string, Record<string, string>> = {
  issue: { 'ENG-1': 'ENG', 'issue-uuid-eng': 'ENG', 'OPS-1': 'OPS' },
  team: { 'team-eng': 'ENG', 'team-ops': 'OPS' },
  comment: { 'c-eng': 'ENG', 'c-ops': 'OPS' },
};

function linearLookup(kind: string, id: string): unknown {
  const key = LINEAR_TEAMS[kind]?.[id];
  if (!key) return null;
  if (kind === 'team') return { key };
  if (kind === 'issue') return { team: { key } };
  return { issue: { team: { key } } };
}

/** Fake Linear: `viewer` for any key but `lin_api_bad`, the gateway's team lookups, and an echo. */
export function fakeLinearFetch(calls: Harness['upstreamCalls']): typeof fetch {
  return (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    if (new Headers(init.headers).get('authorization') === 'lin_api_bad') {
      return Promise.resolve(
        Response.json({ errors: [{ message: 'Authentication required' }] }, { status: 401 }),
      );
    }
    const { query, variables } = bodyOf(init);
    if (query.includes('viewer { id name email }')) {
      return Promise.resolve(
        Response.json({
          data: {
            viewer: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
            organization: { name: 'Acme', urlKey: 'acme' },
          },
        }),
      );
    }
    const lookups = [...query.matchAll(/l(\d+): (\w+)\(/g)];
    if (lookups.length > 0) {
      const data = Object.fromEntries(
        lookups.map((m) => [
          `l${m[1] ?? ''}`,
          linearLookup(m[2] ?? '', String(variables[`v${m[1] ?? ''}`])),
        ]),
      );
      return Promise.resolve(Response.json({ data }));
    }
    return Promise.resolve(Response.json({ data: { echo: query } }));
  };
}

export const GMAIL_CLIENT = { clientId: 'gmail-client', clientSecret: 'gmail-secret' };

/**
 * Fake Google: the token endpoint (codes and refresh tokens starting with `good`), and Gmail's
 * `profile` for any token but `ya29.bad`; other calls echo.
 */
export function fakeGmailFetch(calls: Harness['upstreamCalls']): typeof fetch {
  return (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(init.body as string);
      const grant = form.get('code') ?? form.get('refresh_token') ?? '';
      if (!grant.startsWith('good')) {
        return Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }));
      }
      const first = form.get('grant_type') === 'authorization_code';
      return Promise.resolve(
        Response.json({
          access_token: first ? 'ya29.first' : 'ya29.refreshed',
          expires_in: 3599,
          ...(first ? { refresh_token: 'good-refresh' } : {}),
        }),
      );
    }
    const auth = new Headers(init.headers).get('authorization');
    if (url.endsWith('/gmail/v1/users/me/profile')) {
      if (auth === 'Bearer ya29.bad') {
        return Promise.resolve(Response.json({ error: { code: 401 } }, { status: 401 }));
      }
      return Promise.resolve(Response.json({ emailAddress: 'ada@example.com', messagesTotal: 42 }));
    }
    return Promise.resolve(
      Response.json({ url, method: init.method ?? 'GET', body: init.body ?? null }),
    );
  };
}

const LLM_HOSTS = [
  'https://auth.openai.com/',
  'https://chatgpt.com/',
  'https://platform.claude.com/',
  'https://api.anthropic.com/',
  'https://api.openai.com/',
  'https://generativelanguage.googleapis.com/',
  CUSTOM_LLM_URL,
];

const GOOGLE_HOSTS = ['https://gmail.googleapis.com/', 'https://oauth2.googleapis.com/'];

/** Routes upstream calls to the fake API of the tool they are for. */
function fakeUpstreams(calls: Harness['upstreamCalls']): typeof fetch {
  const github = fakeGitHubFetch(calls);
  const monday = fakeMondayFetch(calls);
  const slack = fakeSlackFetch(calls);
  const llm = fakeLlmFetch(calls);
  const linear = fakeLinearFetch(calls);
  const gmail = fakeGmailFetch(calls);
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (GOOGLE_HOSTS.some((host) => url.startsWith(host))) return gmail(input, init);
    if (url.startsWith('https://api.linear.app/')) return linear(input, init);
    if (LLM_HOSTS.some((host) => url.startsWith(host))) return llm(input, init);
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
    dbFile: IN_MEMORY,
    vmHost: null,
    launchpad: null,
    keyFile: path.join(dir, 'key', 'master.key'),
    publicUrl: 'http://gateway.test',
    google: null,
    gmail: null,
  };
  const upstreamCalls: Harness['upstreamCalls'] = [];
  const fetch = fakeUpstreams(upstreamCalls);
  const crypto = await CryptoBox.fromKeyFile(config.keyFile);
  const store = await EncryptedStore.open(config.storeFile, crypto);
  const db = Database.open(IN_MEMORY);
  const clock = { now: new Date('2026-01-01T00:00:00Z') };
  const gateway = new Gateway(
    store,
    crypto,
    new ToolRegistry([
      createGitHubProvider(fetch),
      createMondayProvider(fetch),
      createSlackProvider(fetch),
      createLinearProvider(fetch),
      createGmailProvider(fetch, GMAIL_CLIENT),
      createAnthropicProvider(fetch),
      createOpenAIProvider(fetch),
      createGeminiProvider(fetch),
      createCustomLlmProvider(fetch),
    ]),
    new ActivityLog(db),
    new LlmUsageLog(db),
    () => clock.now,
  );
  return { gateway, store, db, crypto, config, clock, fetch, upstreamCalls };
}
