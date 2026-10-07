import { isRecord } from '../json.js';
import { matchPath } from '../pathMatch.js';
import type {
  AuthzAllowed,
  AuthzDecision,
  Grant,
  TokenUsage,
  ToolProvider,
  ToolRequest,
  ToolRequestContext,
} from '../types.js';
import {
  CHATGPT_RESPONSES_URL,
  chatgptAccountId,
  chatgptHeaders,
  createChatGptDeviceFlow,
} from './chatgpt.js';
import {
  canonical,
  checkBudget,
  cappedLimit,
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
 * OpenAI API (`https://api.openai.com/v1/...`): Responses (Codex, pi) and Chat Completions. The
 * gateway swaps the session key for the real API key, checks the model, caps the output-token
 * limit to the key's token budget and meters the (streamed) response.
 */

const API = 'https://api.openai.com';
/** Tool types executed by the client; everything else runs at OpenAI (web search, remote MCP…). */
const CLIENT_TOOL_TYPES = new Set(['function', 'custom', 'local_shell', 'shell', 'apply_patch']);

function checkServerTools(body: Record<string, unknown>, grant: Grant): void {
  if (grant.permissions.includes(LLM_PERM.SERVER_TOOLS)) return;
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  for (const tool of tools) {
    const type = isRecord(tool) && typeof tool.type === 'string' ? tool.type : 'unknown';
    if (!CLIENT_TOOL_TYPES.has(type)) {
      throw new Denied(`Server-side tool "${type}" needs permission "${LLM_PERM.SERVER_TOOLS}"`);
    }
  }
}

/** Responses API input includes cache reads and cache writes; output includes reasoning. */
function foldResponsesUsage(u: unknown, usage: TokenUsage): void {
  if (!isRecord(u)) return;
  const cached = count(u.input_tokens_details, 'cached_tokens');
  const written = count(u.input_tokens_details, 'cache_write_tokens');
  usage.cacheRead = cached;
  usage.cacheWrite = written;
  usage.input = Math.max(0, count(u, 'input_tokens') - cached - written);
  usage.output = count(u, 'output_tokens');
}

/** Chat Completions usage: `prompt_tokens` includes the cached ones. */
function foldChatUsage(u: unknown, usage: TokenUsage): void {
  if (!isRecord(u)) return;
  const cached = count(u.prompt_tokens_details, 'cached_tokens');
  usage.cacheRead = cached;
  usage.input = Math.max(0, count(u, 'prompt_tokens') - cached);
  usage.output = count(u, 'completion_tokens');
}

function generate(body: Record<string, unknown>, grant: Grant): { model: string; stream: boolean } {
  requirePermission(grant, LLM_PERM.INVOKE);
  const model = checkModel(grant, body.model);
  checkServerTools(body, grant);
  return { model, stream: body.stream === true };
}

/**
 * A ChatGPT sign-in: the call goes to the ChatGPT backend, which only accepts unstored responses
 * and no output limit (the token budget is still enforced between calls).
 */
function chatgptResponses(
  body: Record<string, unknown>,
  ctx: ToolRequestContext,
): Partial<AuthzAllowed> {
  checkBudget(ctx.tokensRemaining);
  body.store = false;
  delete body.max_output_tokens;
  return { upstreamUrl: CHATGPT_RESPONSES_URL, upstreamHeaders: chatgptHeaders };
}

function responses(request: ToolRequest, grant: Grant, ctx: ToolRequestContext): AuthzDecision {
  const body = jsonBody(request);
  const { model, stream } = generate(body, grant);
  const chatgpt = chatgptAccountId(ctx.secret) !== null;
  let routing: Partial<AuthzAllowed> = {};
  if (chatgpt) {
    routing = chatgptResponses(body, ctx);
  } else {
    const cap = cappedLimit(body.max_output_tokens, ctx.tokensRemaining);
    if (cap !== undefined) body.max_output_tokens = cap;
  }
  return {
    ...routing,
    allowed: true,
    permission: LLM_PERM.INVOKE,
    detail: `responses ${model}${stream ? ' (stream)' : ''}`,
    body: canonical(body),
    meter: (contentType) =>
      eventMeter(contentType, model, (event, usage) => {
        if (!isRecord(event)) return;
        // Streams end with `response.completed` (or `.incomplete` / `.failed`) carrying usage.
        const response = isRecord(event.response) ? event.response : event;
        foldResponsesUsage(response.usage, usage);
      }),
  };
}

function chatCompletions(
  request: ToolRequest,
  grant: Grant,
  ctx: ToolRequestContext,
): AuthzDecision {
  const body = jsonBody(request);
  const { model, stream } = generate(body, grant);
  const current = body.max_completion_tokens ?? body.max_tokens;
  const cap = cappedLimit(current, ctx.tokensRemaining);
  if (cap !== undefined) {
    body.max_completion_tokens = cap;
    delete body.max_tokens;
  }
  // Streamed chat completions only report usage when asked to: the budget needs it.
  if (stream) {
    const options = isRecord(body.stream_options) ? body.stream_options : {};
    body.stream_options = { ...options, include_usage: true };
  }
  return {
    allowed: true,
    permission: LLM_PERM.INVOKE,
    detail: `chat ${model}${stream ? ' (stream)' : ''}`,
    body: canonical(body),
    meter: (contentType) =>
      eventMeter(contentType, model, (event, usage) => {
        if (isRecord(event)) foldChatUsage(event.usage, usage);
      }),
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
    chatgptAccountId(ctx.secret) !== null &&
    !(verb === 'POST' && matchPath('v1/responses', segments))
  ) {
    throw new Denied('A ChatGPT sign-in only serves the Responses API (POST /v1/responses)');
  }
  if (
    verb === 'GET' &&
    (matchPath('v1/models', segments) ?? matchPath('v1/models/:id', segments))
  ) {
    requirePermission(grant, LLM_PERM.MODELS_READ);
    return { allowed: true, permission: LLM_PERM.MODELS_READ };
  }
  if (request.search !== '') throw new Denied('Unsupported query string');
  if (verb === 'POST' && matchPath('v1/responses', segments)) {
    return responses(request, grant, ctx);
  }
  if (verb === 'POST' && matchPath('v1/chat/completions', segments)) {
    return chatCompletions(request, grant, ctx);
  }
  throw new Denied(`${verb} /${segments.join('/')} is not covered by any gateway permission`);
}

export function createOpenAIProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  return {
    id: 'openai',
    name: 'OpenAI',
    kind: 'llm',
    credentialHelp:
      'An OpenAI API key (platform.openai.com → API keys). Agents call the models through the gateway with their session key and never see this key.',
    credentialPlaceholder: 'sk-proj-…',
    resourceHelp: MODEL_RESOURCE_HELP,
    permissions: LLM_PERMISSIONS,
    upstreamBaseUrl: API,
    example: {
      method: 'POST',
      path: '/v1/responses',
      body: '{"model":"gpt-5","input":"Hello"}',
      clientHint: 'e.g. OPENAI_BASE_URL (…/proxy/openai/v1) + OPENAI_API_KEY',
    },

    deviceFlow: createChatGptDeviceFlow(fetchImpl),

    validateResource: validateModelPattern,

    async verifyCredential(secret) {
      if (chatgptAccountId(secret)) return { keyType: 'ChatGPT subscription (pasted token)' };
      const res = await fetchImpl(`${API}/v1/models`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      if (!res.ok) throw new Error(`OpenAI rejected the API key (HTTP ${res.status})`);
      return { keyType: 'API key' };
    },

    authorize: (request, grant, ctx) => decide(() => authorizeRequest(request, grant, ctx)),

    upstreamHeaders(secret, incoming) {
      const headers = forwardHeaders(incoming, ['content-type', 'accept', 'openai-beta']);
      headers.set('authorization', `Bearer ${secret}`);
      return headers;
    },
  };
}
