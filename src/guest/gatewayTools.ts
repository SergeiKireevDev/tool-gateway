/**
 * The gateway's third-party tools as agent tools: one generic HTTP tool per tool the session key
 * covers (LLM providers excluded), described from `GET /api/session`. Used by the MCP server and
 * by the pi extension.
 */

const MAX_RESULT_CHARS = 100_000;
const HTTP_ERROR = 400;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface SessionGrant {
  tool: string;
  kind: 'tool' | 'llm';
  name: string;
  permissions: string[];
  permissionDetails: { id: string; label: string; description: string }[];
  resources: string[];
  resourceHelp: string;
  proxyBaseUrl: string;
  example: { method: string; path: string; body?: string; clientHint: string } | null;
}

interface SessionInfo {
  expiresAt: string;
  grants: SessionGrant[];
}

export interface GatewayTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  baseUrl: string;
}

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

export interface GatewayEnv {
  gatewayUrl: string;
  sessionKey: string;
}

export function gatewayEnv(env: NodeJS.ProcessEnv = process.env): GatewayEnv {
  const gatewayUrl = env.GATEWAY_URL;
  const sessionKey = env.GATEWAY_SESSION_KEY;
  if (!gatewayUrl || !sessionKey)
    throw new Error('GATEWAY_URL and GATEWAY_SESSION_KEY must be set');
  return { gatewayUrl: gatewayUrl.replace(/\/+$/, ''), sessionKey };
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    method: { type: 'string', enum: METHODS, description: 'HTTP method' },
    path: {
      type: 'string',
      description:
        'API path relative to the tool’s API root, starting with /, e.g. /repos/o/r/issues',
    },
    query: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Query string parameters',
    },
    body: { description: 'JSON request body (object), for POST/PUT/PATCH' },
  },
  required: ['method', 'path'],
  additionalProperties: false,
};

function describe(g: SessionGrant): string {
  const perms = g.permissionDetails.map((p) => `- ${p.label} (${p.id}): ${p.description}`);
  const scope =
    g.resources.length === 0
      ? 'Not limited to specific resources.'
      : `Only these resources: ${g.resources.join(', ')} (${g.resourceHelp})`;
  const exampleBody = g.example?.body ? ` with body ${g.example.body}` : '';
  const example = g.example ? `Example: ${g.example.method} ${g.example.path}${exampleBody}` : '';
  return [
    `Call the ${g.name} API through the gateway (API root ${g.proxyBaseUrl}). The gateway adds the credentials and refuses anything this run is not allowed to do (HTTP 403 with a reason: don't retry it).`,
    'Allowed:',
    ...perms,
    scope,
    example,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function loadGatewayTools(
  env: GatewayEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayTool[]> {
  const res = await fetchImpl(`${env.gatewayUrl}/api/session`, {
    headers: { authorization: `Bearer ${env.sessionKey}` },
  });
  if (!res.ok) throw new Error(`Gateway session lookup failed: HTTP ${res.status}`);
  const info = (await res.json()) as SessionInfo;
  return info.grants
    .filter((g) => g.kind !== 'llm')
    .map((g) => ({
      name: `gateway_${g.tool}`,
      description: describe(g),
      inputSchema: INPUT_SCHEMA,
      baseUrl: g.proxyBaseUrl,
    }));
}

interface CallArgs {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

function parseArgs(args: unknown): CallArgs {
  if (typeof args !== 'object' || args === null) throw new Error('Arguments must be an object');
  const { method, path, query, body } = args as Record<string, unknown>;
  if (
    typeof method !== 'string' ||
    !(METHODS as readonly string[]).includes(method.toUpperCase())
  ) {
    throw new Error(`method must be one of ${METHODS.join(', ')}`);
  }
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('path must start with /');
  const out: CallArgs = { method: method.toUpperCase(), path };
  if (query !== undefined) {
    if (typeof query !== 'object' || query === null) throw new Error('query must be an object');
    out.query = query as Record<string, unknown>;
  }
  if (body !== undefined) out.body = body;
  return out;
}

export async function callGatewayTool(
  tool: GatewayTool,
  rawArgs: unknown,
  env: GatewayEnv,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ToolCallResult> {
  let args: CallArgs;
  try {
    args = parseArgs(rawArgs);
  } catch (err) {
    return { text: (err as Error).message, isError: true };
  }
  const search = args.query
    ? `?${new URLSearchParams(Object.entries(args.query).map(([k, v]) => [k, String(v)])).toString()}`
    : '';
  const hasBody = args.body !== undefined && args.method !== 'GET';
  const init: RequestInit = {
    method: args.method,
    headers: {
      authorization: `Bearer ${env.sessionKey}`,
      accept: 'application/json',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
    },
    ...(hasBody
      ? { body: typeof args.body === 'string' ? args.body : JSON.stringify(args.body) }
      : {}),
    ...(signal ? { signal } : {}),
  };
  try {
    const res = await fetchImpl(`${tool.baseUrl}${args.path}${search}`, init);
    const text = await res.text();
    const denied = res.headers.get('x-gateway-denied') === 'true' ? ' (denied by the gateway)' : '';
    const clipped =
      text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…[truncated]` : text;
    return { text: `HTTP ${res.status}${denied}\n${clipped}`, isError: res.status >= HTTP_ERROR };
  } catch (err) {
    return { text: `Request failed: ${(err as Error).message}`, isError: true };
  }
}
