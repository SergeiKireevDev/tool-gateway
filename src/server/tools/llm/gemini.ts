import { isRecord } from '../json.js';
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
 * Gemini API (`https://generativelanguage.googleapis.com/v1beta/models/<model>:<method>`), used
 * by Gemini CLI and pi. The client sends its session key as `x-goog-api-key` (never `?key=`); the
 * gateway checks the model in the path, caps `maxOutputTokens` and meters the response.
 */

const API = 'https://generativelanguage.googleapis.com';
const VERSIONS = new Set(['v1', 'v1beta']);
const GENERATE = new Set(['generateContent', 'streamGenerateContent']);
const COUNT = 'countTokens';
/** Tools Google runs itself (search, URL fetching, code execution). */
const SERVER_TOOL_FIELDS = [
  'googleSearch',
  'googleSearchRetrieval',
  'urlContext',
  'codeExecution',
  'google_search',
  'url_context',
  'code_execution',
];

function checkServerTools(body: Record<string, unknown>, grant: Grant): void {
  if (grant.permissions.includes(LLM_PERM.SERVER_TOOLS)) return;
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  for (const tool of tools) {
    const field = isRecord(tool) ? SERVER_TOOL_FIELDS.find((f) => f in tool) : undefined;
    if (field)
      throw new Denied(`Server-side tool "${field}" needs permission "${LLM_PERM.SERVER_TOOLS}"`);
  }
}

function checkQuery(search: string): void {
  const params = new URLSearchParams(search);
  for (const [name, value] of params) {
    if (name === 'key') throw new Denied('Send the session key in x-goog-api-key, not ?key=');
    if (name !== 'alt' || value !== 'sse')
      throw new Denied(`Unsupported query parameter "${name}"`);
  }
}

function generate(
  request: ToolRequest,
  grant: Grant,
  ctx: ToolRequestContext,
  model: string,
  method: string,
): AuthzDecision {
  const body = jsonBody(request);
  checkServerTools(body, grant);
  if (method === COUNT) {
    checkBudget(ctx.tokensRemaining);
    return {
      allowed: true,
      permission: LLM_PERM.INVOKE,
      detail: `count tokens ${model}`,
      body: canonical(body),
    };
  }
  const config = isRecord(body.generationConfig) ? body.generationConfig : {};
  const cap = cappedLimit(config.maxOutputTokens, ctx.tokensRemaining);
  if (cap !== undefined) body.generationConfig = { ...config, maxOutputTokens: cap };
  return {
    allowed: true,
    permission: LLM_PERM.INVOKE,
    detail: `${model}${method === 'streamGenerateContent' ? ' (stream)' : ''}`,
    body: canonical(body),
    meter: (contentType) =>
      eventMeter(contentType, model, (event, usage) => {
        // Every streamed chunk repeats the running totals: the last one wins.
        const u = isRecord(event) ? event.usageMetadata : undefined;
        if (!isRecord(u)) return;
        const cached = count(u, 'cachedContentTokenCount');
        usage.cacheRead = cached;
        usage.input = Math.max(0, count(u, 'promptTokenCount') - cached);
        usage.output = count(u, 'candidatesTokenCount') + count(u, 'thoughtsTokenCount');
      }),
  };
}

function authorizeRequest(
  request: ToolRequest,
  grant: Grant,
  ctx: ToolRequestContext,
): AuthzDecision {
  const verb = request.method.toUpperCase();
  const [version, models, target, ...rest] = request.segments;
  if (!version || !VERSIONS.has(version) || models !== 'models' || rest.length > 0) {
    throw new Denied('Only /v1beta/models/… calls are supported');
  }
  checkQuery(request.search);
  if (verb === 'GET') {
    requirePermission(grant, LLM_PERM.MODELS_READ);
    return { allowed: true, permission: LLM_PERM.MODELS_READ };
  }
  const colon = target?.lastIndexOf(':') ?? -1;
  const method = target && colon > 0 ? target.slice(colon + 1) : '';
  if (verb !== 'POST' || !target || (!GENERATE.has(method) && method !== COUNT)) {
    throw new Denied(
      `${verb} /${request.segments.join('/')} is not covered by any gateway permission`,
    );
  }
  requirePermission(grant, LLM_PERM.INVOKE);
  const model = checkModel(grant, target.slice(0, colon));
  return generate(request, grant, ctx, model, method);
}

export function createGeminiProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  return {
    id: 'gemini',
    name: 'Gemini',
    kind: 'llm',
    sessionKeyHeaders: ['x-goog-api-key'],
    credentialHelp:
      'A Gemini API key (aistudio.google.com → API keys). Agents call Gemini through the gateway with their session key and never see this key.',
    credentialPlaceholder: 'AIza…',
    resourceHelp: MODEL_RESOURCE_HELP,
    permissions: LLM_PERMISSIONS,
    upstreamBaseUrl: API,
    example: {
      method: 'POST',
      path: '/v1beta/models/gemini-2.5-flash:generateContent',
      body: '{"contents":[{"parts":[{"text":"Hello"}]}]}',
      clientHint: 'e.g. GOOGLE_GEMINI_BASE_URL + GEMINI_API_KEY',
    },

    validateResource: validateModelPattern,

    async verifyCredential(secret) {
      const res = await fetchImpl(`${API}/v1beta/models?pageSize=1`, {
        headers: { 'x-goog-api-key': secret },
      });
      if (!res.ok) throw new Error(`Google rejected the API key (HTTP ${res.status})`);
      return { keyType: 'API key' };
    },

    authorize: (request, grant, ctx) => decide(() => authorizeRequest(request, grant, ctx)),

    upstreamHeaders(secret, incoming) {
      const headers = forwardHeaders(incoming, ['content-type', 'accept']);
      headers.set('x-goog-api-key', secret);
      return headers;
    },
  };
}
