import { isRecord } from '../json.js';
import type { LlmEndpoint, LlmEndpointApi, ToolProvider } from '../types.js';
import { MS_PER_SECOND } from '../../units.js';
import { createAnthropicProvider } from './anthropic.js';
import {
  decide,
  Denied,
  LLM_PERMISSIONS,
  MODEL_RESOURCE_HELP,
  validateModelPattern,
} from './common.js';
import { createOpenAIProvider } from './openai.js';

/**
 * A custom LLM endpoint (self-hosted vLLM / Ollama / LiteLLM, another vendor's compatible API…)
 * that speaks the OpenAI or the Anthropic chat API. Its URL and bearer token live in the template
 * grant, not in an account: the gateway checks requests with the rules of the API it speaks
 * (models, token budget, server-side tools) and forwards them with the endpoint's token.
 */

export const CUSTOM_LLM_TOOL = 'custom';
const NAME = 'Custom LLM';
const MODELS_TIMEOUT_SECONDS = 10;
/** Anthropic-style model lists are paginated (20 by default): ask for the largest page. */
const ANTHROPIC_MODELS_PAGE = 1000;
const ANTHROPIC_VERSION = '2023-06-01';
/** At most this many models are proposed in the launch form. */
export const MAX_ENDPOINT_MODELS = 500;

/** The official provider whose request rules an endpoint of this API follows. */
function dialect(api: LlmEndpointApi, fetchImpl: typeof fetch): ToolProvider {
  return api === 'anthropic' ? createAnthropicProvider(fetchImpl) : createOpenAIProvider(fetchImpl);
}

const EXAMPLES: Record<LlmEndpointApi, ToolProvider['example']> = {
  openai: {
    method: 'POST',
    path: '/v1/chat/completions',
    body: '{"model":"my-model","messages":[{"role":"user","content":"Hello"}]}',
    clientHint: 'e.g. OPENAI_BASE_URL (…/proxy/custom/v1) + OPENAI_API_KEY',
  },
  anthropic: {
    method: 'POST',
    path: '/v1/messages',
    body: '{"model":"my-model","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}',
    clientHint: 'e.g. ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN',
  },
};

export function createCustomLlmProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  const provider: ToolProvider = {
    id: CUSTOM_LLM_TOOL,
    name: NAME,
    kind: 'llm',
    // Anthropic-style clients send their key as `x-api-key`.
    sessionKeyHeaders: ['x-api-key'],
    credentialHelp:
      'Configured in each template: the endpoint URL, the chat API it speaks (OpenAI or Anthropic) and an optional bearer token.',
    credentialPlaceholder: '',
    resourceHelp: MODEL_RESOURCE_HELP,
    permissions: LLM_PERMISSIONS,
    upstreamBaseUrl: '',
    example: EXAMPLES.openai,

    validateResource: validateModelPattern,

    verifyCredential() {
      return Promise.reject(
        new Error('Custom LLM endpoints are set up in templates, not as accounts'),
      );
    },

    // Only reached without an endpoint, which a custom grant always has.
    authorize: () =>
      decide(() => {
        throw new Denied('This grant has no custom LLM endpoint');
      }),

    upstreamHeaders: () => new Headers(),

    bindEndpoint(endpoint: LlmEndpoint): ToolProvider {
      const rules = dialect(endpoint.api, fetchImpl);
      return {
        ...provider,
        upstreamBaseUrl: endpoint.url,
        example: EXAMPLES[endpoint.api],
        // No account secret: the official providers' subscription-token handling stays off.
        authorize: (request, grant, ctx) => rules.authorize(request, grant, { ...ctx, secret: '' }),
        upstreamHeaders(secret, incoming) {
          const headers = rules.upstreamHeaders('', incoming);
          headers.delete('x-api-key');
          headers.delete('authorization');
          if (secret) headers.set('authorization', `Bearer ${secret}`);
          return headers;
        },
      };
    },
  };
  return provider;
}

/** The model IDs of a `{ data: [{ id }] }` list (OpenAI and Anthropic shape), deduplicated. */
function modelIds(body: unknown): string[] {
  const data = isRecord(body) ? body.data : undefined;
  if (!Array.isArray(data)) throw new Error('The custom LLM endpoint did not return a model list');
  const ids = data.flatMap((m: unknown) =>
    isRecord(m) && typeof m.id === 'string' && validateModelPattern(m.id) === null ? [m.id] : [],
  );
  return [...new Set(ids)].slice(0, MAX_ENDPOINT_MODELS);
}

/**
 * The models an endpoint serves, from its `GET /v1/models` (with the endpoint's token), in the
 * endpoint's order. Throws with a message fit for the member when the list can't be read.
 */
export async function listEndpointModels(
  endpoint: LlmEndpoint,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const headers = new Headers({ accept: 'application/json', 'user-agent': 'local-gateway' });
  if (endpoint.token) headers.set('authorization', `Bearer ${endpoint.token}`);
  let url = `${endpoint.url}/v1/models`;
  if (endpoint.api === 'anthropic') {
    headers.set('anthropic-version', ANTHROPIC_VERSION);
    url += `?limit=${String(ANTHROPIC_MODELS_PAGE)}`;
  }
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(MODELS_TIMEOUT_SECONDS * MS_PER_SECOND),
    });
  } catch {
    throw new Error('The custom LLM endpoint could not be reached');
  }
  if (!res.ok) {
    throw new Error(
      `The custom LLM endpoint answered HTTP ${String(res.status)} when listing its models`,
    );
  }
  return modelIds(await res.json().catch(() => null));
}
