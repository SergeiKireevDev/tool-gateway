import { isRecord } from '../json.js';
import { matchPath } from '../pathMatch.js';
import type {
  AuthzDecision,
  Grant,
  ToolProvider,
  ToolRequest,
  ToolRequestContext,
} from '../types.js';
import {
  canonical,
  cappedLimit,
  checkBudget,
  checkModel,
  count,
  decide,
  Denied,
  eventMeter,
  forwardHeaders,
  jsonBody,
  LLM_PERM,
  LLM_PERMISSIONS,
  MODEL_RESOURCE_HELP,
  requirePermission,
  validateModelPattern,
} from './common.js';

/**
 * Anthropic Messages API (`https://api.anthropic.com/v1/...`), used by Claude Code and pi. The
 * client authenticates with its session key as `x-api-key` or `Authorization: Bearer`; the
 * gateway swaps in the real API key, checks the model, caps `max_tokens` to the key's token budget
 * and meters the (streamed) response.
 */

const API = 'https://api.anthropic.com';
const DEFAULT_VERSION = '2023-06-01';
/** `budget_tokens` must be at least this (and below `max_tokens`) when extended thinking is on. */
const MIN_THINKING_BUDGET = 1024;

/** Tool types run by the client (the agent's VM), not by Anthropic. */
const CLIENT_TOOL_PREFIXES = ['bash_', 'text_editor_', 'computer_', 'memory_'];
/** Request fields that make Anthropic reach the network (remote MCP, containers). */
const SERVER_SIDE_FIELDS = ['mcp_servers', 'container'];

function isClientTool(tool: unknown): boolean {
  if (!isRecord(tool)) return false;
  const type = tool.type;
  if (type === undefined || type === 'custom') return true;
  return typeof type === 'string' && CLIENT_TOOL_PREFIXES.some((p) => type.startsWith(p));
}

function checkServerTools(body: Record<string, unknown>, grant: Grant): void {
  if (grant.permissions.includes(LLM_PERM.SERVER_TOOLS)) return;
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  const server = tools.find((t) => !isClientTool(t));
  if (server !== undefined) {
    const type = isRecord(server) && typeof server.type === 'string' ? server.type : 'unknown';
    throw new Denied(`Server-side tool "${type}" needs permission "${LLM_PERM.SERVER_TOOLS}"`);
  }
  const field = SERVER_SIDE_FIELDS.find((f) => f in body);
  if (field) throw new Denied(`"${field}" needs permission "${LLM_PERM.SERVER_TOOLS}"`);
}

/** Lowers `max_tokens` to the remaining budget, keeping extended thinking valid. */
function capTokens(body: Record<string, unknown>, remaining: number | null): void {
  const cap = cappedLimit(body.max_tokens, remaining);
  if (cap === undefined) return;
  body.max_tokens = cap;
  const thinking = body.thinking;
  if (!isRecord(thinking) || typeof thinking.budget_tokens !== 'number') return;
  if (thinking.budget_tokens < cap) return;
  if (cap - 1 < MIN_THINKING_BUDGET) {
    throw new Denied('Not enough token budget left for extended thinking');
  }
  thinking.budget_tokens = cap - 1;
}

function messages(request: ToolRequest, grant: Grant, ctx: ToolRequestContext): AuthzDecision {
  requirePermission(grant, LLM_PERM.INVOKE);
  const body = jsonBody(request);
  const model = checkModel(grant, body.model);
  checkServerTools(body, grant);
  capTokens(body, ctx.tokensRemaining);
  const stream = body.stream === true;
  return {
    allowed: true,
    permission: LLM_PERM.INVOKE,
    detail: `${model}${stream ? ' (stream)' : ''}`,
    body: canonical(body),
    meter: (contentType) =>
      eventMeter(contentType, model, (event, usage) => {
        if (!isRecord(event)) return;
        // Streams: `message_start` carries the input side, `message_delta` the running output.
        const message = event.type === 'message_start' ? event.message : event;
        const u = isRecord(message) ? message.usage : event.usage;
        if (!isRecord(u)) return;
        usage.input = Math.max(usage.input, count(u, 'input_tokens'));
        usage.output = Math.max(usage.output, count(u, 'output_tokens'));
        usage.cacheRead = Math.max(usage.cacheRead, count(u, 'cache_read_input_tokens'));
        usage.cacheWrite = Math.max(usage.cacheWrite, count(u, 'cache_creation_input_tokens'));
      }),
  };
}

function countTokens(request: ToolRequest, grant: Grant, ctx: ToolRequestContext): AuthzDecision {
  requirePermission(grant, LLM_PERM.INVOKE);
  checkBudget(ctx.tokensRemaining);
  const body = jsonBody(request);
  const model = checkModel(grant, body.model);
  return {
    allowed: true,
    permission: LLM_PERM.INVOKE,
    detail: `count tokens ${model}`,
    body: canonical(body),
  };
}

function authorizeRequest(
  request: ToolRequest,
  grant: Grant,
  ctx: ToolRequestContext,
): AuthzDecision {
  const verb = request.method.toUpperCase();
  const { segments } = request;
  if (
    verb === 'GET' &&
    (matchPath('v1/models', segments) ?? matchPath('v1/models/:id', segments))
  ) {
    requirePermission(grant, LLM_PERM.MODELS_READ);
    return { allowed: true, permission: LLM_PERM.MODELS_READ };
  }
  if (request.search !== '' && request.search !== '?beta=true') {
    throw new Denied('Unsupported query string');
  }
  if (verb === 'POST' && matchPath('v1/messages', segments)) {
    return messages(request, grant, ctx);
  }
  if (verb === 'POST' && matchPath('v1/messages/count_tokens', segments)) {
    return countTokens(request, grant, ctx);
  }
  throw new Denied(`${verb} /${segments.join('/')} is not covered by any gateway permission`);
}

export function createAnthropicProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'llm',
    sessionKeyHeaders: ['x-api-key'],
    credentialHelp:
      'An Anthropic API key (console.anthropic.com → API keys). Agents call Claude through the gateway with their session key and never see this key.',
    credentialPlaceholder: 'sk-ant-api03-…',
    resourceHelp: MODEL_RESOURCE_HELP,
    permissions: LLM_PERMISSIONS,
    upstreamBaseUrl: API,
    example: {
      method: 'POST',
      path: '/v1/messages',
      body: '{"model":"claude-sonnet-5","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}',
      clientHint: 'e.g. ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN',
    },

    validateResource: validateModelPattern,

    async verifyCredential(secret) {
      const res = await fetchImpl(`${API}/v1/models?limit=1`, {
        headers: { 'x-api-key': secret, 'anthropic-version': DEFAULT_VERSION },
      });
      if (!res.ok) throw new Error(`Anthropic rejected the API key (HTTP ${res.status})`);
      return { keyType: 'API key' };
    },

    authorize: (request, grant, ctx) => decide(() => authorizeRequest(request, grant, ctx)),

    upstreamHeaders(secret, incoming) {
      const headers = forwardHeaders(incoming, ['anthropic-beta', 'content-type', 'accept']);
      headers.set('anthropic-version', incoming.get('anthropic-version') ?? DEFAULT_VERSION);
      headers.set('x-api-key', secret);
      return headers;
    },
  };
}
