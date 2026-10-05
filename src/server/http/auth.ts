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
 * (monday.com) put the raw token in `Authorization`, and their SDKs do the same. git sends it with
 * HTTP Basic auth, as the password (or the user name).
 */
export function proxyToken(req: Request): string | null {
  const bearer = bearerToken(req);
  if (bearer) return bearer;
  const header = req.get('authorization')?.trim();
  if (!header) return null;
  const basic = /^basic\s+(\S+)$/i.exec(header);
  if (basic?.[1]) return basicAuthKey(basic[1]);
  return header.startsWith(SESSION_KEY_PREFIX) && !/\s/.test(header) ? header : null;
}

function basicAuthKey(encoded: string): string | null {
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const user = colon < 0 ? decoded : decoded.slice(0, colon);
  const password = colon < 0 ? '' : decoded.slice(colon + 1);
  if (password.startsWith(SESSION_KEY_PREFIX)) return password;
  return user.startsWith(SESSION_KEY_PREFIX) ? user : null;
}
