import type { Request } from 'express';
import { SESSION_KEY_PREFIX } from '../gateway.js';

export function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  // `token X` is what the gh CLI / older Octokit send; accept it alongside `Bearer X`.
  const match = /^(?:bearer|token)\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Session key presented to the proxy. Besides `Bearer`/`token`, accepts a bare key: some APIs
 * (monday.com) put the raw token in `Authorization`, and their SDKs do the same.
 */
export function proxyToken(req: Request): string | null {
  const bearer = bearerToken(req);
  if (bearer) return bearer;
  const header = req.get('authorization')?.trim();
  return header?.startsWith(SESSION_KEY_PREFIX) && !/\s/.test(header) ? header : null;
}
