import { isRecord } from './json.js';
import { matchPath } from './pathMatch.js';
import type { AuthzDecision, PermissionDef, ToolProvider, ToolRequest } from './types.js';

const API = 'https://gmail.googleapis.com';
const MAILBOX = 'gmail/v1/users/me';
const JSON_TYPE = 'application/json';
const MAILBOX_SEGMENTS = MAILBOX.split('/').length;
const USER_AGENT = 'local-gateway';
const DRAFT_PATH = 'drafts/:id';
const LABEL_PATH = 'labels/:id';

const PERM = {
  MESSAGES_READ: 'messages:read',
  MESSAGES_WRITE: 'messages:write',
  MESSAGES_SEND: 'messages:send',
  MESSAGES_DELETE: 'messages:delete',
  DRAFTS_WRITE: 'drafts:write',
  LABELS_READ: 'labels:read',
  LABELS_WRITE: 'labels:write',
} as const;

const PERMISSIONS: readonly PermissionDef[] = [
  {
    id: PERM.MESSAGES_READ,
    label: 'Mail (read)',
    description:
      'Read and search messages, threads, attachments, drafts, history and the mailbox profile.',
  },
  {
    id: PERM.MESSAGES_WRITE,
    label: 'Mail (modify)',
    description:
      'Change labels on messages and threads, move mail to trash and restore it. Does not send or permanently delete mail.',
  },
  {
    id: PERM.MESSAGES_SEND,
    label: 'Mail (send)',
    description: 'Send messages and existing drafts.',
  },
  {
    id: PERM.MESSAGES_DELETE,
    label: 'Mail (delete permanently)',
    description: 'Permanently delete messages and threads, including batch deletion.',
  },
  {
    id: PERM.DRAFTS_WRITE,
    label: 'Drafts (write)',
    description: 'Create, update and delete drafts. Does not send them.',
  },
  {
    id: PERM.LABELS_READ,
    label: 'Labels (read)',
    description: 'List labels and read label details.',
  },
  {
    id: PERM.LABELS_WRITE,
    label: 'Labels (write)',
    description: 'Create, update and delete labels.',
  },
];

interface Rule {
  method: string;
  path: string;
  permission: string;
}

const rules = (method: string, permission: string, paths: readonly string[]): Rule[] =>
  paths.map((path) => ({ method, path, permission }));

/** Explicit Gmail REST methods only; no settings, delegation, watches, imports or uploads. */
const RULES: readonly Rule[] = [
  ...rules('GET', PERM.MESSAGES_READ, [
    'profile',
    'messages',
    'messages/:id',
    'messages/:id/attachments/:attachment',
    'threads',
    'threads/:id',
    'drafts',
    DRAFT_PATH,
    'history',
  ]),
  ...rules('POST', PERM.MESSAGES_WRITE, [
    'messages/:id/modify',
    'messages/:id/trash',
    'messages/:id/untrash',
    'messages/batchModify',
    'threads/:id/modify',
    'threads/:id/trash',
    'threads/:id/untrash',
  ]),
  ...rules('POST', PERM.MESSAGES_SEND, ['messages/send', 'drafts/send']),
  ...rules('DELETE', PERM.MESSAGES_DELETE, ['messages/:id', 'threads/:id']),
  ...rules('POST', PERM.MESSAGES_DELETE, ['messages/batchDelete']),
  ...rules('POST', PERM.DRAFTS_WRITE, ['drafts']),
  ...rules('PUT', PERM.DRAFTS_WRITE, [DRAFT_PATH]),
  ...rules('DELETE', PERM.DRAFTS_WRITE, [DRAFT_PATH]),
  ...rules('GET', PERM.LABELS_READ, ['labels', LABEL_PATH]),
  ...rules('POST', PERM.LABELS_WRITE, ['labels']),
  ...rules('PUT', PERM.LABELS_WRITE, [LABEL_PATH]),
  ...rules('PATCH', PERM.LABELS_WRITE, [LABEL_PATH]),
  ...rules('DELETE', PERM.LABELS_WRITE, [LABEL_PATH]),
];

/** Allow documented read parameters and harmless JSON response options, never method overrides. */
const QUERY_PARAMS = new Set([
  'alt',
  'fields',
  'prettyPrint',
  'pageToken',
  'maxResults',
  'q',
  'labelIds',
  'includeSpamTrash',
  'format',
  'metadataHeaders',
  'startHistoryId',
  'historyTypes',
  'labelId',
]);
const REPEATED_PARAMS = new Set(['labelIds', 'metadataHeaders', 'historyTypes']);
const RESPONSE_PARAMS = new Set(['alt', 'fields', 'prettyPrint']);

function queryError(request: ToolRequest): string | null {
  const seen = new Set<string>();
  for (const [name, value] of new URLSearchParams(request.search)) {
    if (!QUERY_PARAMS.has(name) || (request.method !== 'GET' && !RESPONSE_PARAMS.has(name))) {
      return `Unsupported query parameter "${name}"`;
    }
    if (name === 'alt' && value !== 'json') return 'Only JSON responses (alt=json) are supported';
    if (seen.has(name) && !REPEATED_PARAMS.has(name)) {
      return `Query parameter "${name}" is given more than once`;
    }
    seen.add(name);
  }
  return null;
}

function checkedBody(request: ToolRequest): Buffer | undefined {
  if (!request.body || request.body.length === 0) return undefined;
  if (request.method === 'GET' || request.method === 'DELETE') {
    throw new Error('GET and DELETE requests must not have a body');
  }
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== JSON_TYPE) throw new Error('Use an application/json body');
  const json: unknown = JSON.parse(request.body.toString('utf8'));
  if (!isRecord(json)) throw new Error('The JSON body must be an object');
  return Buffer.from(JSON.stringify(json));
}

export function createGmailProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  const upstreamHeaders = (secret: string) =>
    new Headers({
      authorization: `Bearer ${secret}`,
      accept: JSON_TYPE,
      'content-type': JSON_TYPE,
      'user-agent': USER_AGENT,
    });

  return {
    id: 'gmail',
    name: 'Gmail',
    credentialHelp:
      'Google OAuth access token with Gmail scopes (not an API key or app password). Enable the Gmail API in your Google Cloud project. Tokens expire: reconnect with a fresh token when needed. The gateway can never grant more than the token allows.',
    credentialPlaceholder: 'ya29.…',
    resourceHelp:
      'Leave empty. Each account is one mailbox: only /gmail/v1/users/me is supported. Label or recipient restrictions are not supported.',
    permissions: PERMISSIONS,
    upstreamBaseUrl: API,
    example: {
      method: 'GET',
      path: `/${MAILBOX}/profile`,
      clientHint: 'Gmail REST API: /gmail/v1/users/me (messages:read needed for the profile)',
    },

    validateResource() {
      return 'Gmail does not support resource allowlists; use a separate account for each mailbox';
    },

    async verifyCredential(secret) {
      const res = await fetchImpl(`${API}/${MAILBOX}/profile`, {
        headers: upstreamHeaders(secret),
      });
      const json: unknown = res.ok ? await res.json() : null;
      if (!isRecord(json) || typeof json.emailAddress !== 'string' || !json.emailAddress) {
        throw new Error(
          `Gmail rejected the token (HTTP ${res.status}); a Gmail scope that allows reading the profile is required`,
        );
      }
      return { login: json.emailAddress };
    },

    authorize(request, grant): AuthzDecision {
      if (grant.resources.length > 0) {
        return { allowed: false, reason: 'Gmail does not support resource allowlists' };
      }
      const prefix = request.segments.slice(0, MAILBOX_SEGMENTS).join('/');
      if (prefix !== MAILBOX) {
        return { allowed: false, reason: `Only /${MAILBOX}/… is supported` };
      }
      const segments = request.segments.slice(MAILBOX_SEGMENTS);
      const rule = RULES.find((r) => r.method === request.method && matchPath(r.path, segments));
      if (!rule)
        return {
          allowed: false,
          reason: 'This Gmail endpoint is not covered by any gateway permission',
        };
      if (!grant.permissions.includes(rule.permission)) {
        return { allowed: false, reason: `Missing permission "${rule.permission}"` };
      }
      const error = queryError(request);
      if (error) return { allowed: false, reason: error };
      try {
        return { allowed: true, permission: rule.permission, body: checkedBody(request) };
      } catch {
        return {
          allowed: false,
          reason:
            'Invalid request body: use a JSON object for writes and no body for GET or DELETE',
        };
      }
    },

    upstreamHeaders,
  };
}
