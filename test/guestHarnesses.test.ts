import { describe, expect, it } from 'vitest';
import { claudeCode, codex, gemini, newState, pi } from '../src/guest/harnesses.js';
import type { RunnerConfig } from '../src/server/launchpad/protocol.js';

const lines = (records: object[]): string[] => records.map((r) => JSON.stringify(r));

const config: RunnerConfig = {
  runId: 'r1',
  runToken: 'gwr_x',
  gatewayUrl: 'http://172.30.0.1:7420',
  sessionKey: 'gws_key',
  harness: 'claude-code',
  llm: { provider: 'anthropic', model: 'claude-sonnet-5' },
  gatewayTools: ['gateway_github'],
  prompt: 'Do the thing',
  systemPrompt: 'You are an agent',
  memory: null,
  deadline: '2026-01-01T02:00:00Z',
  network: { address: '', prefixLength: 0, gateway: '' },
};
const ctx = {
  config,
  home: '/home/agent',
  guestDir: '/opt/launchpad',
  nodeBin: '/usr/bin/node',
  extraPath: null,
};

describe('Claude Code', () => {
  it('points Claude Code at the gateway with the gateway MCP server', () => {
    const launch = claudeCode.launch(ctx);
    expect(launch.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://172.30.0.1:7420/proxy/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'gws_key',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(launch.args).toEqual(
      expect.arrayContaining(['-p', 'Do the thing', '--model', 'claude-sonnet-5']),
    );
    const mcp = JSON.parse(launch.args[launch.args.indexOf('--mcp-config') + 1] ?? '{}');
    expect(mcp.mcpServers.gateway).toMatchObject({
      command: '/usr/bin/node',
      args: ['/opt/launchpad/mcp.js'],
    });
  });

  it('turns stream-json into events and keeps the final result', () => {
    const state = newState();
    const events = lines([
      { type: 'system', subtype: 'init', model: 'claude-sonnet-5' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Looking at issues' },
            {
              type: 'tool_use',
              id: 't1',
              name: 'mcp__gateway__gateway_github',
              input: { method: 'GET', path: '/x' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: 'HTTP 200' }],
              is_error: false,
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', is_error: false, result: 'All done', num_turns: 2 },
    ]).flatMap((l) => claudeCode.parse(l, state));
    expect(events.map((e) => e.type)).toEqual([
      'status',
      'thinking',
      'assistant_text',
      'tool_call',
      'tool_result',
      'final',
    ]);
    expect(events[3]).toMatchObject({ tool: 'mcp__gateway__gateway_github', callId: 't1' });
    expect(events[4]).toMatchObject({ callId: 't1', text: 'HTTP 200', data: { isError: false } });
    expect(state).toMatchObject({ finalMessage: 'All done', error: null });
    expect(claudeCode.parse('not json', state)).toEqual([]);
  });

  it('records errors reported in the result', () => {
    const state = newState();
    claudeCode.parse(
      JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_turns', result: '' }),
      state,
    );
    expect(state.error).toBe('error_max_turns');
  });
});

describe('Codex', () => {
  it('configures the gateway as model provider and MCP server', () => {
    const launch = codex.launch({
      ...ctx,
      config: { ...config, harness: 'codex', llm: { provider: 'openai', model: null } },
    });
    expect(launch.args).toContain(
      'model_providers.gateway.base_url="http://172.30.0.1:7420/proxy/openai/v1"',
    );
    expect(launch.args).toContain('model_providers.gateway.env_key="GATEWAY_SESSION_KEY"');
    expect(launch.args.at(-1)).toBe('Do the thing');
  });

  it('parses exec --json items', () => {
    const state = newState();
    const events = lines([
      { type: 'thread.started', thread_id: 'th' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls' } },
      {
        type: 'item.completed',
        item: {
          id: 'i1',
          type: 'command_execution',
          aggregated_output: 'a b',
          status: 'completed',
        },
      },
      {
        type: 'item.started',
        item: {
          id: 'i2',
          type: 'mcp_tool_call',
          tool: 'gateway_github',
          arguments: { path: '/x' },
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'i2',
          type: 'mcp_tool_call',
          tool: 'gateway_github',
          status: 'failed',
          error: { message: 'denied' },
        },
      },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Finished' } },
      { type: 'turn.completed', usage: { input_tokens: 5 } },
    ]).flatMap((l) => codex.parse(l, state));
    expect(events.map((e) => e.type)).toEqual([
      'status',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'assistant_text',
      'usage',
    ]);
    expect(events[1]).toMatchObject({ tool: 'shell', callId: 'i1' });
    expect(events[4]).toMatchObject({
      tool: 'gateway_github',
      data: { isError: true, output: 'denied' },
    });
    expect(state.finalMessage).toBe('Finished');
    codex.parse(JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } }), state);
    expect(state.error).toBe('quota');
  });
});

describe('Gemini CLI', () => {
  it('parses stream-json and joins assistant deltas', () => {
    const state = newState();
    const events = lines([
      { type: 'init', model: 'gemini-2.5-pro' },
      { type: 'message', role: 'assistant', content: 'Hel' },
      { type: 'message', role: 'assistant', content: 'lo' },
      { type: 'tool_use', tool_name: 'gateway_github', tool_id: 'g1', parameters: {} },
      { type: 'tool_result', tool_id: 'g1', status: 'success', output: 'ok' },
      { type: 'message', role: 'assistant', content: 'Done.' },
      { type: 'result', status: 'success' },
    ]).flatMap((l) => gemini.parse(l, state));
    expect(events.map((e) => e.type)).toEqual([
      'status',
      'assistant_text',
      'tool_call',
      'tool_result',
      'assistant_text',
      'final',
    ]);
    expect(state.finalMessage).toBe('Done.');
    const launch = gemini.launch({
      ...ctx,
      config: { ...config, harness: 'gemini', llm: { provider: 'gemini', model: null } },
    });
    expect(launch.env.GOOGLE_GEMINI_BASE_URL).toBe('http://172.30.0.1:7420/proxy/gemini');
    expect(launch.files[0]?.content).toContain('mcp.js');
  });
});

describe('pi', () => {
  it('routes the provider through the gateway and parses json events', () => {
    const launch = pi.launch({ ...ctx, config: { ...config, harness: 'pi' } });
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '--model',
        'anthropic/claude-sonnet-5',
        '-e',
        '/opt/launchpad/pi-extension.mjs',
      ]),
    );
    expect(launch.env.ANTHROPIC_API_KEY).toBe('gws_key');
    expect(JSON.parse(launch.files[0]?.content ?? '{}')).toEqual({
      providers: { anthropic: { baseUrl: 'http://172.30.0.1:7420/proxy/anthropic' } },
    });
    const state = newState();
    const events = lines([
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'p1', toolName: 'gateway_github', args: {} },
      {
        type: 'tool_execution_end',
        toolCallId: 'p1',
        toolName: 'gateway_github',
        result: { content: [{ type: 'text', text: 'ok' }] },
        isError: false,
      },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Bye' }] },
      },
      { type: 'agent_end' },
    ]).flatMap((l) => pi.parse(l, state));
    expect(events.map((e) => e.type)).toEqual([
      'status',
      'tool_call',
      'tool_result',
      'assistant_text',
      'final',
    ]);
    expect(state.finalMessage).toBe('Bye');
  });
});
