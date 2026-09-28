import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import express, { type Request, type RequestHandler, type Response } from 'express';
import type { GatewayConfig } from '../config.js';
import { HttpError } from '../errors.js';
import type { Gateway } from '../gateway.js';
import { parseSafePath } from '../tools/pathMatch.js';
import { bearerToken } from './auth.js';

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

  const key = bearerToken(req);
  if (!key) throw new HttpError(401, 'Missing session key (Authorization: Bearer gws_…)');
  const { session, account, tool } = gateway.resolveSession(key);

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

  if (session.tool !== toolId) {
    deny(403, `This session key is for "${session.tool}", not "${toolId}"`);
    return;
  }
  const segments = match ? parseSafePath(rawPath) : null;
  if (!segments) {
    deny(400, 'Malformed request path');
    return;
  }
  const decision = tool.authorize(req.method, segments, session);
  if (!decision.allowed) {
    deny(403, decision.reason);
    return;
  }

  gateway.recordUsage(session.id);
  const incoming = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') incoming.set(name, value);
  }
  const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;
  const controller = new AbortController();
  res.on('close', () => {
    controller.abort();
  });

  let upstream: globalThis.Response;
  try {
    upstream = await fetchImpl(`${tool.upstreamBaseUrl}${rawPath}${search}`, {
      method: req.method,
      headers: tool.upstreamHeaders(account.secret, incoming),
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err) {
    log('allowed', 502, `Upstream error: ${(err as Error).message}`);
    throw new HttpError(502, `Upstream request failed: ${(err as Error).message}`);
  }

  log('allowed', upstream.status, decision.permission);
  res.status(upstream.status);
  const proxyBase = `${config.publicUrl}${prefix}`;
  upstream.headers.forEach((value, name) => {
    if (DROP_RESPONSE_HEADERS.has(name)) return;
    res.setHeader(name, tool.rewriteResponseHeader?.(name, value, proxyBase) ?? value);
  });
  if (!upstream.body || req.method === 'HEAD') {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>)
    .on('error', () => res.destroy())
    .pipe(res);
}
