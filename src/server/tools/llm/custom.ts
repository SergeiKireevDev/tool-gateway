import type { LlmEndpoint, LlmEndpointApi, ToolProvider } from '../types.js';
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
