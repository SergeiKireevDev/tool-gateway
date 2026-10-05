import { isRecord } from '../json.js';
import type { AuthzDecision, Grant, TokenUsage, ToolRequest, UsageMeter } from '../types.js';
import { BYTES_PER_MIB } from '../../units.js';

/** Shared rules of the LLM providers (Anthropic, OpenAI, Gemini). */

export const LLM_PERM = {
  INVOKE: 'llm:invoke',
  MODELS_READ: 'models:read',
  SERVER_TOOLS: 'llm:server-tools',
} as const;

export const LLM_PERMISSIONS = [
  {
    id: LLM_PERM.INVOKE,
    label: 'Generate',
    description:
      'Call the model (messages, responses, completions, token counting). Limited to the model allowlist and to the key’s token budget.',
  },
  {
    id: LLM_PERM.MODELS_READ,
    label: 'Models (list)',
    description: 'List the models the API key can use.',
  },
  {
    id: LLM_PERM.SERVER_TOOLS,
    label: 'Server-side tools',
    description:
      'Let requests enable tools the provider runs itself (web search/fetch, code execution, remote MCP servers…). These reach the internet from the provider: without this permission an agent can’t use them to get around its network lockdown.',
  },
] as const;

export const MODEL_RESOURCE_HELP =
  'One model per line; `*` matches any characters (e.g. claude-sonnet-*). Leave empty to allow every model.';

const MODEL_PATTERN = /^[A-Za-z0-9._:@/*-]{1,100}$/;

export function validateModelPattern(pattern: string): string | null {
  return MODEL_PATTERN.test(pattern) ? null : `Invalid model pattern "${pattern}"`;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** Whether the grant's model allowlist (empty = any model) covers `model`. */
export function modelAllowed(grant: Grant, model: string): boolean {
  return grant.resources.length === 0 || grant.resources.some((p) => globToRegExp(p).test(model));
}

export class Denied extends Error {}

/** Runs a provider's checks; `Denied` becomes a denial, anything else propagates. */
export function decide(check: () => AuthzDecision): AuthzDecision {
  try {
    return check();
  } catch (err) {
    if (err instanceof Denied) return { allowed: false, reason: err.message };
    throw err;
  }
}

export function requirePermission(grant: Grant, permission: string): void {
  if (!grant.permissions.includes(permission)) {
    throw new Denied(`Missing permission "${permission}"`);
  }
}

/** The JSON object body of a request; anything else is denied. */
export function jsonBody(request: ToolRequest): Record<string, unknown> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new Denied('Send a JSON body (application/json)');
  if (!request.body) throw new Denied('Missing request body');
  let json: unknown;
  try {
    json = JSON.parse(request.body.toString('utf8'));
  } catch {
    throw new Denied('The body is not valid JSON');
  }
  if (!isRecord(json)) throw new Denied('The body must be a JSON object');
  return json;
}

export function checkModel(grant: Grant, model: unknown): string {
  if (typeof model !== 'string' || model === '') throw new Denied('Missing "model"');
  if (!modelAllowed(grant, model)) throw new Denied(`Model "${model}" is not in the allowlist`);
  return model;
}

/**
 * Caps an output-token limit to what is left of the token budget. Returns the limit to send, or
 * undefined to leave the request as is (no budget, or already under it).
 */
export function cappedLimit(current: unknown, remaining: number | null): number | undefined {
  if (remaining === null) return undefined;
  if (remaining <= 0) throw new Denied('The token budget of this session key is spent');
  if (typeof current === 'number' && current <= remaining) return undefined;
  return remaining;
}

/** Fails fast when a budgeted key is already spent (calls with no output limit to cap). */
export function checkBudget(remaining: number | null): void {
  if (remaining !== null && remaining <= 0) {
    throw new Denied('The token budget of this session key is spent');
  }
}

/** Re-serialized body: the upstream reads exactly the JSON the gateway checked. */
export function canonical(json: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(json));
}

/** A non-negative integer field of a usage object, or 0. */
export function count(obj: unknown, key: string): number {
  if (!isRecord(obj)) return 0;
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export const emptyUsage = (model: string): TokenUsage => ({
  model,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export const totalTokens = (u: TokenUsage): number =>
  u.input + u.output + u.cacheRead + u.cacheWrite;

/** Largest JSON (non-streamed) response the meter buffers to read its usage. */
const MAX_METERED_JSON_MIB = 20;
const MAX_METERED_JSON_BYTES = MAX_METERED_JSON_MIB * BYTES_PER_MIB;

/**
 * Meter for SSE and JSON responses: hands every parsed event (or the JSON document, or each
 * element of a JSON array) to `onEvent`, which folds usage into the running total.
 */
export function eventMeter(
  contentType: string,
  model: string,
  onEvent: (event: unknown, usage: TokenUsage) => void,
): UsageMeter {
  const usage = emptyUsage(model);
  let seen = false;
  const handle = (event: unknown): void => {
    seen = true;
    onEvent(event, usage);
  };
  const decoder = new TextDecoder();
  if (contentType.includes('text/event-stream')) {
    let pending = '';
    const lines = (text: string): void => {
      pending += text;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.startsWith('data:')) continue;
        try {
          handle(JSON.parse(line.slice('data:'.length)));
        } catch {
          // `[DONE]` markers and partial garbage carry no usage.
        }
      }
    };
    return {
      write: (chunk) => {
        lines(decoder.decode(chunk, { stream: true }));
      },
      end: () => {
        lines(`${decoder.decode()}\n`);
        return seen ? usage : null;
      },
    };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  return {
    write: (chunk) => {
      size += chunk.byteLength;
      if (size <= MAX_METERED_JSON_BYTES) chunks.push(chunk);
    },
    end: () => {
      if (size > MAX_METERED_JSON_BYTES || !contentType.includes('json')) return null;
      try {
        const json: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        for (const event of Array.isArray(json) ? json : [json]) handle(event);
      } catch {
        return null;
      }
      return seen ? usage : null;
    },
  };
}

/** Only these request headers reach an LLM upstream (besides the injected credential). */
export function forwardHeaders(incoming: Headers, names: readonly string[]): Headers {
  const out = new Headers({ 'user-agent': 'local-gateway' });
  for (const name of names) {
    const value = incoming.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}
