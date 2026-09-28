import type { Request } from 'express';

export function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  // `token X` is what the gh CLI / older Octokit send; accept it alongside `Bearer X`.
  const match = /^(?:bearer|token)\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
