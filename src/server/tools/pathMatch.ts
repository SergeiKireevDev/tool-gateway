/**
 * Minimal path pattern matcher.
 *  - `:name` captures exactly one segment
 *  - `*` matches exactly one segment
 *  - `**` (last position only) matches zero or more remaining segments
 */
export function matchPath(
  pattern: string,
  segments: readonly string[],
): Record<string, string> | null {
  const parts = pattern.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (const [i, part] of parts.entries()) {
    if (part === '**') return i === parts.length - 1 ? params : null;
    const seg = segments[i];
    if (seg === undefined) return null;
    if (part.startsWith(':')) params[part.slice(1)] = seg;
    else if (part !== '*' && part !== seg) return null;
  }
  return parts.length === segments.length ? params : null;
}

/**
 * Splits a raw URL path into decoded segments, rejecting anything that could
 * be interpreted differently by the upstream (dot segments, encoded slashes, empty segments).
 */
export function parseSafePath(rawPath: string): string[] | null {
  if (!rawPath.startsWith('/')) return null;
  const rawSegments = rawPath.slice(1).split('/');
  if (rawSegments.length === 1 && rawSegments[0] === '') return [];
  const out: string[] = [];
  for (const raw of rawSegments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === '' || seg === '.' || seg === '..' || /[/\\\0]/.test(seg)) return null;
    out.push(seg);
  }
  return out;
}
