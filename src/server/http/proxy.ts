import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import express, { type Request, type RequestHandler, type Response } from 'express';
import type { GatewayConfig } from '../config.js';
import { badGateway, unauthorized } from '../errors.js';
import type { Gateway } from '../gateway.js';
import { HTTP } from '../httpStatus.js';
import { parseSafePath } from '../tools/pathMatch.js';
import { BYTES_PER_MIB } from '../units.js';
import type { AuthzAllowed, ToolRequest } from '../tools/types.js';
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

  const key = proxyToken(req);
  if (!key) throw unauthorized('Missing session key (Authorization: Bearer gws_…)');
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
  const { grant, account, tool } = resolved;
  const segments = match ? parseSafePath(rawPath) : null;
  if (!segments) {
    deny(HTTP.BAD_REQUEST, 'Malformed request path');
    return;
  }
  const toolRequest = toolRequestOf(req, segments, search);
  const decision = await tool.authorize(toolRequest, grant, {
    sessionId: session.id,
    secret: account.secret,
  });
  if (!decision.allowed) {
    deny(HTTP.FORBIDDEN, decision.reason);
    return;
  }

  gateway.recordUsage(session.id);
  const body = decision.body ?? toolRequest.body;
  const controller = new AbortController();
  res.on('close', () => {
    controller.abort();
  });

  let upstream: globalThis.Response;
  try {
    upstream = await fetchImpl(`${tool.upstreamBaseUrl}${rawPath}${decision.search ?? search}`, {
      method: decision.method ?? req.method,
      headers: tool.upstreamHeaders(account.secret, toolRequest.headers),
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    log('allowed', HTTP.BAD_GATEWAY, `Upstream error: ${(err as Error).message}`);
    throw badGateway(`Upstream request failed: ${(err as Error).message}`);
  }

  log(
    'allowed',
    upstream.status,
    decision.detail ? `${decision.permission} · ${decision.detail}` : decision.permission,
  );
  await relay(upstream, req, res, {
    rewriteHeader: (name, value) =>
      tool.rewriteResponseHeader?.(name, value, `${config.publicUrl}${prefix}`) ?? value,
    observe: decision.observeResponse,
  });
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
  },
): Promise<void> {
  res.status(upstream.status);
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE_HEADERS.has(name)) res.setHeader(name, opts.rewriteHeader(name, value));
  });
  if (!upstream.body || req.method === 'HEAD') {
    res.end();
    return;
  }
  if (opts.observe) {
    res.end(await observed(upstream, opts.observe));
    return;
  }
  Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>)
    .on('error', () => res.destroy())
    .pipe(res);
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
