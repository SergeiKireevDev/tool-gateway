import { isRecord } from '../json.js';
import { matchPath } from '../pathMatch.js';
import type {
  AuthzDecision,
  Grant,
  OAuthSignIn,
  OAuthTokens,
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

// "Sign in with Claude" (Claude Pro/Max subscriptions): the OAuth client Claude Code uses.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_REDIRECT_URI = 'http://localhost:53692/callback';
const OAUTH_SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
/** Subscription tokens are only accepted for requests that identify as Claude Code. */
const OAUTH_TOKEN_MARK = 'sk-ant-oat';
const OAUTH_BETAS = ['claude-code-20250219', 'oauth-2025-04-20'];
const CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.289 (external, cli)';
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const BETA_HEADER = 'anthropic-beta';

const isOAuthToken = (secret: string): boolean => secret.includes(OAUTH_TOKEN_MARK);
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

/**
 * Subscription (OAuth) tokens need the Claude Code identity as the first system block. Claude
 * Code sends it itself; other clients (pi, scripts) get it added in front of their own prompt.
 */
function ensureClaudeCodeIdentity(body: Record<string, unknown>): void {
  const identity = { type: 'text', text: CLAUDE_CODE_IDENTITY };
  const { system } = body;
  if (typeof system === 'string') {
    if (!system.startsWith(CLAUDE_CODE_IDENTITY))
      body.system = [identity, { type: 'text', text: system }];
    return;
  }
  const blocks = Array.isArray(system) ? (system as unknown[]) : [];
  // Claude Code may lead with other blocks (e.g. a billing header) before its identity.
  const hasIdentity = blocks.some(
    (b) => isRecord(b) && typeof b.text === 'string' && b.text.startsWith(CLAUDE_CODE_IDENTITY),
  );
  if (hasIdentity) return;
  body.system = [identity, ...blocks];
}

function messages(request: ToolRequest, grant: Grant, ctx: ToolRequestContext): AuthzDecision {
  requirePermission(grant, LLM_PERM.INVOKE);
  const body = jsonBody(request);
  const model = checkModel(grant, body.model);
  checkServerTools(body, grant);
  capTokens(body, ctx.tokensRemaining);
  if (isOAuthToken(ctx.secret)) ensureClaudeCodeIdentity(body);
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

    oauthSignIn: claudeSignIn(fetchImpl),

    async verifyCredential(secret) {
      if (isOAuthToken(secret)) return { keyType: 'Claude subscription (pasted OAuth token)' };
      const res = await fetchImpl(`${API}/v1/models?limit=1`, {
        headers: { 'x-api-key': secret, 'anthropic-version': DEFAULT_VERSION },
      });
      if (!res.ok) throw new Error(`Anthropic rejected the API key (HTTP ${res.status})`);
      return { keyType: 'API key' };
    },

    authorize: (request, grant, ctx) => decide(() => authorizeRequest(request, grant, ctx)),

    upstreamHeaders(secret, incoming) {
      const headers = forwardHeaders(incoming, [BETA_HEADER, 'content-type', 'accept']);
      headers.set('anthropic-version', incoming.get('anthropic-version') ?? DEFAULT_VERSION);
      if (!isOAuthToken(secret)) {
        headers.set('x-api-key', secret);
        return headers;
      }
      // Subscription token: sent the way Claude Code sends it.
      const betas = new Set([
        ...OAUTH_BETAS,
        ...(incoming.get(BETA_HEADER) ?? '')
          .split(',')
          .map((b) => b.trim())
          .filter(Boolean),
      ]);
      headers.set('authorization', `Bearer ${secret}`);
      headers.set(BETA_HEADER, [...betas].join(','));
      headers.set('user-agent', CLAUDE_CODE_USER_AGENT);
      headers.set('x-app', 'cli');
      return headers;
    },
  };
}

/** Tokens from Anthropic's OAuth token endpoint. */
function tokensOf(json: unknown): OAuthTokens {
  if (
    !isRecord(json) ||
    typeof json.access_token !== 'string' ||
    typeof json.refresh_token !== 'string'
  ) {
    throw new Error('Unexpected answer from Claude sign-in');
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 0;
  const identity: Record<string, string> = { keyType: 'Claude subscription (sign-in)' };
  if (isRecord(json.account) && typeof json.account.email_address === 'string') {
    identity.login = json.account.email_address;
  }
  if (isRecord(json.organization) && typeof json.organization.name === 'string') {
    identity.organization = json.organization.name;
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expiresInSeconds: expiresIn,
    identity,
  };
}

function claudeSignIn(fetchImpl: typeof fetch): OAuthSignIn {
  const token = async (body: Record<string, string>): Promise<OAuthTokens> => {
    const res = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, ...body }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error =
        isRecord(json) && typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
      throw new Error(`Claude sign-in failed (${error})`);
    }
    return tokensOf(json);
  };
  return {
    help: 'Opens claude.ai to sign in with your Claude subscription. After approving, your browser lands on a localhost page that does not load: copy that page’s full address and paste it here.',
    authorizeUrl(challenge, state) {
      const params = new URLSearchParams({
        code: 'true',
        client_id: OAUTH_CLIENT_ID,
        response_type: 'code',
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: OAUTH_SCOPES,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      });
      return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
    },
    exchange: (code, state, verifier) =>
      token({
        grant_type: 'authorization_code',
        code,
        state,
        redirect_uri: OAUTH_REDIRECT_URI,
        code_verifier: verifier,
      }),
    refresh: (refreshToken) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}
