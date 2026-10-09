import { isRecord } from './json.js';
import { matchPath } from './pathMatch.js';
import type {
  AuthzDecision,
  Grant,
  OAuthSignIn,
  OAuthTokens,
  PermissionDef,
  ToolProvider,
  ToolRequest,
} from './types.js';

/**
 * Gmail REST API (`https://gmail.googleapis.com/gmail/v1/users/me/...`), for the signed-in
 * mailbox only. Endpoints map to permissions; settings (forwarding, filters, send-as,
 * delegates), permanent deletes, imports and uploads are denied. The resource allowlist limits
 * who mail can be sent to: the gateway reads the recipients of every message it sends.
 */

const API = 'https://gmail.googleapis.com';
const PREFIX = ['gmail', 'v1', 'users', 'me'] as const;
const USER_AGENT = 'local-gateway';
const JSON_TYPE = 'application/json';
const CONTENT_TYPE = 'content-type';

// "Sign in with Google": the gateway's Google sign-in client (a Web application, redirecting back
// to the gateway), or a dedicated Desktop app client of the admin's Google Cloud project.
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Desktop clients accept any loopback redirect without registering it. */
const LOOPBACK_REDIRECT_URI = 'http://127.0.0.1:8765/';
/** Read, organize, draft and send; not permanent deletion or settings. */
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

export interface GmailOAuthClient {
  clientId: string;
  clientSecret: string;
  /** A redirect URI on the gateway (Web application client); the loopback one when absent. */
  redirectUri?: string;
}

const PERM = {
  MAIL_READ: 'mail:read',
  MAIL_MODIFY: 'mail:modify',
  LABELS_WRITE: 'labels:write',
  DRAFTS_READ: 'drafts:read',
  DRAFTS_WRITE: 'drafts:write',
  MAIL_SEND: 'mail:send',
} as const;

const PERMISSIONS: readonly PermissionDef[] = [
  {
    id: PERM.MAIL_READ,
    label: 'Mail (read)',
    description:
      'Messages, threads, attachments, history and labels. Not limited by the recipient allowlist.',
  },
  {
    id: PERM.MAIL_MODIFY,
    label: 'Mail (organize)',
    description: 'Add or remove labels (read, starred, archived…), trash and untrash.',
  },
  {
    id: PERM.LABELS_WRITE,
    label: 'Labels (manage)',
    description: 'Create, rename and delete labels.',
  },
  { id: PERM.DRAFTS_READ, label: 'Drafts (read)', description: 'List and read drafts.' },
  {
    id: PERM.DRAFTS_WRITE,
    label: 'Drafts (write)',
    description: 'Create, update and delete drafts (without sending them).',
  },
  {
    id: PERM.MAIL_SEND,
    label: 'Mail (send)',
    description:
      'Send messages, to allowlisted recipients only. Sending a saved draft needs an unrestricted template.',
  },
];

interface Rule {
  permission: string;
  method: string;
  /** Relative to `/gmail/v1/users/me`. */
  pattern: string;
  /** How a sending endpoint is checked against the recipient allowlist. */
  send?: 'message' | 'draft';
}

const rules = (permission: string, method: string, patterns: readonly string[]): Rule[] =>
  patterns.map((pattern) => ({ permission, method, pattern }));

const RULES: readonly Rule[] = [
  { permission: 'meta', method: 'GET', pattern: 'profile' },
  ...rules(PERM.MAIL_READ, 'GET', [
    'messages',
    'messages/:id',
    'messages/:id/attachments/:attachment',
    'threads',
    'threads/:id',
    'history',
    'labels',
    'labels/:id',
  ]),
  ...rules(PERM.MAIL_MODIFY, 'POST', [
    'messages/batchModify',
    'messages/:id/modify',
    'messages/:id/trash',
    'messages/:id/untrash',
    'threads/:id/modify',
    'threads/:id/trash',
    'threads/:id/untrash',
  ]),
  ...rules(PERM.LABELS_WRITE, 'POST', ['labels']),
  ...['PUT', 'PATCH', 'DELETE'].flatMap((m) => rules(PERM.LABELS_WRITE, m, ['labels/:id'])),
  ...rules(PERM.DRAFTS_READ, 'GET', ['drafts', 'drafts/:id']),
  { permission: PERM.MAIL_SEND, method: 'POST', pattern: 'messages/send', send: 'message' },
  { permission: PERM.MAIL_SEND, method: 'POST', pattern: 'drafts/send', send: 'draft' },
  ...rules(PERM.DRAFTS_WRITE, 'POST', ['drafts']),
  ...['PUT', 'DELETE'].flatMap((m) => rules(PERM.DRAFTS_WRITE, m, ['drafts/:id'])),
];

/** Query parameters that would change how Google authenticates or reads the request. */
const DENIED_PARAMS = new Set([
  'access_token',
  'oauth_token',
  'key',
  'uploadType',
  'upload_protocol',
]);
/** Fields of a `messages.send` body; anything else is refused rather than passed through. */
const SEND_FIELDS = new Set(['raw', 'threadId']);
const RECIPIENT_HEADERS = new Set(['to', 'cc', 'bcc']);
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const ADDRESS_RE = /^[^\s@<>"(),:;\\[\]]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const RESOURCE_RE = /^(?:\*|[^\s@<>"(),:;\\[\]*]+)@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

class Denied extends Error {}

/** Header section of an RFC 5322 message, unfolded, as `[lower-cased name, value]` pairs. */
function headersOf(message: string): [string, string][] {
  const end = message.search(/\r?\n\r?\n/);
  const lines = (end === -1 ? message : message.slice(0, end)).split(/\r?\n/);
  const headers: [string, string][] = [];
  for (const line of lines) {
    const last = headers.at(-1);
    if (/^[ \t]/.test(line)) {
      if (!last) throw new Denied('The message starts with a folded header line');
      last[1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Denied('The message has a malformed header line');
    headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return headers;
}

/**
 * The addresses of an address-list header. Only plain forms are accepted (`a@b.c`,
 * `Name <a@b.c>`, `"Name, Jr" <a@b.c>`): groups, comments and anything Gmail might read
 * differently are refused.
 */
export function parseAddressList(value: string): string[] {
  const unquoted = value.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (/[":;()\\]/.test(unquoted.replaceAll('""', ''))) {
    throw new Denied(`Recipients must be plain addresses: "${value}"`);
  }
  return unquoted
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const angle = /^([^<>]*)<([^<>]*)>$/.exec(part);
      if (angle?.[1]?.includes('@')) throw new Denied(`Ambiguous recipient "${part}"`);
      const address = (angle ? (angle[2] ?? '') : part).trim().toLowerCase();
      if (!ADDRESS_RE.test(address)) throw new Denied(`Unsupported recipient "${part}"`);
      return address;
    });
}

/** Every recipient of a raw (base64url) message, as Gmail sends to them: To, Cc and Bcc. */
export function recipientsOf(raw: string): string[] {
  if (!BASE64URL_RE.test(raw)) throw new Denied('"raw" must be a base64url-encoded message');
  const recipients: string[] = [];
  for (const [name, value] of headersOf(Buffer.from(raw, 'base64url').toString('utf8'))) {
    if (name.startsWith('resent-')) throw new Denied(`Header "${name}" is not supported`);
    if (RECIPIENT_HEADERS.has(name)) recipients.push(...parseAddressList(value));
  }
  return recipients;
}

export function recipientAllowed(resources: readonly string[], address: string): boolean {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return resources.some((p) => {
    const pattern = p.toLowerCase();
    return pattern === address || pattern === `*@${domain}`;
  });
}

function jsonBody(request: ToolRequest): Record<string, unknown> {
  const type = (request.headers.get(CONTENT_TYPE) ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== JSON_TYPE || !request.body) throw new Denied('Send the message as a JSON body');
  let json: unknown;
  try {
    json = JSON.parse(request.body.toString('utf8'));
  } catch {
    throw new Denied('The JSON body is not valid JSON');
  }
  if (!isRecord(json)) throw new Denied('The JSON body must be an object');
  return json;
}

/** Checks a `messages.send` against the recipient allowlist; returns the body to forward. */
function checkSend(request: ToolRequest, grant: Grant): { body: Buffer; detail: string } {
  const body = jsonBody(request);
  const extra = Object.keys(body).find((k) => !SEND_FIELDS.has(k));
  if (extra !== undefined) throw new Denied(`Field "${extra}" is not supported when sending`);
  if (typeof body.raw !== 'string') throw new Denied('"raw" must hold the message');
  if (body.threadId !== undefined && typeof body.threadId !== 'string') {
    throw new Denied('"threadId" must be a string');
  }
  const recipients = recipientsOf(body.raw);
  if (grant.resources.length > 0) {
    if (recipients.length === 0) throw new Denied('The message has no recipients');
    const outside = recipients.find((r) => !recipientAllowed(grant.resources, r));
    if (outside !== undefined) throw new Denied(`Recipient ${outside} is not in the allowlist`);
  }
  return {
    body: Buffer.from(JSON.stringify(body)),
    detail: `send to ${[...new Set(recipients)].join(', ')}`,
  };
}

function checkQuery(search: string): void {
  for (const name of new URLSearchParams(search).keys()) {
    if (DENIED_PARAMS.has(name)) throw new Denied(`Query parameter "${name}" is not allowed`);
  }
}

function authorizeRequest(request: ToolRequest, grant: Grant): AuthzDecision {
  const { segments } = request;
  if (!PREFIX.every((s, i) => segments[i] === s)) {
    throw new Denied(`Only /${PREFIX.join('/')}/… calls are supported`);
  }
  const rest = segments.slice(PREFIX.length);
  const method = request.method.toUpperCase();
  const rule = RULES.find((r) => r.method === method && matchPath(r.pattern, rest) !== null);
  const path = rest.join('/');
  if (!rule) throw new Denied(`${method} ${path} is not covered by any gateway permission`);
  if (rule.permission !== 'meta' && !grant.permissions.includes(rule.permission)) {
    throw new Denied(`Missing permission "${rule.permission}"`);
  }
  checkQuery(request.search);
  const detail = `${method} ${path}`;
  if (rule.send === 'draft' && grant.resources.length > 0) {
    throw new Denied('Sending a saved draft needs an unrestricted template: use messages/send');
  }
  if (rule.send === 'message') {
    return { allowed: true, permission: rule.permission, ...checkSend(request, grant) };
  }
  return { allowed: true, permission: rule.permission, detail };
}

function tokensOf(json: unknown, refreshToken?: string): Omit<OAuthTokens, 'identity'> {
  if (!isRecord(json) || typeof json.access_token !== 'string') {
    throw new Error('Unexpected answer from Google sign-in');
  }
  // Google only returns a refresh token on the first exchange; refreshes keep the old one.
  const refresh = typeof json.refresh_token === 'string' ? json.refresh_token : refreshToken;
  if (!refresh) throw new Error('Google returned no refresh token: sign in again');
  return {
    access: json.access_token,
    refresh,
    expiresInSeconds: typeof json.expires_in === 'number' ? json.expires_in : 0,
  };
}

async function profile(fetchImpl: typeof fetch, secret: string): Promise<Record<string, string>> {
  const res = await fetchImpl(`${API}/${PREFIX.join('/')}/profile`, {
    headers: { authorization: `Bearer ${secret}`, 'user-agent': USER_AGENT },
  });
  const json: unknown = res.ok ? await res.json() : null;
  if (!isRecord(json) || typeof json.emailAddress !== 'string') {
    throw new Error(`Gmail rejected the token (HTTP ${res.status})`);
  }
  const identity: Record<string, string> = { login: json.emailAddress };
  if (typeof json.messagesTotal === 'number') identity.messages = String(json.messagesTotal);
  return identity;
}

function googleSignIn(fetchImpl: typeof fetch, client: GmailOAuthClient): OAuthSignIn {
  const token = async (body: Record<string, string>, refreshToken?: string) => {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { [CONTENT_TYPE]: 'application/x-www-form-urlencoded', accept: JSON_TYPE },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        ...body,
      }).toString(),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error =
        isRecord(json) && typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
      throw new Error(`Google sign-in failed (${error})`);
    }
    const tokens = tokensOf(json, refreshToken);
    return { ...tokens, identity: await profile(fetchImpl, tokens.access) };
  };
  const redirectUri = client.redirectUri ?? LOOPBACK_REDIRECT_URI;
  return {
    help: client.redirectUri
      ? 'Opens Google to sign in to the Gmail account agents will use. After approving, Google sends you back to the gateway, which connects the account.'
      : 'Opens Google to sign in to the Gmail account agents will use. After approving, your browser lands on a 127.0.0.1 page that does not load: copy that page’s full address and paste it here.',
    redirectsBack: client.redirectUri !== undefined,
    authorizeUrl(challenge, state) {
      const params = new URLSearchParams({
        client_id: client.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent',
      });
      return `${AUTHORIZE_URL}?${params.toString()}`;
    },
    exchange: (code, _state, verifier) =>
      token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    refresh: (refreshToken) =>
      token({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken),
  };
}

export function createGmailProvider(
  fetchImpl: typeof fetch = fetch,
  oauthClient: GmailOAuthClient | null = null,
): ToolProvider {
  return {
    id: 'gmail',
    name: 'Gmail',
    credentialHelp:
      'Prefer "Sign in with Google" (available once Google sign-in or GMAIL_CLIENT_ID is configured): the gateway then refreshes the token itself. A pasted OAuth access token (ya29.…) works too, but Google expires it within an hour.',
    credentialPlaceholder: 'ya29.…',
    resourceHelp:
      'Who mail may be sent to: one address (ada@example.com) or domain (*@example.com) per line. Leave empty to allow any recipient. Reading, labels and drafts are not limited by it.',
    permissions: PERMISSIONS,
    upstreamBaseUrl: API,
    example: {
      method: 'GET',
      path: `/${PREFIX.join('/')}/messages?maxResults=10`,
      clientHint: 'e.g. googleapis rootUrl',
    },

    validateResource(pattern) {
      return RESOURCE_RE.test(pattern.toLowerCase())
        ? null
        : `Invalid recipient "${pattern}" (an address, or *@domain)`;
    },

    verifyCredential: (secret) => profile(fetchImpl, secret),

    authorize(request, grant): AuthzDecision {
      try {
        return authorizeRequest(request, grant);
      } catch (err) {
        if (err instanceof Denied) return { allowed: false, reason: err.message };
        throw err;
      }
    },

    upstreamHeaders(secret, incoming) {
      const headers = new Headers({
        accept: JSON_TYPE,
        'user-agent': USER_AGENT,
        authorization: `Bearer ${secret}`,
      });
      if (incoming.has(CONTENT_TYPE)) headers.set(CONTENT_TYPE, JSON_TYPE);
      return headers;
    },

    ...(oauthClient ? { oauthSignIn: googleSignIn(fetchImpl, oauthClient) } : {}),
  };
}
