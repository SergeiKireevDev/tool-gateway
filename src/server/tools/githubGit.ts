import { gunzipSync } from 'node:zlib';
import { isRecord } from './json.js';
import type { AuthzDecision, Grant, ToolRequest, ToolRequestContext } from './types.js';

/**
 * git over HTTP ("smart HTTP") to github.com through the proxy, so agents can clone and push:
 *
 *   /proxy/github/git/<owner>/<repo>.git/info/refs?service=git-upload-pack   clone / fetch
 *   /proxy/github/git/<owner>/<repo>.git/git-upload-pack
 *   /proxy/github/git/<owner>/<repo>.git/info/refs?service=git-receive-pack  push
 *   /proxy/github/git/<owner>/<repo>.git/git-receive-pack
 *
 * Fetching needs `contents:read`, pushing `contents:write`, and the repository must be in the
 * allowlist. Each push is read before it is forwarded: only branches may be updated, never
 * deleted, and never the repository's default branch (agents push a branch and open a PR).
 */

const WEB = 'https://github.com';
const API = 'https://api.github.com';
const USER_AGENT = 'local-gateway';
export const GIT_SEGMENT = 'git';
const UPLOAD = 'git-upload-pack';
const RECEIVE = 'git-receive-pack';
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const ZERO_ID_RE = /^0+$/;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PKT_LEN_CHARS = 4;
const HEX = 16;
const BRANCH_PREFIX = 'refs/heads/';
/** Request headers git needs upstream; the credential is added by the gateway. */
const GIT_HEADERS = ['accept', 'content-type', 'content-encoding', 'git-protocol'];
const PERM_READ = 'contents:read';
const MALFORMED = 'Malformed push request';
const PERM_WRITE = 'contents:write';

class Denied extends Error {}

export interface RefUpdate {
  oldId: string;
  newId: string;
  ref: string;
}

/**
 * The ref updates at the start of a `git-receive-pack` request body: pkt-lines of
 * `<old-id> <new-id> <ref>` (the first one followed by NUL and capabilities), then a flush packet,
 * then the pack data.
 */
export function parseRefUpdates(body: Buffer): RefUpdate[] {
  const updates: RefUpdate[] = [];
  let offset = 0;
  while (offset + PKT_LEN_CHARS <= body.length) {
    const length = Number.parseInt(
      body.subarray(offset, offset + PKT_LEN_CHARS).toString('ascii'),
      HEX,
    );
    if (!Number.isInteger(length)) throw new Denied(MALFORMED);
    if (length === 0) return updates;
    if (length < PKT_LEN_CHARS || offset + length > body.length) throw new Denied(MALFORMED);
    const line = body.subarray(offset + PKT_LEN_CHARS, offset + length).toString('utf8');
    offset += length;
    const command = line.split('\0')[0]?.replace(/\n$/, '') ?? '';
    if (command.startsWith('shallow ')) continue;
    const [oldId = '', newId = '', ref = ''] = command.split(' ');
    if (!OBJECT_ID_RE.test(oldId) || !OBJECT_ID_RE.test(newId) || !ref) {
      throw new Denied('Malformed push command');
    }
    updates.push({ oldId, newId, ref });
  }
  throw new Denied(MALFORMED);
}

async function defaultBranch(
  owner: string,
  repo: string,
  secret: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const res = await fetchImpl(`${API}/repos/${owner}/${repo}`, {
    headers: {
      authorization: `Bearer ${secret}`,
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
    },
  });
  const json: unknown = res.ok ? await res.json() : null;
  if (!isRecord(json) || typeof json.default_branch !== 'string') {
    throw new Denied(`Could not read the default branch of ${owner}/${repo} (HTTP ${res.status})`);
  }
  return json.default_branch;
}

async function checkPush(
  body: Buffer | undefined,
  headers: Headers,
  repo: { owner: string; name: string },
  secret: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (!body) throw new Denied('Empty push');
  const gzipped = (headers.get('content-encoding') ?? '').toLowerCase() === 'gzip';
  let plain: Buffer;
  try {
    plain = gzipped ? gunzipSync(body) : body;
  } catch {
    throw new Denied(MALFORMED);
  }
  const updates = parseRefUpdates(plain);
  if (updates.length === 0) throw new Denied('Empty push');
  const main = `${BRANCH_PREFIX}${await defaultBranch(repo.owner, repo.name, secret, fetchImpl)}`;
  for (const { newId, ref } of updates) {
    if (!ref.startsWith(BRANCH_PREFIX)) throw new Denied(`Only branches can be pushed, not ${ref}`);
    if (ZERO_ID_RE.test(newId)) throw new Denied(`Deleting ${ref} is not allowed`);
    if (ref === main) {
      throw new Denied(
        `Pushing to the default branch (${ref}) is not allowed: push another branch and open a pull request`,
      );
    }
  }
  return updates.map((u) => u.ref.slice(BRANCH_PREFIX.length)).join(', ');
}

function gitHeaders(secret: string, incoming: Headers): Headers {
  const out = new Headers({ 'user-agent': `git/2 (${USER_AGENT})` });
  for (const name of GIT_HEADERS) {
    const value = incoming.get(name);
    if (value) out.set(name, value);
  }
  const credentials = Buffer.from(`x-access-token:${secret}`).toString('base64');
  out.set('authorization', `Basic ${credentials}`);
  return out;
}

/** Which git service a request is, from its path and query; null when it isn't a git call. */
function serviceOf(
  rest: readonly string[],
  method: string,
  search: string,
): typeof UPLOAD | typeof RECEIVE | null {
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = new URLSearchParams(search).get('service');
    const exact = search === `?service=${service ?? ''}`;
    return exact && (service === UPLOAD || service === RECEIVE) ? service : null;
  }
  if (method === 'POST' && rest.length === 1 && (rest[0] === UPLOAD || rest[0] === RECEIVE))
    return rest[0];
  return null;
}

async function authorize(
  request: ToolRequest,
  grant: Grant,
  ctx: ToolRequestContext,
  fetchImpl: typeof fetch,
  repoAllowed: (owner: string, repo: string) => boolean,
): Promise<AuthzDecision> {
  const [, owner = '', repoGit = '', ...rest] = request.segments;
  const name = repoGit.replace(/\.git$/, '');
  if (!OWNER_RE.test(owner) || !REPO_RE.test(name) || name.endsWith('.')) {
    throw new Denied('Use /git/<owner>/<repo>.git');
  }
  const service = serviceOf(rest, request.method.toUpperCase(), request.search);
  if (!service) throw new Denied('Only git clone, fetch and push are supported');
  const permission = service === UPLOAD ? PERM_READ : PERM_WRITE;
  if (!grant.permissions.includes(permission))
    throw new Denied(`Missing permission "${permission}"`);
  if (!repoAllowed(owner, name)) throw new Denied('Repository is not in the allowlist');

  const pushing = service === RECEIVE && rest[0] === RECEIVE;
  const branches = pushing
    ? await checkPush(request.body, request.headers, { owner, name }, ctx.secret, fetchImpl)
    : null;
  return {
    allowed: true,
    permission,
    detail: branches
      ? `git push ${branches}`
      : service === UPLOAD
        ? 'git fetch'
        : 'git push (refs)',
    upstreamUrl: `${WEB}/${owner}/${name}.git/${rest.join('/')}${request.search}`,
    upstreamHeaders: gitHeaders,
  };
}

/** Authorizes a git request (segments starting with `git`); denials are returned, not thrown. */
export async function authorizeGit(
  request: ToolRequest,
  grant: Grant,
  ctx: ToolRequestContext,
  fetchImpl: typeof fetch,
  repoAllowed: (owner: string, repo: string) => boolean,
): Promise<AuthzDecision> {
  try {
    return await authorize(request, grant, ctx, fetchImpl, repoAllowed);
  } catch (err) {
    if (err instanceof Denied) return { allowed: false, reason: err.message };
    throw err;
  }
}
