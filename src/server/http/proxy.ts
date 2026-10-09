import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import express, { type Request, type RequestHandler, type Response } from 'express';
import type { GatewayConfig } from '../config.js';
import { badGateway, unauthorized } from '../errors.js';
import { SESSION_KEY_PREFIX, type Gateway } from '../gateway.js';
import { HTTP } from '../httpStatus.js';
import { parseSafePath } from '../tools/pathMatch.js';
import { BYTES_PER_MIB } from '../units.js';
import type { AuthzAllowed, ToolProvider, ToolRequest } from '../tools/types.js';
import { proxyToken } from './auth.js';

/** Response headers never forwarded to the client. */
const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding', // fetch already decoded the body
  'content-length',
  'set-cookie',
  'strict-transport-security',
]);

/** Upstream statuses meaning the gateway's credential was refused. */
const UPSTREAM_AUTH_ERRORS = new Set<number>([HTTP.UNAUTHORIZED, HTTP.FORBIDDEN]);

const rawBody = express.raw({ type: () => true, limit: '50mb' });
/** Largest upstream response a tool may inspect (it is buffered instead of streamed). */
const MAX_OBSERVED_RESPONSE_MIB = 50;
const MAX_OBSERVED_RESPONSE_BYTES = MAX_OBSERVED_RESPONSE_MIB * BYTES_PER_MIB;

export function proxyHandler(
  gateway: Gateway,
  config: GatewayConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): RequestHandler {
  return (req, res, next) => {
    rawBody(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      forward(gateway, config, fetchImpl, req, res).catch(next);
    });
  };
}

async function forward(
  gateway: Gateway,
  config: GatewayConfig,
  fetchImpl: typeof fetch,
  req: Request,
  res: Response,
): Promise<void> {
  const toolId = String(req.params.tool);
  const prefix = `/proxy/${toolId}`;
  // Work on the raw URL: `new URL()` would resolve `..` / `%2e%2e` before we get to validate it.
  const match = /^\/proxy\/[^/?#]+(\/[^?#]*)?(\?[^#]*)?$/i.exec(req.originalUrl);
  const rawPath = match?.[1] ?? '/';
  const search = match?.[2] ?? '';

  const key = proxyToken(req) ?? altKeyHeader(req, gateway.tools.get(toolId)?.sessionKeyHeaders);
  if (!key) {
    // Lets clients that wait for a challenge (git) retry with their credentials.
    res.set('www-authenticate', 'Basic realm="gateway"');
    throw unauthorized('Missing session key (Authorization: Bearer gws_…)');
  }
  const session = gateway.resolveSession(key);

  const log = (decision: 'allowed' | 'denied', status: number, detail: string): void => {
    gateway.activity.add({
      kind: 'proxy',
      sessionId: session.id,
      sessionLabel: session.label,
      tool: toolId,
      method: req.method,
      path: rawPath,
      status,
      decision,
      detail,
    });
  };

  const deny = (status: number, message: string): void => {
    log('denied', status, message);
    res.status(status).set('x-gateway-denied', 'true').json({ error: 'forbidden', message });
  };

  const resolved = gateway.resolveGrant(session, toolId);
  if (!resolved) {
    const covered = session.grants.map((g) => `"${g.tool}"`).join(', ');
    deny(HTTP.FORBIDDEN, `This session key is for ${covered}, not "${toolId}"`);
    return;
  }
  const { grant, tool } = resolved;
  const account = await gateway.freshAccount(resolved.account);
  const segments = match ? parseSafePath(rawPath) : null;
  if (!segments) {
    deny(HTTP.BAD_REQUEST, 'Malformed request path');
    return;
  }
  const toolRequest = toolRequestOf(req, segments, search);
  const decision = await tool.authorize(toolRequest, grant, {
    sessionId: session.id,
    secret: account.secret,
    tokensRemaining: gateway.tokensRemaining(session),
  });
  if (!decision.allowed) {
    deny(HTTP.FORBIDDEN, decision.reason);
    return;
  }

  gateway.recordUsage(session.id);
  const upstream = await fetchUpstream(
    fetchImpl,
    res,
    { tool, secret: account.secret, rawPath, request: toolRequest, decision },
    (message) => {
      log('allowed', HTTP.BAD_GATEWAY, `Upstream error: ${message}`);
    },
  );

  log(
    'allowed',
    upstream.status,
    decision.detail ? `${decision.permission} · ${decision.detail}` : decision.permission,
  );
  if (await refusedCredential(tool, upstream, res)) return;
  const response = decision.transformResponse
    ? await decision.transformResponse(upstream)
    : upstream;
  await relay(response, req, res, {
    rewriteHeader: (name, value) =>
      tool.rewriteResponseHeader?.(name, value, `${config.publicUrl}${prefix}`) ?? value,
    observe: decision.observeResponse,
    meter: usageMeter(gateway, session.id, tool.id, decision, response),
  });
}

interface AuthorizedUpstreamRequest {
  tool: ToolProvider;
  secret: string;
  rawPath: string;
  request: ToolRequest;
  decision: AuthzAllowed;
}

/** Sends the authorized request with canonical overrides, cancelling it if the client closes. */
async function fetchUpstream(
  fetchImpl: typeof fetch,
  res: Response,
  { tool, secret, rawPath, request, decision }: AuthorizedUpstreamRequest,
  logError: (message: string) => void,
): Promise<globalThis.Response> {
  const body = decision.body ?? request.body;
  const controller = new AbortController();
  res.on('close', () => {
    controller.abort();
  });

  try {
    const target = upstreamTarget(tool, decision, rawPath, request.search);
    return await fetchImpl(target.url, {
      method: decision.method ?? request.method,
      headers: target.headers(secret, request.headers),
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    const message = (err as Error).message;
    logError(message);
    throw badGateway(`Upstream request failed: ${message}`);
  }
}

/** Where an allowed request goes upstream, and with which headers (tools may override both). */
function upstreamTarget(
  tool: ToolProvider,
  decision: AuthzAllowed,
  rawPath: string,
  search: string,
): { url: string; headers: (secret: string, incoming: Headers) => Headers } {
  return {
    url: decision.upstreamUrl ?? `${tool.upstreamBaseUrl}${rawPath}${decision.search ?? search}`,
    headers: decision.upstreamHeaders ?? tool.upstreamHeaders.bind(tool),
  };
}

/** Records the LLM tokens a response used, also for aborted streams (they are spent too). */
function usageMeter(
  gateway: Gateway,
  sessionId: string,
  toolId: string,
  decision: AuthzAllowed,
  upstream: globalThis.Response,
): { write: (chunk: Uint8Array) => void; end: () => void } | undefined {
  const meter = decision.meter?.(upstream.headers.get('content-type') ?? '');
  if (!meter) return undefined;
  return {
    write: (chunk) => {
      meter.write(chunk);
    },
    end: () => {
      const usage = meter.end();
      if (usage) gateway.llmUsage.record(sessionId, toolId, usage);
    },
  };
}

/**
 * An LLM provider's auth error is about the gateway's own credential (and can echo part of it):
 * answer with the gateway's explanation instead. Returns whether it answered.
 */
async function refusedCredential(
  tool: ToolProvider,
  upstream: globalThis.Response,
  res: Response,
): Promise<boolean> {
  if (tool.kind !== 'llm' || !UPSTREAM_AUTH_ERRORS.has(upstream.status)) return false;
  await upstream.body?.cancel();
  res
    .status(HTTP.BAD_GATEWAY)
    .set('x-gateway-upstream-auth', 'failed')
    .json({
      error: 'upstream_auth',
      message: `${tool.name} rejected the gateway's ${tool.name} account (HTTP ${upstream.status}). Ask the gateway admin to check or reconnect it.`,
    });
  return true;
}

/** A session key sent the way the tool's own clients send their API key (e.g. `x-api-key`). */
function altKeyHeader(req: Request, headers: readonly string[] | undefined): string | null {
  for (const name of headers ?? []) {
    const value = req.get(name)?.trim();
    if (value?.startsWith(SESSION_KEY_PREFIX)) return value;
  }
  return null;
}

function toolRequestOf(req: Request, segments: string[], search: string): ToolRequest {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;
  return { method: req.method, segments, search, headers, body };
}

/** Sends the upstream response to the client: streamed, or buffered when the tool observes it. */
async function relay(
  upstream: globalThis.Response,
  req: Request,
  res: Response,
  opts: {
    rewriteHeader: (name: string, value: string) => string;
    observe: AuthzAllowed['observeResponse'];
    meter: { write: (chunk: Uint8Array) => void; end: () => void } | undefined;
  },
): Promise<void> {
  res.status(upstream.status);
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE_HEADERS.has(name)) res.setHeader(name, opts.rewriteHeader(name, value));
  });
  if (!upstream.body || req.method === 'HEAD') {
    opts.meter?.end();
    res.end();
    return;
  }
  if (opts.observe) {
    res.end(await observed(upstream, opts.observe));
    return;
  }
  const body = Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>);
  const { meter } = opts;
  if (meter) {
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      meter.end();
    };
    body.on('data', (chunk: Uint8Array) => {
      meter.write(chunk);
    });
    body.on('end', finish);
    body.on('close', finish);
  }
  body.on('error', () => res.destroy()).pipe(res);
}

/** Buffers a response so the tool can inspect it, then returns the bytes to forward unchanged. */
async function observed(
  upstream: globalThis.Response,
  observe: NonNullable<AuthzAllowed['observeResponse']>,
): Promise<Buffer> {
  const bytes = Buffer.from(await upstream.arrayBuffer());
  const isJson = upstream.headers.get('content-type')?.includes('json') ?? false;
  if (upstream.ok && isJson && bytes.length <= MAX_OBSERVED_RESPONSE_BYTES) {
    try {
      observe(JSON.parse(bytes.toString('utf8')));
    } catch {
      // Not JSON after all: nothing to observe, forward as-is.
    }
  }
  return bytes;
}
