/**
 * Credentials that must never reach the database or logs: gateway keys and the token formats of
 * the upstream tools and LLM providers. Matches keep a short prefix so entries stay readable.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(gw[sacm]_)[A-Za-z0-9_-]+/g,
  /\b(sk-ant-)[A-Za-z0-9_-]+/g,
  /\b(sk-(?:proj-)?)[A-Za-z0-9_-]{16,}/g,
  /\b(gh[pousr]_)[A-Za-z0-9]+/g,
  /\b(github_pat_)[A-Za-z0-9_]+/g,
  /\b(xox[abpr]-)[A-Za-z0-9-]+/g,
  /\b(AIza)[A-Za-z0-9_-]{20,}/g,
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((out, pattern) => out.replace(pattern, '$1[redacted]'), text);
}

/** Redacts every string inside a JSON-compatible value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redactDeep(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]: [string, unknown]) => [k, redactDeep(v)]),
    ) as T;
  }
  return value;
}
