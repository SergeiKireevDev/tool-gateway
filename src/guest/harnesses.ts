import path from 'node:path';
import type { Harness, RunEvent, RunnerConfig } from '../server/launchpad/protocol.js';
import type { LlmEndpointApi } from '../server/tools/types.js';

/**
 * Harness adapters: how to start each agent CLI headless against the gateway (model API and
 * gateway tools), and how to turn its JSON output lines into transcript events.
 */

export type EventDraft = Omit<RunEvent, 'seq' | 'at'>;

export interface HarnessState {
  /** The agent's final answer, once known. */
  finalMessage: string | null;
  /** Set when the harness reported a failed run (independently of its exit code). */
  error: string | null;
  /** Streamed assistant text not yet closed by a final message (Gemini, pi). */
  pendingText: string;
}

export const newState = (): HarnessState => ({ finalMessage: null, error: null, pendingText: '' });

export interface LaunchContext {
  config: RunnerConfig;
  /** The agent's home directory. */
  home: string;
  /** Where the runner's helper scripts are (`mcp.js`, `pi-extension.mjs`). */
  guestDir: string;
  /** Node binary, to start the MCP server. */
  nodeBin: string;
  /** Directories searched for the harness CLIs before the system ones (local driver, tests). */
  extraPath: string | null;
}

export interface HarnessLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Config files to write (as the agent) before starting. */
  files: { path: string; content: string }[];
  /** Directories to create (as the agent) before starting. */
  dirs: string[];
}

export interface HarnessAdapter {
  launch(ctx: LaunchContext): HarnessLaunch;
  parse(line: string, state: HarnessState): EventDraft[];
}

const SUMMARY_CHARS = 300;
const MCP_SERVER = 'gateway';

const summarize = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text;
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function parseJson(line: string): Json | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Environment every harness gets: the gateway, and nothing from the runner's own. */
function baseEnv(ctx: LaunchContext): Record<string, string> {
  return {
    HOME: ctx.home,
    PATH: [ctx.extraPath, '/usr/local/bin:/usr/bin:/bin'].filter(Boolean).join(':'),
    LANG: 'C.UTF-8',
    GATEWAY_URL: ctx.config.gatewayUrl,
    GATEWAY_SESSION_KEY: ctx.config.sessionKey,
  };
}

const mcpScript = (ctx: LaunchContext): string => path.join(ctx.guestDir, 'mcp.js');
const proxy = (ctx: LaunchContext, provider: string): string =>
  `${ctx.config.gatewayUrl}/proxy/${provider}`;

/** Claude Code's model aliases: on a custom endpoint they all map to the run's model. */
const CLAUDE_MODEL_ENVS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

/**
 * A custom endpoint serves only the models its server has: background calls Claude Code makes
 * with its own model choices (titles, subagents…) use the run's model too.
 */
function claudeModelEnv(config: RunnerConfig): Record<string, string> {
  const { provider, model } = config.llm;
  if (provider !== 'custom' || !model) return {};
  return Object.fromEntries(CLAUDE_MODEL_ENVS.map((name) => [name, model]));
}

const toolCall = (tool: string, callId: string | undefined, input: unknown): EventDraft => ({
  type: 'tool_call',
  text: `${tool} ${summarize(input)}`,
  tool,
  ...(callId ? { callId } : {}),
  data: { input },
});

const toolResult = (
  tool: string | undefined,
  callId: string | undefined,
  output: string,
  isError: boolean,
): EventDraft => ({
  type: 'tool_result',
  text: summarize(output),
  ...(tool ? { tool } : {}),
  ...(callId ? { callId } : {}),
  data: { isError, output: output.slice(0, SUMMARY_CHARS * SUMMARY_CHARS) },
});

/** Text of a tool result's `content`: a string, or blocks with `text`. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
  return content.map((b: unknown) => (isObject(b) ? (str(b.text) ?? '') : '')).join('\n');
}

// ------------------------------------------------------------------ Claude Code

function claudeAssistant(message: Json): EventDraft[] {
  const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
  return content.flatMap((block): EventDraft[] => {
    if (!isObject(block)) return [];
    if (block.type === 'text' && str(block.text))
      return [{ type: 'assistant_text', text: String(block.text) }];
    if (block.type === 'thinking' && str(block.thinking)) {
      return [{ type: 'thinking', text: summarize(block.thinking) }];
    }
    if (block.type === 'tool_use')
      return [toolCall(str(block.name) ?? 'tool', str(block.id), block.input)];
    return [];
  });
}

function claudeToolResults(message: Json): EventDraft[] {
  const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
  return content.flatMap((block): EventDraft[] =>
    isObject(block) && block.type === 'tool_result'
      ? [
          toolResult(
            undefined,
            str(block.tool_use_id),
            contentText(block.content),
            block.is_error === true,
          ),
        ]
      : [],
  );
}

export const claudeCode: HarnessAdapter = {
  launch(ctx) {
    const { config } = ctx;
    const mcpConfig = {
      mcpServers: {
        [MCP_SERVER]: {
          type: 'stdio',
          command: ctx.nodeBin,
          args: [mcpScript(ctx)],
          env: { GATEWAY_URL: config.gatewayUrl, GATEWAY_SESSION_KEY: config.sessionKey },
        },
      },
    };
    return {
      command: 'claude',
      args: [
        '-p',
        config.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        '--append-system-prompt',
        config.systemPrompt,
        '--mcp-config',
        JSON.stringify(mcpConfig),
        '--strict-mcp-config',
        ...(config.llm.model ? ['--model', config.llm.model] : []),
      ],
      env: {
        ...baseEnv(ctx),
        ANTHROPIC_BASE_URL: proxy(ctx, config.llm.provider),
        ANTHROPIC_AUTH_TOKEN: config.sessionKey,
        ...claudeModelEnv(config),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
      },
      files: [],
      dirs: [],
    };
  },

  parse(line, state) {
    const record = parseJson(line);
    if (!record) return [];
    if (record.type === 'system' && record.subtype === 'init') {
      return [
        { type: 'status', text: `Claude Code started (${str(record.model) ?? 'default model'})` },
      ];
    }
    if (record.type === 'assistant' && isObject(record.message))
      return claudeAssistant(record.message);
    if (record.type === 'user' && isObject(record.message))
      return claudeToolResults(record.message);
    if (record.type === 'result') {
      const result = str(record.result) ?? '';
      if (record.is_error !== true) state.finalMessage = result;
      else state.error = result === '' ? (str(record.subtype) ?? 'Claude Code failed') : result;
      return [
        {
          type: 'final',
          text: summarize(result),
          data: { usage: record.usage, turns: record.num_turns },
        },
      ];
    }
    return [];
  },
};

// ------------------------------------------------------------------ Codex

const toml = (value: string): string => JSON.stringify(value);

/** Codex `error` records that are only warnings. */
const CODEX_WARNINGS = [/^Model metadata for .* not found/];

/** Tool name of a Codex item: MCP calls by tool, shell commands as `shell`, others by type. */
function codexTool(item: Json): string {
  if (item.type === 'mcp_tool_call') return str(item.tool) ?? 'mcp';
  if (item.type === 'command_execution') return 'shell';
  return str(item.type) ?? 'tool';
}

function codexToolInput(item: Json): unknown {
  if (item.type === 'command_execution') return item.command;
  return item.arguments ?? item.changes ?? item.query;
}

function codexToolOutput(item: Json): EventDraft {
  const error = isObject(item.error) ? str(item.error.message) : undefined;
  const result = isObject(item.result) ? item.result.content : item.result;
  const output = str(item.aggregated_output) ?? error ?? contentText(result);
  const failed = item.status === 'failed' || item.status === 'declined' || error !== undefined;
  return toolResult(codexTool(item), str(item.id), output, failed);
}

function codexItem(item: Json, completed: boolean, state: HarnessState): EventDraft[] {
  switch (item.type) {
    case 'agent_message': {
      if (!completed) return [];
      const text = str(item.text) ?? '';
      state.finalMessage = text;
      return [{ type: 'assistant_text', text }];
    }
    case 'reasoning':
      return completed ? [{ type: 'thinking', text: summarize(item.text) }] : [];
    case 'error':
      return [{ type: 'error', text: str(item.message) ?? 'error' }];
    default:
      return completed
        ? [codexToolOutput(item)]
        : [toolCall(codexTool(item), str(item.id), codexToolInput(item))];
  }
}

export const codex: HarnessAdapter = {
  launch(ctx) {
    const { config } = ctx;
    const override = (key: string, value: string): string[] => ['-c', `${key}=${value}`];
    return {
      command: 'codex',
      args: [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        ...override('model_provider', toml('gateway')),
        ...override('model_providers.gateway.name', toml('gateway')),
        ...override(
          'model_providers.gateway.base_url',
          toml(`${proxy(ctx, config.llm.provider)}/v1`),
        ),
        ...override('model_providers.gateway.env_key', toml('GATEWAY_SESSION_KEY')),
        ...override('model_providers.gateway.wire_api', toml('responses')),
        ...override(`mcp_servers.${MCP_SERVER}.command`, toml(ctx.nodeBin)),
        ...override(`mcp_servers.${MCP_SERVER}.args`, JSON.stringify([mcpScript(ctx)])),
        ...override(
          `mcp_servers.${MCP_SERVER}.env`,
          `{ GATEWAY_URL = ${toml(config.gatewayUrl)}, GATEWAY_SESSION_KEY = ${toml(config.sessionKey)} }`,
        ),
        ...override('developer_instructions', toml(config.systemPrompt)),
        // A custom endpoint has no hosted web search: Codex would offer the model a tool it lacks.
        ...(config.llm.provider === 'custom' ? override('web_search', toml('disabled')) : []),
        ...(config.llm.model ? ['--model', config.llm.model] : []),
        config.prompt,
      ],
      env: { ...baseEnv(ctx), CODEX_HOME: path.join(ctx.home, '.codex') },
      files: [],
      dirs: [path.join(ctx.home, '.codex')],
    };
  },

  parse(line, state) {
    const record = parseJson(line);
    if (!record) return [];
    switch (record.type) {
      case 'thread.started':
        return [{ type: 'status', text: 'Codex started' }];
      case 'item.started':
      case 'item.completed':
        return isObject(record.item)
          ? codexItem(record.item, record.type === 'item.completed', state)
          : [];
      case 'turn.completed':
        return [{ type: 'usage', text: 'Turn completed', data: record.usage }];
      case 'turn.failed': {
        const message = isObject(record.error) ? str(record.error.message) : undefined;
        state.error = message ?? 'Codex turn failed';
        return [{ type: 'error', text: state.error }];
      }
      case 'error': {
        const text = str(record.message) ?? 'Codex error';
        // A warning, not a failure: Codex knows no metadata (context window…) for custom models.
        return [{ type: CODEX_WARNINGS.some((w) => w.test(text)) ? 'status' : 'error', text }];
      }
      default:
        return [];
    }
  },
};

// ------------------------------------------------------------------ Gemini CLI

export const gemini: HarnessAdapter = {
  launch(ctx) {
    const { config } = ctx;
    // User settings: Gemini CLI ignores system settings in directories not owned by root.
    const settingsPath = path.join(ctx.home, '.gemini', 'settings.json');
    const settings = {
      security: { auth: { selectedType: 'gemini-api-key' } },
      mcpServers: {
        [MCP_SERVER]: {
          command: ctx.nodeBin,
          args: [mcpScript(ctx)],
          env: { GATEWAY_URL: config.gatewayUrl, GATEWAY_SESSION_KEY: config.sessionKey },
          trust: true,
        },
      },
    };
    return {
      command: 'gemini',
      args: [
        '--output-format',
        'stream-json',
        '--approval-mode',
        'yolo',
        '--skip-trust',
        '--allowed-mcp-server-names',
        MCP_SERVER,
        ...(config.llm.model ? ['--model', config.llm.model] : []),
        // Gemini CLI has no system prompt flag: the instructions lead the prompt.
        '--prompt',
        `${config.systemPrompt}\n\n# Task\n\n${config.prompt}`,
      ],
      env: {
        ...baseEnv(ctx),
        GEMINI_API_KEY: config.sessionKey,
        GOOGLE_GEMINI_BASE_URL: proxy(ctx, 'gemini'),
      },
      files: [{ path: settingsPath, content: JSON.stringify(settings) }],
      dirs: [],
    };
  },

  parse(line, state) {
    const record = parseJson(line);
    const handler = record ? GEMINI_EVENTS[str(record.type) ?? ''] : undefined;
    return record && handler ? handler(record, state) : [];
  },
};

const errorMessage = (record: Json): string | undefined =>
  isObject(record.error) ? str(record.error.message) : undefined;

const GEMINI_EVENTS: Record<string, (record: Json, state: HarnessState) => EventDraft[]> = {
  init: (record) => [
    { type: 'status', text: `Gemini CLI started (${str(record.model) ?? 'default model'})` },
  ],
  message: (record, state) => {
    if (record.role === 'assistant') state.pendingText += str(record.content) ?? '';
    return [];
  },
  tool_use: (record, state) => [
    ...flushText(state),
    toolCall(str(record.tool_name) ?? 'tool', str(record.tool_id), record.parameters),
  ],
  tool_result: (record) => [
    toolResult(
      undefined,
      str(record.tool_id),
      str(record.output) ?? errorMessage(record) ?? '',
      record.status === 'error',
    ),
  ],
  error: (record) => [{ type: 'error', text: str(record.message) ?? 'Gemini CLI error' }],
  result: (record, state) => {
    const events = flushText(state);
    if (record.status === 'error') state.error = errorMessage(record) ?? 'Gemini CLI failed';
    return [
      ...events,
      { type: 'final', text: summarize(state.finalMessage ?? ''), data: record.stats },
    ];
  },
};

/** Closes streamed assistant text into one event; it is the final message until more comes. */
function flushText(state: HarnessState): EventDraft[] {
  const text = state.pendingText.trim();
  state.pendingText = '';
  if (!text) return [];
  state.finalMessage = text;
  return [{ type: 'assistant_text', text }];
}

// ------------------------------------------------------------------ pi

const PI_PROVIDER: Record<string, { id: string; keyEnv: string; baseUrl: (gw: string) => string }> =
  {
    anthropic: {
      id: 'anthropic',
      keyEnv: 'ANTHROPIC_API_KEY',
      baseUrl: (gw) => `${gw}/proxy/anthropic`,
    },
    openai: { id: 'openai', keyEnv: 'OPENAI_API_KEY', baseUrl: (gw) => `${gw}/proxy/openai/v1` },
    gemini: {
      id: 'google',
      keyEnv: 'GEMINI_API_KEY',
      baseUrl: (gw) => `${gw}/proxy/gemini/v1beta`,
    },
  };

/** pi's `api` for each chat API a custom endpoint can speak. */
const PI_ENDPOINT_API: Record<LlmEndpointApi, { api: string; path: string }> = {
  anthropic: { api: 'anthropic-messages', path: '' },
  openai: { api: 'openai-completions', path: '/v1' },
};

interface PiSetup {
  /** pi's `models.json`. */
  models: Json;
  /** For `--model`; null = pi's default for the only provider it has a key for. */
  model: string | null;
  env: Record<string, string>;
}

/** A custom endpoint, declared to pi as its own provider with the run's model. */
function piCustom(ctx: LaunchContext): PiSetup {
  const { provider, model, api } = ctx.config.llm;
  if (!api || !model) throw new Error('pi needs the chat API and model of a custom endpoint');
  const endpoint = PI_ENDPOINT_API[api];
  const custom = {
    baseUrl: `${proxy(ctx, provider)}${endpoint.path}`,
    api: endpoint.api,
    // Read from the environment when pi calls the endpoint: the key is not written to disk.
    apiKey: '$GATEWAY_SESSION_KEY',
    models: [{ id: model }],
  };
  return { models: { providers: { [provider]: custom } }, model: `${provider}/${model}`, env: {} };
}

function piSetup(ctx: LaunchContext): PiSetup {
  const { provider, model } = ctx.config.llm;
  if (provider === 'custom') return piCustom(ctx);
  const official = PI_PROVIDER[provider];
  if (!official) throw new Error(`pi can't use ${provider}`);
  return {
    models: { providers: { [official.id]: { baseUrl: official.baseUrl(ctx.config.gatewayUrl) } } },
    model: model ? `${official.id}/${model}` : null,
    env: { [official.keyEnv]: ctx.config.sessionKey },
  };
}

function piAssistant(message: Json, state: HarnessState): EventDraft[] {
  const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
  const events: EventDraft[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'text' && str(block.text)) {
      state.finalMessage = String(block.text);
      events.push({ type: 'assistant_text', text: String(block.text) });
    }
    if (block.type === 'thinking' && str(block.thinking))
      events.push({ type: 'thinking', text: summarize(block.thinking) });
  }
  if (message.stopReason === 'error') {
    state.error = str(message.errorMessage) ?? 'pi model call failed';
    events.push({ type: 'error', text: state.error });
  }
  return events;
}

export const pi: HarnessAdapter = {
  launch(ctx) {
    const { config } = ctx;
    const setup = piSetup(ctx);
    const agentDir = path.join(ctx.home, '.pi', 'agent');
    return {
      command: 'pi',
      args: [
        '--mode',
        'json',
        '--no-session',
        '-e',
        path.join(ctx.guestDir, 'pi-extension.mjs'),
        '--append-system-prompt',
        config.systemPrompt,
        // Without a model, pi picks its default for the only provider it has a key for.
        ...(setup.model ? ['--model', setup.model] : []),
        config.prompt,
      ],
      env: { ...baseEnv(ctx), PI_CODING_AGENT_DIR: agentDir, ...setup.env },
      files: [{ path: path.join(agentDir, 'models.json'), content: JSON.stringify(setup.models) }],
      dirs: [],
    };
  },

  parse(line, state) {
    const record = parseJson(line);
    if (!record) return [];
    switch (record.type) {
      case 'agent_start':
        return [{ type: 'status', text: 'pi started' }];
      case 'message_end':
        return isObject(record.message) && record.message.role === 'assistant'
          ? piAssistant(record.message, state)
          : [];
      case 'tool_execution_start':
        return [toolCall(str(record.toolName) ?? 'tool', str(record.toolCallId), record.args)];
      case 'tool_execution_end': {
        const result = isObject(record.result) ? record.result : {};
        return [
          toolResult(
            str(record.toolName),
            str(record.toolCallId),
            contentText(result.content),
            record.isError === true,
          ),
        ];
      }
      case 'agent_end':
        return [{ type: 'final', text: summarize(state.finalMessage ?? '') }];
      default:
        return [];
    }
  },
};

export const HARNESS_ADAPTERS: Record<Harness, HarnessAdapter> = {
  'claude-code': claudeCode,
  codex,
  gemini,
  pi,
};
