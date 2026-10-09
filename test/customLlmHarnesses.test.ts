/**
 * The real pi and Codex CLIs (devDependencies) run by the real runner (local driver) on a custom
 * LLM endpoint that only speaks Chat Completions, like most self-hosted servers: the fake endpoint
 * below asks for one shell command, then answers with what it printed.
 *
 * With CUSTOM_LLM_URL set (and CUSTOM_LLM_TOKEN, optionally CUSTOM_LLM_MODEL, else the endpoint's
 * first model), both harnesses also run against that real endpoint.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityLog } from '../src/server/activity.js';
import { Gateway } from '../src/server/gateway.js';
import { createApp } from '../src/server/http/app.js';
import { Launchpad } from '../src/server/launchpad/launchpad.js';
import { LocalProcessDriver } from '../src/server/launchpad/localDriver.js';
import type { Harness as AgentHarness } from '../src/server/launchpad/protocol.js';
import { RunStore } from '../src/server/launchpad/runStore.js';
import { LlmUsageLog } from '../src/server/llmUsage.js';
import { createCustomLlmProvider } from '../src/server/tools/llm/custom.js';
import { ToolRegistry } from '../src/server/tools/registry.js';
import { createHarness } from './helpers.js';

const BIN = path.resolve('node_modules', '.bin');
const HARNESSES = ['pi', 'codex'] as const;
const installed = HARNESSES.every((h) => existsSync(path.join(BIN, h)));
const MODEL = 'qwen3-coder';
const TOKEN = 'endpoint-token';
const PROOF = 'proof-from-the-shell';
const RUN_TIMEOUT_MS = 120_000;
/** Above any output limit pi or Codex set themselves. */
const MAX_CLIENT_LIMIT = 65_536;

type Json = Record<string, unknown>;

/** What the fake endpoint was sent. */
const received: { path: string; auth: string | undefined; body: Json | null }[] = [];

/** The shell tool each harness offers, and how it takes its command. */
function shellCall(tools: Json[]): { name: string; arguments: string } | null {
  const names = tools.map((t) => (t.function as Json).name);
  const command = `mkdir -p "$HOME/out" && echo ${PROOF} | tee "$HOME/out/proof.txt"`;
  if (names.includes('bash')) return { name: 'bash', arguments: JSON.stringify({ command }) };
  if (names.includes('exec_command')) {
    return { name: 'exec_command', arguments: JSON.stringify({ cmd: command }) };
  }
  return null;
}

function toolOutput(messages: Json[]): string | null {
  const results = messages.filter((m) => m.role === 'tool');
  return results.length === 0 ? null : JSON.stringify(results.map((m) => m.content));
}

const chunk = (delta: Json, finish: string | null = null) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: MODEL,
  choices: [{ index: 0, delta, finish_reason: finish }],
});

/** First turn: run the shell command. Next: report what it printed. */
function answer(body: Json): Json[] {
  const messages = (body.messages ?? []) as Json[];
  const output = toolOutput(messages);
  const call = output === null ? shellCall((body.tools ?? []) as Json[]) : null;
  if (call) {
    return [
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: call.name, arguments: '' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: call.arguments } }] }),
      chunk({}, 'tool_calls'),
    ];
  }
  const text = output?.includes(PROOF) ? `The command printed ${PROOF}` : 'No tool output';
  return [
    chunk({ role: 'assistant', content: text.slice(0, 10) }),
    chunk({ content: text.slice(10) }),
    chunk({}, 'stop'),
  ];
}

function fakeEndpoint(req: IncomingMessage, res: ServerResponse): void {
  let raw = '';
  req.on('data', (c: Buffer) => (raw += c.toString()));
  req.on('end', () => {
    const body = raw ? (JSON.parse(raw) as Json) : null;
    received.push({ path: req.url ?? '', auth: req.headers.authorization, body });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
    } else if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
    } else if (req.method === 'POST' && req.url === '/v1/chat/completions' && body) {
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      res.setHeader('content-type', 'text/event-stream');
      for (const c of answer(body)) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk({}), choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      // Chat Completions only: no Responses API.
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `No route ${String(req.url)}` } }));
    }
  });
}

const listen = async (server: Server): Promise<string> => {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
};

let gateway: Gateway;
let launchpad: Launchpad;
let endpoint: Server;
let app: Server;
let endpointUrl: string;

beforeAll(async () => {
  if (!installed) return;
  const dir = await mkdtemp(path.join(tmpdir(), 'custom-llm-harnesses-'));
  execFileSync(process.execPath, ['scripts/build-guest.mjs', path.join(dir, 'guest')]);
  const h = await createHarness();
  // Real HTTP to the endpoints: only the custom LLM provider is needed.
  gateway = new Gateway(
    h.store,
    h.crypto,
    new ToolRegistry([createCustomLlmProvider(fetch)]),
    new ActivityLog(h.db),
    new LlmUsageLog(h.db),
    () => new Date(),
  );
  launchpad = new Launchpad({
    gateway,
    runs: new RunStore(h.db),
    driver: new LocalProcessDriver(path.join(dir, 'guest', 'runner.js'), {
      LAUNCHPAD_HARNESS_PATH: BIN,
    }),
    crypto: h.crypto,
    vmGatewayUrl: 'set below',
  });
  endpoint = createServer(fakeEndpoint);
  endpointUrl = await listen(endpoint);
  app = createServer(createApp(gateway, h.config, { fetch, launchpad }));
  const url = await listen(app);
  (h.config as { publicUrl: string }).publicUrl = url;
  (launchpad as unknown as { deps: { vmGatewayUrl: string } }).deps.vmGatewayUrl = url;
}, 60_000);

afterAll(() => {
  if (!installed) return;
  endpoint.close();
  app.close();
});

async function launch(
  harness: AgentHarness,
  target: { url: string; token: string; model: string },
  prompt: string,
) {
  const template = await gateway.createTemplate({
    name: `${harness} on ${target.url}`,
    grants: [
      {
        tool: 'custom',
        permissions: ['llm:invoke'],
        resources: [],
        endpoint: { url: target.url, api: 'openai', token: target.token },
      },
    ],
    defaultTtlSeconds: 3600,
    maxTtlSeconds: 3600,
  });
  const { member } = await gateway.createMember({
    name: `${harness} ${template.id}`,
    templateIds: [template.id],
    accountIds: [],
  });
  const active = gateway.activeMember(member.id);
  if (!active) throw new Error('no member');
  const run = launchpad.launch(active, {
    prompt,
    templateId: template.id,
    harness,
    model: target.model,
  });
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (['queued', 'provisioning', 'running'].includes(launchpad.runs.require(run.id).status)) {
    if (Date.now() > deadline) throw new Error(`${harness} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const done = launchpad.runs.require(run.id);
  const events = launchpad.runs.events(run.id);
  return { done, events, transcript: events.map((e) => `${e.type}: ${e.text}`).join('\n') };
}

describe.skipIf(!installed).each(HARNESSES)('%s on a Chat Completions endpoint', (harness) => {
  it(
    'runs a tool and finishes with the model’s answer',
    async () => {
      received.length = 0;
      const { done, events, transcript } = await launch(
        harness,
        { url: `${endpointUrl}/v1`, token: TOKEN, model: MODEL },
        'Run the proof command',
      );
      expect(done.status, transcript).toBe('succeeded');
      expect(done.finalMessage).toBe(`The command printed ${PROOF}`);
      expect(launchpad.runs.output(done.id, 'proof.txt')?.toString()).toBe(`${PROOF}\n`);
      expect(events.some((e) => e.type === 'tool_call')).toBe(true);
      // The endpoint's token goes upstream, and only Chat Completions are asked for.
      expect(received.length).toBeGreaterThanOrEqual(2);
      expect(received.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
      expect(received.every((r) => r.path === '/v1/chat/completions')).toBe(true);
      expect(received[0]?.body).toMatchObject({ model: MODEL, stream: true });
      // The run's token budget is not sent as an output limit (servers refuse one that large).
      const limits = received.map((r) => Number(r.body?.max_completion_tokens ?? 0));
      expect(Math.max(...limits)).toBeLessThanOrEqual(MAX_CLIENT_LIMIT);
      const usage = gateway.llmUsage.totalsFor([done.sessionId ?? '']);
      expect(usage.calls).toBe(received.length);
    },
    RUN_TIMEOUT_MS,
  );
});

const live = process.env.CUSTOM_LLM_URL;

describe.skipIf(!installed || !live).each(HARNESSES)('%s on CUSTOM_LLM_URL', (harness) => {
  it(
    'answers through the gateway',
    async () => {
      const url = live ?? '';
      const token = process.env.CUSTOM_LLM_TOKEN ?? '';
      let model = process.env.CUSTOM_LLM_MODEL;
      if (!model) {
        const res = await fetch(`${url.replace(/\/v1\/?$/, '')}/v1/models`, {
          headers: { authorization: `Bearer ${token}` },
        });
        model = ((await res.json()) as { data: { id: string }[] }).data[0]?.id ?? '';
      }
      const { done, transcript } = await launch(
        harness,
        { url, token, model },
        'Reply with the single word: hello',
      );
      expect(done.status, transcript).toBe('succeeded');
      expect(done.finalMessage).toBeTruthy();
    },
    RUN_TIMEOUT_MS,
  );
});
