import { HTTP } from '../httpStatus.js';
import { matchPath } from './pathMatch.js';
import type {
  AuthzDecision,
  DeviceFlow,
  DevicePollResult,
  Grant,
  PermissionDef,
  ToolProvider,
} from './types.js';

const API = 'https://api.github.com';
const WEB = 'https://github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'local-gateway';
// RFC 8628 defaults when GitHub omits them
const DEFAULT_DEVICE_CODE_TTL_SECONDS = 900;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_SLOW_DOWN_INTERVAL_SECONDS = 10;

/** GitHub permission ids, as stored in templates and session keys. */
const PERM = {
  METADATA_READ: 'metadata:read',
  CONTENTS_READ: 'contents:read',
  CONTENTS_WRITE: 'contents:write',
  ISSUES_READ: 'issues:read',
  ISSUES_WRITE: 'issues:write',
  PULLS_READ: 'pulls:read',
  PULLS_WRITE: 'pulls:write',
  ACTIONS_READ: 'actions:read',
  ACTIONS_WRITE: 'actions:write',
  USER_READ: 'user:read',
  SEARCH_READ: 'search:read',
} as const;

const PERMISSIONS: readonly PermissionDef[] = [
  {
    id: PERM.METADATA_READ,
    label: 'Repository metadata (read)',
    description: 'Repository info, branches, tags, languages, topics, contributors.',
  },
  {
    id: PERM.CONTENTS_READ,
    label: 'Contents (read)',
    description:
      'Files, commits, git objects, compares, releases, archives, check runs on commits.',
  },
  {
    id: PERM.CONTENTS_WRITE,
    label: 'Contents (write)',
    description: 'Create/update/delete files, create git objects, update refs, merge branches.',
  },
  {
    id: PERM.ISSUES_READ,
    label: 'Issues (read)',
    description: 'Issues, issue comments, labels, milestones.',
  },
  {
    id: PERM.ISSUES_WRITE,
    label: 'Issues (write)',
    description: 'Open/edit issues, comment, manage labels and milestones.',
  },
  {
    id: PERM.PULLS_READ,
    label: 'Pull requests (read)',
    description: 'Pull requests, reviews, diffs.',
  },
  {
    id: PERM.PULLS_WRITE,
    label: 'Pull requests (write)',
    description: 'Open/edit pull requests, review, comment, merge.',
  },
  { id: PERM.ACTIONS_READ, label: 'Actions (read)', description: 'Workflows, runs, jobs, logs.' },
  {
    id: PERM.ACTIONS_WRITE,
    label: 'Actions (trigger)',
    description: 'Dispatch workflows, re-run or cancel runs. Does not grant access to secrets.',
  },
  {
    id: PERM.USER_READ,
    label: 'User profile (read)',
    description:
      'Authenticated user, their repo/org lists, public user profiles. Not limited by the repository allowlist.',
  },
  {
    id: PERM.SEARCH_READ,
    label: 'Search (read)',
    description:
      'Search API. Not limited by the repository allowlist: only enable for unrestricted templates.',
  },
];

interface Rule {
  permission: string;
  methods: readonly string[];
  pattern: string;
}

const R = ['GET', 'HEAD'] as const;
const W = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const REPO = '/repos/:owner/:repo';

const RULES: readonly Rule[] = [
  { permission: PERM.METADATA_READ, methods: R, pattern: REPO },
  ...['branches/**', 'tags', 'languages', 'topics', 'contributors'].map((p) => ({
    permission: PERM.METADATA_READ,
    methods: R,
    pattern: `${REPO}/${p}`,
  })),
  ...[
    'contents/**',
    'readme/**',
    'commits/**',
    'compare/**',
    'git/**',
    'tarball/**',
    'zipball/**',
    'releases/**',
  ].map((p) => ({ permission: PERM.CONTENTS_READ, methods: R, pattern: `${REPO}/${p}` })),
  { permission: PERM.CONTENTS_WRITE, methods: ['PUT', 'DELETE'], pattern: `${REPO}/contents/**` },
  { permission: PERM.CONTENTS_WRITE, methods: ['POST'], pattern: `${REPO}/git/**` },
  { permission: PERM.CONTENTS_WRITE, methods: ['PATCH', 'DELETE'], pattern: `${REPO}/git/refs/**` },
  { permission: PERM.CONTENTS_WRITE, methods: ['POST'], pattern: `${REPO}/merges` },
  ...['issues/**', 'labels/**', 'milestones/**'].map((p) => ({
    permission: PERM.ISSUES_READ,
    methods: R,
    pattern: `${REPO}/${p}`,
  })),
  ...['issues/**', 'labels/**', 'milestones/**'].map((p) => ({
    permission: PERM.ISSUES_WRITE,
    methods: W,
    pattern: `${REPO}/${p}`,
  })),
  { permission: PERM.PULLS_READ, methods: R, pattern: `${REPO}/pulls/**` },
  { permission: PERM.PULLS_WRITE, methods: W, pattern: `${REPO}/pulls/**` },
  { permission: PERM.ACTIONS_READ, methods: R, pattern: `${REPO}/actions/workflows/**` },
  { permission: PERM.ACTIONS_READ, methods: R, pattern: `${REPO}/actions/runs/**` },
  { permission: PERM.ACTIONS_READ, methods: R, pattern: `${REPO}/actions/jobs/**` },
  { permission: PERM.ACTIONS_READ, methods: R, pattern: `${REPO}/actions/artifacts/**` },
  {
    permission: PERM.ACTIONS_WRITE,
    methods: ['POST'],
    pattern: `${REPO}/actions/workflows/*/dispatches`,
  },
  ...['rerun', 'rerun-failed-jobs', 'cancel'].map((p) => ({
    permission: PERM.ACTIONS_WRITE,
    methods: ['POST'],
    pattern: `${REPO}/actions/runs/*/${p}`,
  })),
  { permission: PERM.ACTIONS_WRITE, methods: ['POST'], pattern: `${REPO}/actions/jobs/*/rerun` },
  { permission: PERM.USER_READ, methods: R, pattern: '/user' },
  { permission: PERM.USER_READ, methods: R, pattern: '/user/repos' },
  { permission: PERM.USER_READ, methods: R, pattern: '/user/orgs' },
  { permission: PERM.USER_READ, methods: R, pattern: '/users/**' },
  { permission: PERM.SEARCH_READ, methods: R, pattern: '/search/**' },
];

/** Always allowed for any valid session: harmless and useful for clients. */
const ALWAYS_ALLOWED: readonly Rule[] = [
  { permission: 'meta', methods: R, pattern: '/rate_limit' },
];

const RESOURCE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?:\*|[A-Za-z0-9._-]{1,100})$/;

export function repoMatches(resources: readonly string[], owner: string, repo: string): boolean {
  if (resources.length === 0) return true;
  const o = owner.toLowerCase();
  const r = repo.toLowerCase();
  return resources.some((pattern) => {
    const [po, pr] = pattern.toLowerCase().split('/');
    return po === o && (pr === '*' || pr === r);
  });
}

/** Token kind from GitHub's documented prefixes. */
function tokenType(token: string): string {
  if (token.startsWith('github_pat_')) return 'fine-grained PAT';
  if (token.startsWith('ghp_')) return 'classic PAT';
  if (token.startsWith('gho_')) return 'OAuth app';
  if (token.startsWith('ghu_')) return 'GitHub App user';
  return 'unknown';
}

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

function createDeviceFlow(fetchImpl: typeof fetch): DeviceFlow {
  const post = async <T>(path: string, params: Record<string, string>): Promise<T> => {
    const res = await fetchImpl(`${WEB}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body: new URLSearchParams(params).toString(),
    });
    if (res.status === HTTP.NOT_FOUND) {
      throw new Error('Unknown OAuth client ID (GitHub answered 404)');
    }
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  return {
    registerUrl: `${WEB}/settings/applications/new`,
    setupHelp:
      'Register an OAuth App at github.com/settings/applications/new (any homepage and callback URL, e.g. http://127.0.0.1:7420), tick “Enable Device Flow”, then paste its Client ID here. No client secret is needed.',
    defaultScopes: 'repo read:org',

    async start(clientId, scopes) {
      const data = await post<DeviceCodeResponse>('/login/device/code', {
        client_id: clientId,
        scope: scopes,
      });
      if (data.error || !data.device_code || !data.user_code || !data.verification_uri) {
        throw new Error(
          data.error === 'device_flow_disabled'
            ? 'Device Flow is not enabled on this OAuth App (tick “Enable Device Flow” in its settings)'
            : (data.error_description ?? data.error ?? 'Unexpected response from GitHub'),
        );
      }
      return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresIn: data.expires_in ?? DEFAULT_DEVICE_CODE_TTL_SECONDS,
        interval: data.interval ?? DEFAULT_POLL_INTERVAL_SECONDS,
      };
    },

    async poll(clientId, deviceCode): Promise<DevicePollResult> {
      const data = await post<AccessTokenResponse>('/login/oauth/access_token', {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (data.access_token) return { status: 'complete', secret: data.access_token };
      switch (data.error) {
        case 'authorization_pending':
          return { status: 'pending' };
        case 'slow_down':
          return {
            status: 'slow_down',
            interval: data.interval ?? DEFAULT_SLOW_DOWN_INTERVAL_SECONDS,
          };
        case 'expired_token':
          return { status: 'failed', message: 'The code expired before it was approved' };
        case 'access_denied':
          return { status: 'failed', message: 'Authorization was denied on GitHub' };
        default:
          return {
            status: 'failed',
            message: data.error_description ?? data.error ?? 'Unexpected response from GitHub',
          };
      }
    },
  };
}

export function createGitHubProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  return {
    id: 'github',
    name: 'GitHub',
    credentialHelp:
      'Personal access token (fine-grained recommended). The gateway can never grant more than this token allows.',
    credentialPlaceholder: 'github_pat_…',
    deviceFlow: createDeviceFlow(fetchImpl),
    resourceHelp:
      'One per line: "owner/repo" or "owner/*". Leave empty to allow every repository the token can reach.',
    permissions: PERMISSIONS,
    upstreamBaseUrl: API,
    example: { method: 'GET', path: '/user', clientHint: 'e.g. Octokit baseUrl' },

    validateResource(pattern) {
      return RESOURCE_RE.test(pattern) ? null : `Invalid repository pattern "${pattern}"`;
    },

    async verifyCredential(secret) {
      const res = await fetchImpl(`${API}/user`, {
        headers: {
          authorization: `Bearer ${secret}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': API_VERSION,
          'user-agent': USER_AGENT,
        },
      });
      if (!res.ok) {
        throw new Error(`GitHub rejected the token (HTTP ${res.status})`);
      }
      const user = (await res.json()) as { login?: string; id?: number; name?: string | null };
      const identity: Record<string, string> = {
        login: user.login ?? 'unknown',
        userId: String(user.id ?? ''),
      };
      if (user.name) identity.name = user.name;
      identity.tokenType = tokenType(secret);
      const scopes = res.headers.get('x-oauth-scopes');
      if (scopes) identity.scopes = scopes;
      const expiry = res.headers.get('github-authentication-token-expiration');
      if (expiry) identity.tokenExpires = expiry;
      return identity;
    },

    authorize({ method, segments }, grant: Grant): AuthzDecision {
      const m = method.toUpperCase();
      for (const rule of ALWAYS_ALLOWED) {
        if (rule.methods.includes(m) && matchPath(rule.pattern, segments)) {
          return { allowed: true, permission: rule.permission };
        }
      }
      let repoDenied = false;
      let matchedPermission: string | null = null;
      for (const rule of RULES) {
        if (!rule.methods.includes(m)) continue;
        const params = matchPath(rule.pattern, segments);
        if (!params) continue;
        matchedPermission ??= rule.permission;
        if (!grant.permissions.includes(rule.permission)) continue;
        const { owner, repo } = params;
        if (
          owner !== undefined &&
          repo !== undefined &&
          !repoMatches(grant.resources, owner, repo)
        ) {
          repoDenied = true;
          continue;
        }
        return { allowed: true, permission: rule.permission };
      }
      if (repoDenied) return { allowed: false, reason: 'Repository is not in the allowlist' };
      if (matchedPermission) {
        return { allowed: false, reason: `Missing permission "${matchedPermission}"` };
      }
      return { allowed: false, reason: 'Endpoint is not covered by any gateway permission' };
    },

    upstreamHeaders(secret, incoming) {
      const out = new Headers();
      for (const name of ['accept', 'content-type', 'if-none-match', 'if-modified-since']) {
        const value = incoming.get(name);
        if (value) out.set(name, value);
      }
      if (!out.has('accept')) out.set('accept', 'application/vnd.github+json');
      out.set('x-github-api-version', incoming.get('x-github-api-version') ?? API_VERSION);
      out.set('user-agent', USER_AGENT);
      out.set('authorization', `Bearer ${secret}`);
      return out;
    },

    rewriteResponseHeader(name, value, proxyBaseUrl) {
      return name === 'link' ? value.split(API).join(proxyBaseUrl) : value;
    },
  };
}
