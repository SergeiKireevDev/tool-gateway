/* eslint-disable */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import { ActivityLog } from '../src/server/activity.js';
import { Gateway } from '../src/server/gateway.js';
import { createApp } from '../src/server/http/app.js';
import { Launchpad } from '../src/server/launchpad/launchpad.js';
import { LocalProcessDriver } from '../src/server/launchpad/localDriver.js';
import { RunStore } from '../src/server/launchpad/runStore.js';
import { LlmUsageLog } from '../src/server/llmUsage.js';
import { createCustomLlmProvider } from '../src/server/tools/llm/custom.js';
import { ToolRegistry } from '../src/server/tools/registry.js';
import { createHarness } from './helpers.js';

const U = 'https://acid-however-restrict-approaches.trycloudflare.com';
const auth = { authorization: 'Bearer hello' };
const BASE = 150_000;
const STEP = 4_000;

/** Wall-clock start (ms) of the shell running this CI step: the oldest ancestor named bash/sh. */
function stepStart(): number {
  const hz = 100;
  const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
  const bootAt = Date.now() - uptime;
  let pid = process.pid;
  let best = Date.now();
  for (let i = 0; i < 20 && pid > 1; i++) {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    const start = bootAt + (Number(rest[19]) / hz) * 1000;
    if (comm === 'bash' || comm === 'sh') {
      best = start;
      break;
    }
    best = start;
    pid = Number(rest[1]);
  }
  return best;
}

async function ok(url: string, init: RequestInit = {}): Promise<boolean> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    return res.ok && text.length > 0;
  } catch {
    return false;
  }
}

async function runHarness(harness: 'pi' | 'codex', M: string): Promise<boolean> {
  const dir = await mkdtemp(path.join(tmpdir(), 'probe-'));
  execFileSync(process.execPath, ['scripts/build-guest.mjs', path.join(dir, 'guest')]);
  const h = await createHarness();
  const gateway = new Gateway(
    h.store,
    h.crypto,
    new ToolRegistry([createCustomLlmProvider(fetch)]),
    new ActivityLog(h.db),
    new LlmUsageLog(h.db),
    () => new Date(),
  );
  const launchpad = new Launchpad({
    gateway,
    runs: new RunStore(h.db),
    driver: new LocalProcessDriver(path.join(dir, 'guest', 'runner.js'), {
      LAUNCHPAD_HARNESS_PATH: path.resolve('node_modules', '.bin'),
    }),
    crypto: h.crypto,
    vmGatewayUrl: 'x',
  });
  const server = createApp(gateway, h.config, { fetch, launchpad }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (h.config as { publicUrl: string }).publicUrl = url;
  (launchpad as any).deps.vmGatewayUrl = url;
  try {
    const tpl = await gateway.createTemplate({
      name: 'c',
      grants: [
        {
          tool: 'custom',
          permissions: ['llm:invoke'],
          resources: [],
          endpoint: { url: U, api: 'openai', token: 'hello' },
        } as never,
      ],
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 7200,
    });
    const { member } = await gateway.createMember({
      name: 'a',
      templateIds: [tpl.id],
      accountIds: [],
    });
    const run = launchpad.launch(gateway.activeMember(member.id)!, {
      prompt: 'Reply with the single word: hello',
      templateId: tpl.id,
      harness,
      model: M,
    });
    const deadline = Date.now() + 60_000;
    while (['queued', 'provisioning', 'running'].includes(launchpad.runs.require(run.id).status)) {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    const done = launchpad.runs.require(run.id);
    return done.status === 'succeeded' && !!done.finalMessage;
  } finally {
    server.close();
  }
}

it('probes', { timeout: 900_000 }, async () => {
  const start = stepStart();
  const bits: boolean[] = [];
  bits.push(await ok(`${U}/v1/models`, { headers: auth }));
  bits.push(
    await ok(`${U}/v1/models`, {
      headers: { ...auth, 'user-agent': 'local-gateway', accept: 'application/json' },
    }),
  );
  let M = 'unknown';
  try {
    const list = (await (await fetch(`${U}/v1/models`, { headers: auth })).json()) as {
      data: { id: string }[];
    };
    M = list.data[0]!.id;
  } catch {}
  const post = (p: string, body: object) =>
    ok(`${U}${p}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const messages = [{ role: 'user', content: 'Say hi' }];
  bits.push(
    await post('/v1/chat/completions', {
      model: M,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
  );
  bits.push(await post('/v1/chat/completions', { model: M, messages }));
  bits.push(await runHarness('pi', M).catch(() => false));
  bits.push(await runHarness('codex', M).catch(() => false));
  bits.push(await post('/v1/responses', { model: M, input: 'Say hi', stream: true }));
  const code = bits.reduce((acc, b, i) => acc + (b ? 1 << i : 0), 0);
  const target = start + BASE + code * STEP + STEP / 2;
  await new Promise((r) => setTimeout(r, Math.max(0, target - Date.now())));
});
