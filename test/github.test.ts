import { describe, expect, it } from 'vitest';
import { createGitHubProvider } from '../src/server/tools/github.js';
import { parseSafePath } from '../src/server/tools/pathMatch.js';

const gh = createGitHubProvider(() => Promise.reject(new Error('no network')));

const check = (
  method: string,
  path: string,
  permissions: string[],
  resources: string[] = [],
): boolean => {
  const segments = parseSafePath(path);
  if (!segments) return false;
  return gh.authorize(method, segments, { permissions, resources }).allowed;
};

describe('GitHub authorization', () => {
  it('maps read endpoints to read permissions', () => {
    expect(check('GET', '/repos/o/r/issues', ['issues:read'])).toBe(true);
    expect(check('GET', '/repos/o/r/issues/12/comments', ['issues:read'])).toBe(true);
    expect(check('GET', '/repos/o/r/contents/src/index.ts', ['contents:read'])).toBe(true);
    expect(check('GET', '/repos/o/r/pulls/3/files', ['pulls:read'])).toBe(true);
    expect(check('GET', '/repos/o/r', ['metadata:read'])).toBe(true);
  });

  it('requires write permissions for mutations', () => {
    expect(check('POST', '/repos/o/r/issues', ['issues:read'])).toBe(false);
    expect(check('POST', '/repos/o/r/issues', ['issues:write'])).toBe(true);
    expect(check('PUT', '/repos/o/r/contents/a.txt', ['contents:read'])).toBe(false);
    expect(check('PUT', '/repos/o/r/contents/a.txt', ['contents:write'])).toBe(true);
    expect(check('PUT', '/repos/o/r/pulls/1/merge', ['pulls:write'])).toBe(true);
  });

  it('does not let a write permission imply read', () => {
    expect(check('GET', '/repos/o/r/issues', ['issues:write'])).toBe(false);
  });

  it('enforces the repository allowlist case-insensitively', () => {
    expect(check('GET', '/repos/Org/Repo/issues', ['issues:read'], ['org/repo'])).toBe(true);
    expect(check('GET', '/repos/org/other/issues', ['issues:read'], ['org/repo'])).toBe(false);
    expect(check('GET', '/repos/org/other/issues', ['issues:read'], ['org/*'])).toBe(true);
    expect(check('GET', '/repos/evil/repo/issues', ['issues:read'], ['org/*'])).toBe(false);
  });

  it('denies sensitive and unmapped endpoints', () => {
    const all = gh.permissions.map((p) => p.id);
    expect(check('GET', '/repos/o/r/actions/secrets', all)).toBe(false);
    expect(check('PUT', '/repos/o/r/actions/secrets/X', all)).toBe(false);
    expect(check('POST', '/graphql', all)).toBe(false);
    expect(check('DELETE', '/repos/o/r', all)).toBe(false);
    expect(check('PATCH', '/repos/o/r', all)).toBe(false);
    expect(check('GET', '/repos/o/r/hooks', all)).toBe(false);
    expect(check('POST', '/user/repos', all)).toBe(false);
  });

  it('only allows workflow triggering, not arbitrary actions writes', () => {
    expect(check('POST', '/repos/o/r/actions/workflows/ci.yml/dispatches', ['actions:write'])).toBe(
      true,
    );
    expect(check('POST', '/repos/o/r/actions/runs/1/cancel', ['actions:write'])).toBe(true);
    expect(check('DELETE', '/repos/o/r/actions/runs/1', ['actions:write'])).toBe(false);
  });

  it('always allows rate limit checks', () => {
    expect(check('GET', '/rate_limit', [])).toBe(true);
  });

  it('explains denials', () => {
    const segs = parseSafePath('/repos/o/r/issues') ?? [];
    expect(gh.authorize('GET', segs, { permissions: [], resources: [] })).toEqual({
      allowed: false,
      reason: 'Missing permission "issues:read"',
    });
    expect(gh.authorize('GET', segs, { permissions: ['issues:read'], resources: ['x/y'] })).toEqual(
      { allowed: false, reason: 'Repository is not in the allowlist' },
    );
  });

  it('validates resource patterns', () => {
    expect(gh.validateResource('octo-org/*')).toBeNull();
    expect(gh.validateResource('octo-org/my.repo_1')).toBeNull();
    expect(gh.validateResource('*/*')).not.toBeNull();
    expect(gh.validateResource('octo-org')).not.toBeNull();
    expect(gh.validateResource('a/b/c')).not.toBeNull();
  });
});

describe('parseSafePath', () => {
  it('rejects traversal and ambiguous encodings', () => {
    expect(parseSafePath('/repos/o/r/../../user')).toBeNull();
    expect(parseSafePath('/repos/o/r/%2e%2e/x')).toBeNull();
    expect(parseSafePath('/repos/o%2Fr/issues')).toBeNull();
    expect(parseSafePath('/repos//o/r')).toBeNull();
    expect(parseSafePath('/repos/o/r/%zz')).toBeNull();
    expect(parseSafePath('/repos/o/r/%5c')).toBeNull();
  });

  it('decodes normal segments', () => {
    expect(parseSafePath('/repos/o/r/contents/my%20file.md')).toEqual([
      'repos',
      'o',
      'r',
      'contents',
      'my file.md',
    ]);
    expect(parseSafePath('/')).toEqual([]);
  });
});
