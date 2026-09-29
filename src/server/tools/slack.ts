import { isRecord } from './json.js';
import type { AuthzDecision, Grant, PermissionDef, ToolProvider, ToolRequest } from './types.js';

/**
 * Slack Web API: `https://slack.com/api/<method>`, arguments in the query string, a form body,
 * a JSON body, or a mix of them. The gateway merges every source (rejecting duplicates), checks
 * the method and its `channel`, then re-sends one canonical form POST so Slack reads exactly
 * what was checked.
 */

const API = 'https://slack.com';
const API_SEGMENT = 'api';
const USER_AGENT = 'local-gateway';
const FORM = 'application/x-www-form-urlencoded';
/** Conversation IDs: public (C), private (G) channels and DMs (D). Names and user IDs don't count. */
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]{2,20}$/;

const PERM = {
  CHANNELS_READ: 'channels:read',
  HISTORY_READ: 'history:read',
  CHAT_WRITE: 'chat:write',
  CHANNELS_MANAGE: 'channels:manage',
  USERS_READ: 'users:read',
  SEARCH_READ: 'search:read',
} as const;

const PERMISSIONS: readonly PermissionDef[] = [
  {
    id: PERM.HISTORY_READ,
    label: 'Messages (read)',
    description: 'Channel history, threads, permalinks, reactions and pins.',
  },
  {
    id: PERM.CHAT_WRITE,
    label: 'Messages (write)',
    description:
      'Post, schedule, edit and delete messages; add or remove reactions and pins. Opening DMs needs an unrestricted template.',
  },
  {
    id: PERM.CHANNELS_READ,
    label: 'Channels (read)',
    description:
      'Channel info and members. Listing channels is not limited by the channel allowlist.',
  },
  {
    id: PERM.CHANNELS_MANAGE,
    label: 'Channels (manage)',
    description:
      'Join, leave, invite, kick, rename, set topic/purpose, archive. Creating channels needs an unrestricted template.',
  },
  {
    id: PERM.USERS_READ,
    label: 'Users (read)',
    description:
      'User directory, profiles and workspace info. Not limited by the channel allowlist.',
  },
  {
    id: PERM.SEARCH_READ,
    label: 'Search (read)',
    description:
      'Message search. Not limited by the channel allowlist: only enable for unrestricted templates.',
  },
];

/**
 * How a method is tied to channels:
 *  - `'channel'`: acts on the conversation in its `channel` argument, checked against the allowlist;
 *  - `'workspace'`: directory data, allowed on channel-restricted grants;
 *  - `'all-channels'`: can reach channels it doesn't name, only allowed on unrestricted grants.
 */
type MethodScope = typeof CHANNEL | typeof WORKSPACE | typeof ALL_CHANNELS;
const CHANNEL = 'channel';
const WORKSPACE = 'workspace';
const ALL_CHANNELS = 'all-channels';

interface MethodRule {
  permission: string;
  scope: MethodScope;
}

const rules = (permission: string, scope: MethodScope, methods: readonly string[]) =>
  methods.map((method) => [method, { permission, scope }] as const);

const RULES = new Map<string, MethodRule>([
  ...rules(PERM.HISTORY_READ, CHANNEL, [
    'conversations.history',
    'conversations.replies',
    'chat.getPermalink',
    'reactions.get',
    'pins.list',
  ]),
  ...rules(PERM.CHAT_WRITE, CHANNEL, [
    'chat.postMessage',
    'chat.postEphemeral',
    'chat.scheduleMessage',
    'chat.deleteScheduledMessage',
    'chat.update',
    'chat.delete',
    'reactions.add',
    'reactions.remove',
    'pins.add',
    'pins.remove',
    'conversations.mark',
  ]),
  ...rules(PERM.CHAT_WRITE, ALL_CHANNELS, ['conversations.open', 'chat.scheduledMessages.list']),
  ...rules(PERM.CHANNELS_READ, CHANNEL, ['conversations.info', 'conversations.members']),
  ...rules(PERM.CHANNELS_READ, WORKSPACE, ['conversations.list', 'users.conversations']),
  ...rules(PERM.CHANNELS_MANAGE, CHANNEL, [
    'conversations.join',
    'conversations.leave',
    'conversations.invite',
    'conversations.kick',
    'conversations.rename',
    'conversations.setTopic',
    'conversations.setPurpose',
    'conversations.archive',
    'conversations.unarchive',
  ]),
  ...rules(PERM.CHANNELS_MANAGE, ALL_CHANNELS, ['conversations.create']),
  ...rules(PERM.USERS_READ, WORKSPACE, [
    'users.list',
    'users.info',
    'users.lookupByEmail',
    'users.profile.get',
    'users.getPresence',
    'team.info',
  ]),
  ...rules(PERM.SEARCH_READ, ALL_CHANNELS, ['search.messages']),
]);

/** Harmless for any valid session: who the token is, and connectivity checks. */
const ALWAYS_ALLOWED = new Set(['auth.test', 'api.test']);

class Denied extends Error {}

/** A request argument as Slack reads it in a form body: strings, JSON for anything structured. */
function argString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function bodyArgs(request: ToolRequest): [string, string][] {
  if (!request.body) return [];
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  const text = request.body.toString('utf8');
  if (type === FORM) return [...new URLSearchParams(text)];
  if (type === 'application/json') {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Denied('The JSON body is not valid JSON');
    }
    if (!isRecord(json)) throw new Denied('The JSON body must be an object of arguments');
    return Object.entries(json).map(([k, v]) => [k, argString(v)]);
  }
  throw new Denied(`Unsupported content type "${type ?? ''}": use form or JSON arguments`);
}

/** Every argument from the query string and body; the same name twice is ambiguous, so denied. */
function collectArgs(request: ToolRequest): Map<string, string> {
  const args = new Map<string, string>();
  for (const [name, value] of [...new URLSearchParams(request.search), ...bodyArgs(request)]) {
    if (args.has(name)) throw new Denied(`Argument "${name}" is given more than once`);
    if (name === 'token') throw new Denied('Pass the session key in the Authorization header');
    args.set(name, value);
  }
  return args;
}

function checkScope(method: string, rule: MethodRule, args: Map<string, string>, grant: Grant) {
  if (grant.resources.length === 0 || rule.scope === WORKSPACE) return;
  if (rule.scope === ALL_CHANNELS) {
    throw new Denied(`"${method}" can't be limited to channels: it needs an unrestricted template`);
  }
  const channel = args.get('channel');
  if (channel === undefined || !CHANNEL_ID_RE.test(channel)) {
    throw new Denied(`"${method}" needs a channel ID in "channel" on channel-restricted templates`);
  }
  if (!grant.resources.includes(channel)) {
    throw new Denied(`Channel ${channel} is not in the allowlist`);
  }
}

function authorizeMethod(request: ToolRequest, grant: Grant): AuthzDecision {
  const [first, method, ...rest] = request.segments;
  const verb = request.method.toUpperCase();
  if (first !== API_SEGMENT || method === undefined || rest.length > 0) {
    throw new Denied(`Only /${API_SEGMENT}/<method> calls are supported`);
  }
  if (verb !== 'GET' && verb !== 'POST') throw new Denied('Only GET and POST are supported');
  const args = collectArgs(request);
  let permission = 'meta';
  if (!ALWAYS_ALLOWED.has(method)) {
    const rule = RULES.get(method);
    if (!rule) throw new Denied(`"${method}" is not covered by any gateway permission`);
    if (!grant.permissions.includes(rule.permission)) {
      throw new Denied(`Missing permission "${rule.permission}"`);
    }
    checkScope(method, rule, args, grant);
    permission = rule.permission;
  }
  const channel = args.get('channel');
  return {
    allowed: true,
    permission,
    detail: channel ? `${method} ${channel}` : method,
    method: 'POST',
    search: '',
    body: Buffer.from(new URLSearchParams([...args]).toString()),
  };
}

/** Token kind from Slack's documented prefixes. */
function tokenType(token: string): string {
  if (token.startsWith('xoxb-')) return 'bot token';
  if (token.startsWith('xoxp-')) return 'user token';
  return 'unknown';
}

export function createSlackProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  return {
    id: 'slack',
    name: 'Slack',
    credentialHelp:
      'Bot (xoxb-…) or user (xoxp-…) token of a Slack app installed in your workspace (api.slack.com/apps → OAuth & Permissions). The gateway can never grant more than this token allows.',
    credentialPlaceholder: 'xoxb-…',
    resourceHelp:
      'One channel ID per line (e.g. C0123456789, from the channel details). Leave empty to allow every conversation the token can reach.',
    permissions: PERMISSIONS,
    upstreamBaseUrl: API,
    example: {
      method: 'GET',
      path: `/${API_SEGMENT}/auth.test`,
      clientHint: 'e.g. @slack/web-api slackApiUrl',
    },

    validateResource(pattern) {
      return CHANNEL_ID_RE.test(pattern) ? null : `Invalid channel ID "${pattern}"`;
    },

    async verifyCredential(secret) {
      const res = await fetchImpl(`${API}/${API_SEGMENT}/auth.test`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'user-agent': USER_AGENT },
      });
      const json: unknown = res.ok ? await res.json() : null;
      if (!isRecord(json) || json.ok !== true) {
        const error =
          isRecord(json) && typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
        throw new Error(`Slack rejected the token (${error})`);
      }
      const identity: Record<string, string> = { tokenType: tokenType(secret) };
      for (const [key, name] of [
        ['login', 'user'],
        ['userId', 'user_id'],
        ['team', 'team'],
        ['teamId', 'team_id'],
        ['workspaceUrl', 'url'],
      ] as const) {
        const value = json[name];
        if (typeof value === 'string') identity[key] = value;
      }
      const scopes = res.headers.get('x-oauth-scopes');
      if (scopes) identity.scopes = scopes;
      return identity;
    },

    authorize(request, grant): AuthzDecision {
      try {
        return authorizeMethod(request, grant);
      } catch (err) {
        if (err instanceof Denied) return { allowed: false, reason: err.message };
        throw err;
      }
    },

    upstreamHeaders(secret) {
      // Arguments are always re-sent as a form body (see `authorizeMethod`).
      return new Headers({
        accept: 'application/json',
        'content-type': FORM,
        'user-agent': USER_AGENT,
        authorization: `Bearer ${secret}`,
      });
    },
  };
}
