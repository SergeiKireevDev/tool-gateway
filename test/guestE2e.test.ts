import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { Launchpad } from '../src/server/launchpad/launchpad.js';
import { LocalProcessDriver } from '../src/server/launchpad/localDriver.js';
import { RunStore } from '../src/server/launchpad/runStore.js';
import { Workflows } from '../src/server/launchpad/workflows.js';
import { createHarness, CUSTOM_LLM_URL, type Harness } from './helpers.js';

/**
 * A fake `claude` CLI: talks to the gateway MCP server it is given, calls the model API through
 * the gateway, writes an output file and MEMORY.md, and prints Claude Code stream-json.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const mcpConfig = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
const server = mcpConfig.mcpServers.gateway;
const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
readline.createInterface({ input: mcp.stdout }).on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
let id = 0;
const rpc = (method, params) => new Promise((resolve) => { id += 1; pending.set(id, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n'); });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const prompt = args[args.indexOf('-p') + 1];
(async () => {
  out({ type: 'system', subtype: 'init', model: 'fake-claude' });
  if (prompt.startsWith('Plan:')) {
    // A workflow's planner: writes the script next to this CLI to its output files.
    fs.mkdirSync(process.env.HOME + '/out', { recursive: true });
    fs.copyFileSync(__dirname + '/workflow-script.mjs', process.env.HOME + '/out/script.mjs');
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Wrote the script' });
    process.exit(0);
  }
  await rpc('initialize', {});
  const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: tools[0], input: { method: 'GET', path: '/repos/o/r/issues' } }] } });
  const res = await rpc('tools/call', { name: tools[0], arguments: { method: 'GET', path: '/repos/o/r/issues' } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: res.result.content, is_error: res.result.isError }] } });
  const llm = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.ANTHROPIC_AUTH_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 100, messages: [] }) });
  fs.mkdirSync(process.env.HOME + '/out', { recursive: true });
  fs.writeFileSync(process.env.HOME + '/out/report.md', 'prompt was: ' + args[args.indexOf('-p') + 1]);
  fs.writeFileSync(process.env.HOME + '/MEMORY.md', 'seen 1 issue; llm ' + llm.status);
  console.error('fake claude stderr line');
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Triaged 1 issue' });
  mcp.kill();
})();
`;

/** The script the fake planner writes: calls a tool, the custom LLM endpoint, and a model it lacks. */
const WORKFLOW_SCRIPT = `const headers = { authorization: \`Bearer \${process.env.GATEWAY_SESSION_KEY}\`, 'content-type': 'application/json' };
const issues = await fetch(\`\${process.env.GATEWAY_URL}/proxy/github/repos/o/r/issues\`, { headers });
console.log(\`issues \${issues.status}\`);
const body = JSON.stringify({ model: process.env.LLM_MODEL, messages: [{ role: 'user', content: 'hi' }] });
const llm = await fetch(\`\${process.env.LLM_URL}/v1/chat/completions\`, { method: 'POST', headers, body });
console.log(\`llm \${llm.status} \${process.env.LLM_API} \${process.env.LLM_MODEL}\`);
const frontier = await fetch(\`\${process.env.GATEWAY_URL}/proxy/anthropic/v1/messages\`, { method: 'POST', headers, body });
console.log(\`anthropic \${frontier.status}\`);
`;

let h: Harness;
let server: Server;
let launchpad: Launchpad;
let workflows: Workflows;

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'launchpad-e2e-'));
  execFileSync(process.execPath, ['scripts/build-guest.mjs', path.join(dir, 'guest')]);
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'claude'), FAKE_CLAUDE);
  await writeFile(path.join(bin, 'workflow-script.mjs'), WORKFLOW_SCRIPT);
  await chmod(path.join(bin, 'claude'), 0o755);

  h = await createHarness();
  launchpad = new Launchpad({
    gateway: h.gateway,
    runs: new RunStore(h.db),
    driver: new LocalProcessDriver(path.join(dir, 'guest', 'runner.js'), {
      LAUNCHPAD_HARNESS_PATH: bin,
    }),
    crypto: h.crypto,
    vmGatewayUrl: 'set below',
  });
  workflows = new Workflows(h.gateway, launchpad);
  launchpad.onFinished((run) => {
    workflows.onRunFinished(run);
  });
  server = createApp(h.gateway, h.config, { fetch: h.fetch, launchpad }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (h.config as { publicUrl: string }).publicUrl = url;
  (launchpad as unknown as { deps: { vmGatewayUrl: string } }).deps.vmGatewayUrl = url;
}, 60_000);

afterAll(() => {
  server.close();
});

async function waitFor(runId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const { status } = launchpad.runs.require(runId);
    if (!['queued', 'provisioning', 'running'].includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('run did not finish');
}

describe('a real runner with a fake harness (local driver)', () => {
  it('runs the agent end to end through the gateway', async () => {
    const gh = await h.gateway.createAccount({ tool: 'github', label: 'gh', secret: 'ghp_x' });
    const llm = await h.gateway.createAccount({
      tool: 'anthropic',
      label: 'c',
      secret: 'sk-ant-x',
    });
    const tpl = await h.gateway.createTemplate({
      name: 'agents',
      grants: [
        { tool: 'github', permissions: ['issues:read'], resources: ['o/r'] },
        { tool: 'anthropic', permissions: ['llm:invoke'], resources: [] },
      ],
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 4 * 3600,
    });
    const { member } = await h.gateway.createMember({
      name: 'alice',
      templateIds: [tpl.id],
      accountIds: [gh.id, llm.id],
    });
    const run = launchpad.launch(
      h.gateway.activeMember(member.id) ??
        (() => {
          throw new Error('no member');
        })(),
      {
        prompt: 'Triage o/r',
        templateId: tpl.id,
        harness: 'claude-code',
      },
    );
    expect(await waitFor(run.id)).toBe('succeeded');

    const done = launchpad.runs.require(run.id);
    expect(done).toMatchObject({
      finalMessage: 'Triaged 1 issue',
      memoryOut: 'seen 1 issue; llm 200',
    });
    const types = launchpad.runs.events(run.id).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['status', 'tool_call', 'tool_result', 'final', 'log']),
    );
    expect(launchpad.runs.output(run.id, 'report.md')?.toString()).toBe('prompt was: Triage o/r');
    const calls = h.gateway.activity.forSessions([done.sessionId ?? '']);
    expect(calls.map((c) => c.tool)).toEqual(expect.arrayContaining(['github', 'anthropic']));
    expect(h.gateway.llmUsage.totalsFor([done.sessionId ?? '']).calls).toBe(1);
    expect(h.gateway.listSessions().find((s) => s.id === done.sessionId)?.status).toBe('revoked');
  }, 30_000);

  it('runs a workflow: the planner writes a script, the execution container runs it', async () => {
    const gh = await h.gateway.createAccount({ tool: 'github', label: 'gh2', secret: 'ghp_x' });
    const llm = await h.gateway.createAccount({
      tool: 'anthropic',
      label: 'c2',
      secret: 'sk-ant-x',
    });
    const tpl = await h.gateway.createTemplate({
      name: 'workflow',
      grants: [
        { tool: 'github', permissions: ['issues:read'], resources: ['o/r'] },
        { tool: 'anthropic', permissions: ['llm:invoke'], resources: [] },
        {
          tool: 'custom',
          permissions: ['llm:invoke'],
          resources: ['qwen3'],
          endpoint: { url: CUSTOM_LLM_URL, api: 'openai', token: 'endpoint-token' },
        },
      ],
      defaultTtlSeconds: 3600,
      maxTtlSeconds: 4 * 3600,
    });
    const { member } = await h.gateway.createMember({
      name: 'bob',
      templateIds: [tpl.id],
      accountIds: [gh.id, llm.id],
    });
    const bob = h.gateway.activeMember(member.id);
    if (!bob) throw new Error('no member');
    const wf = workflows.create(bob, {
      prompt: 'Plan: triage o/r',
      templateId: tpl.id,
      harness: 'claude-code',
    });
    // The workflow stays active between its steps, until the script is done.
    let done = workflows.view(wf);
    for (let i = 0; i < 200 && ['queued', 'provisioning', 'running'].includes(done.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      done = workflows.view(wf);
    }
    expect(done.status).toBe('succeeded');
    const exec = done.steps[1]?.run;
    expect(exec?.harness).toBe('script');
    expect(exec?.finalMessage).toMatch(/^issues 200\nllm 200 openai qwen3\nanthropic 40[13]$/);
    const lines = launchpad.runs.events(exec?.id ?? '').filter((e) => e.type === 'assistant_text');
    expect(lines.map((e) => e.text)).toEqual(expect.arrayContaining(['issues 200']));
  }, 30_000);
});
