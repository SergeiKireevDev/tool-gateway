import { z } from 'zod';
import type { ActivityLog } from './activity.js';
import { checkDomainPattern, MAX_EGRESS_DOMAINS } from './egress/domains.js';
import type { LlmUsageLog } from './llmUsage.js';
import { OAuthSignIns } from './oauthSignIns.js';
import {
  badGateway,
  badRequest,
  conflict,
  forbidden,
  HttpError,
  notFound,
  unauthorized,
  unprocessable,
} from './errors.js';
import { CryptoBox, randomId, randomToken } from './store/crypto.js';
import type { EncryptedStore } from './store/store.js';
import type {
  Account,
  Member,
  StoreState,
  Session,
  SessionGrant,
  SessionIssuer,
  Template,
  ToolGrant,
  WebSessionRole,
} from './store/types.js';
import type { ToolRegistry } from './tools/registry.js';
import { validateEndpointUrl } from './tools/llm/common.js';
import {
  LLM_ENDPOINT_APIS,
  type LlmEndpoint,
  type LlmEndpointApi,
  type OAuthTokens,
  type ToolProvider,
} from './tools/types.js';
import {
  MS_PER_DAY,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
} from './units.js';

export const SESSION_KEY_PREFIX = 'gws_';
export const ADMIN_TOKEN_PREFIX = 'gwa_';
export const WEB_SESSION_PREFIX = 'gwc_';
export const MEMBER_KEY_PREFIX = 'gwm_';
const WEB_SESSION_TTL_HOURS = 12;
export const WEB_SESSION_TTL_SECONDS = WEB_SESSION_TTL_HOURS * SECONDS_PER_HOUR;
const MIN_TTL = 60;
const MAX_TTL_DAYS = 7;
const MAX_TTL = MAX_TTL_DAYS * SECONDS_PER_DAY;
/** Expired/revoked sessions are kept this long for the UI, then pruned. */
const SESSION_RETENTION_DAYS = 7;
const SESSION_RETENTION_MS = SESSION_RETENTION_DAYS * MS_PER_DAY;

// Input limits
const MAX_LABEL_LENGTH = 100;
const MAX_SECRET_LENGTH = 4096;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CLIENT_ID_LENGTH = 100;
const MAX_SCOPES_LENGTH = 300;
const MAX_ACCOUNTS_PER_SESSION = 20;
const MAX_TOKEN_BUDGET = 1e10;
const TOKEN_REFRESH_MARGIN_MINUTES = 5;
const TOKEN_REFRESH_MARGIN_MS = TOKEN_REFRESH_MARGIN_MINUTES * MS_PER_MINUTE;

/** Non-secret key prefix shown in the UI to tell keys apart. */
const KEY_HINT_CHARS = 6;
/** Trailing characters of a stored credential shown in the UI. */
const SECRET_HINT_CHARS = 4;
const DEVICE_FLOW_ID_BYTES = 16;

const ACCOUNT_NOT_FOUND = 'Account not found';
const TEMPLATE_NOT_FOUND = 'Template not found';
const MEMBER_NOT_FOUND = 'Member not found';
const SESSION_NOT_FOUND = 'Session not found';
const MEMBER_NOT_VALID = 'Member is no longer valid';
const TEMPLATE_NOT_AVAILABLE = 'This template is not available to you';
const MEMBER_KEY_ROTATED = 'Member key was rotated';
const ADMIN_ISSUER: SessionIssuer = { kind: 'admin' };

const ttl = z.number().int().min(MIN_TTL).max(MAX_TTL);

export const accountCreateSchema = z.object({
  tool: z.string().min(1),
  label: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
  secret: z.string().trim().min(1).max(MAX_SECRET_LENGTH),
});

export const accountUpdateSchema = z.object({
  label: z.string().trim().min(1).max(MAX_LABEL_LENGTH).optional(),
  secret: z.string().trim().min(1).max(MAX_SECRET_LENGTH).optional(),
});

export const toolGrantSchema = z.object({
  tool: z.string().min(1),
  permissions: z.array(z.string()).min(1, 'Select at least one permission'),
  resources: z.array(z.string().trim()).default([]),
  /** Tools configured per grant (custom LLM endpoints). No `token` keeps the current one. */
  endpoint: z
    .object({
      url: z.string().trim().min(1, 'Enter the endpoint URL').max(MAX_SECRET_LENGTH),
      api: z.enum(LLM_ENDPOINT_APIS),
      token: z.string().trim().max(MAX_SECRET_LENGTH).optional(),
    })
    .optional(),
});

export const templateSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
    description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).default(''),
    /** One entry per tool the template covers. */
    grants: z.array(toolGrantSchema).min(1, 'Grant access to at least one tool'),
    /** HTTPS domains launched agents may reach directly (see `egress/domains.ts`). */
    egressDomains: z.array(z.string()).max(MAX_EGRESS_DOMAINS).default([]),
    defaultTtlSeconds: ttl,
    maxTtlSeconds: ttl,
  })
  .refine((t) => t.defaultTtlSeconds <= t.maxTtlSeconds, {
    message: 'Default TTL must not exceed max TTL',
    path: ['defaultTtlSeconds'],
  })
  .refine((t) => new Set(t.grants.map((g) => g.tool)).size === t.grants.length, {
    message: 'Each tool can only appear once in a template',
    path: ['grants'],
  });

export const sessionRequestSchema = z.object({
  templateId: z.string().min(1),
  /** At most one account per tool of the template; omitted tools use the only usable account. */
  accountIds: z.array(z.string().min(1)).max(MAX_ACCOUNTS_PER_SESSION).default([]),
  /** Single-account form kept for existing clients: same as `accountIds: [accountId]`. */
  accountId: z.string().min(1).optional(),
  ttlSeconds: ttl.optional(),
  label: z.string().trim().max(MAX_LABEL_LENGTH).optional(),
  /** Most LLM tokens (input + output + cache) the key may use; absent = no budget. */
  tokenBudget: z.number().int().min(1).max(MAX_TOKEN_BUDGET).optional(),
});

const idList = z.array(z.string().min(1)).min(1);

export const memberSchema = z.object({
  name: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
  /** Google account the member signs in to the member portal with; null = key-only member. */
  email: z.string().trim().toLowerCase().pipe(z.email()).nullable().default(null),
  templateIds: idList,
  /** Shared accounts granted to the member (its own accounts are always usable). */
  accountIds: z.array(z.string().min(1)).default([]),
  /** ISO date-time, or null for a key that never expires. */
  expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
});

export const toolSettingsSchema = z.object({
  oauthClientId: z
    .string()
    .trim()
    .max(MAX_CLIENT_ID_LENGTH)
    .regex(/^[A-Za-z0-9._-]*$/, 'Invalid client ID'),
});

export const deviceFlowStartSchema = z.object({
  tool: z.string().min(1),
  label: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
  scopes: z
    .string()
    .trim()
    .max(MAX_SCOPES_LENGTH)
    .regex(/^[A-Za-z0-9:_ -]*$/, 'Invalid scopes')
    .optional(),
});

/** Device flows in progress. The device code stays server-side; the browser only gets a flow id. */
interface PendingDeviceFlow {
  /** Member who started it (the account will be theirs), or null for the admin. */
  ownerMemberId: string | null;
  tool: string;
  label: string;
  clientId: string;
  deviceCode: string;
  intervalMs: number;
  nextPollAt: number;
  expiresAt: number;
  polling: boolean;
}

export type DeviceFlowStatus =
  | { status: 'pending' }
  | { status: 'complete'; account: PublicAccount }
  | { status: 'failed'; message: string };

/** Who is acting: the admin, or a member (member portal or member key). */
export type Actor = { kind: 'admin' } | { kind: 'member'; member: Member };
export const ADMIN: Actor = { kind: 'admin' };

export type AccountOwner =
  { kind: 'shared' } | { kind: 'member'; memberId: string; memberName: string };
export type PublicAccount = Omit<Account, 'secret' | 'ownerMemberId' | 'oauth'> & {
  /** `tool` (GitHub, Slack…) or `llm` (a model provider: Anthropic, OpenAI, Gemini). */
  kind: 'tool' | 'llm';
  secretHint: string;
  /** Connected through an OAuth sign-in (refreshed by the gateway) rather than a pasted token. */
  signedIn: boolean;
  owner: AccountOwner;
};

/** Identity behind a browser session (Google sign-in). */
export type WebIdentity =
  { role: 'admin'; email: string } | { role: 'member'; email: string; member: Member };
export type SessionStatus = 'active' | 'expired' | 'revoked';

/** A grant's endpoint as the API shows it: never its token. */
export interface PublicEndpoint {
  url: string;
  api: LlmEndpointApi;
  hasToken: boolean;
}
export type PublicGrant<G extends ToolGrant = ToolGrant> = Omit<G, 'endpoint'> & {
  endpoint?: PublicEndpoint;
};
export type PublicTemplate = Omit<Template, 'grants'> & { grants: PublicGrant[] };

export type PublicSession = Omit<Session, 'keyHash' | 'issuedBy' | 'grants'> & {
  grants: PublicGrant<SessionGrant>[];
  status: SessionStatus;
  issuedBy: SessionIssuer;
};
export type PublicMember = Omit<Member, 'keyHash' | 'email'> & {
  email: string | null;
  activeSessions: number;
  ownAccounts: number;
  expired: boolean;
};

/** What a member sees about itself: the templates and accounts it may request keys for. */
export interface MemberView {
  id: string;
  name: string;
  email: string | null;
  keyHint: string;
  expiresAt: string | null;
  templates: Pick<
    PublicTemplate,
    'id' | 'name' | 'description' | 'grants' | 'defaultTtlSeconds' | 'maxTtlSeconds'
  >[];
  accounts: {
    id: string;
    tool: string;
    label: string;
    login: string | undefined;
    owned: boolean;
  }[];
}

export interface ToolCatalogEntry {
  id: string;
  name: string;
  kind: 'tool' | 'llm';
  /** Present when the tool offers "Sign in with …" through OAuth. */
  oauthSignIn: { help: string } | null;
  credentialHelp: string;
  credentialPlaceholder: string;
  resourceHelp: string;
  permissions: ToolProvider['permissions'];
  example: ToolProvider['example'];
  /** Chat APIs a per-grant endpoint may speak, for tools configured in templates; else null. */
  endpointApis: readonly LlmEndpointApi[] | null;
  signIn: {
    setupHelp: string;
    registerUrl: string;
    defaultScopes: string;
    /** Button label, e.g. "Sign in with ChatGPT". */
    label: string;
    /** The tool's public client ID is built in: there is no OAuth app to set up. */
    builtIn: boolean;
    oauthClientId: string;
  } | null;
}

/** A template grant with the account chosen for it at issuance. */
/**
 * Which of a template's tools an agent run's key covers: `drop` grants are left out (model APIs
 * the harness can't use), and so are endpoint grants whose chat API is not in `endpointApis`;
 * `optional` grants are left out when no account is available for them.
 */
export interface RunToolScope {
  drop: readonly string[];
  optional: readonly string[];
  endpointApis: readonly LlmEndpointApi[];
}

interface BoundGrant {
  grant: ToolGrant;
  /** Null for grants that carry their own endpoint. */
  account: Account | null;
}

export interface ResolvedGrant {
  grant: SessionGrant;
  /** For endpoint grants, a stand-in holding the endpoint's token as its secret. */
  account: Account;
  tool: ToolProvider;
}

export class Gateway {
  private readonly usage = new Map<string, { lastUsedAt: string; count: number }>();
  private readonly deviceFlows = new Map<string, PendingDeviceFlow>();
  private readonly refreshing = new Map<string, Promise<Account>>();
  /** "Sign in with …" flows (OAuth) in progress. */
  readonly signIns: OAuthSignIns;
  /** Google accounts that sign in as admin; they can't also be member emails. */
  private adminEmails: readonly string[] = [];

  constructor(
    private readonly store: EncryptedStore,
    private readonly crypto: CryptoBox,
    readonly tools: ToolRegistry,
    readonly activity: ActivityLog,
    readonly llmUsage: LlmUsageLog,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.signIns = new OAuthSignIns(this, now);
  }

  setAdminEmails(emails: readonly string[]): void {
    this.adminEmails = emails.map((e) => e.toLowerCase());
  }

  // ---------------------------------------------------------------- admin token

  hasAdminToken(): boolean {
    return this.store.read().adminTokenHash !== null;
  }

  /** Generates a new admin token, replacing any previous one. Returns the plaintext once. */
  async rotateAdminToken(): Promise<string> {
    const token = randomToken(ADMIN_TOKEN_PREFIX);
    await this.store.update((s) => {
      s.adminTokenHash = this.crypto.hashToken(token);
    });
    return token;
  }

  verifyAdminToken(token: string): boolean {
    const hash = this.store.read().adminTokenHash;
    return hash !== null && CryptoBox.equalHex(this.crypto.hashToken(token), hash);
  }

  // ---------------------------------------------------------------- web sessions (Google sign-in)

  /** Which role a verified Google email signs in as, or null if it isn't allowed. */
  identify(email: string): WebIdentity | null {
    const normalized = email.toLowerCase();
    if (this.adminEmails.includes(normalized)) return { role: 'admin', email: normalized };
    const member = this.store.read().members.find((m) => m.email === normalized);
    return member && !this.memberExpired(member)
      ? { role: 'member', email: normalized, member }
      : null;
  }

  /** Starts a browser session. Returns the cookie value. */
  async createWebSession(identity: WebIdentity): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken(WEB_SESSION_PREFIX);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + WEB_SESSION_TTL_SECONDS * MS_PER_SECOND);
    const role: WebSessionRole = identity.role;
    await this.store.update((s) => {
      s.webSessions = s.webSessions.filter((x) => Date.parse(x.expiresAt) > now.getTime());
      s.webSessions.push({
        id: randomId(),
        tokenHash: this.crypto.hashToken(token),
        role,
        email: identity.email,
        memberId: identity.role === 'member' ? identity.member.id : null,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
    });
    this.activity.add({
      kind: role,
      detail:
        identity.role === 'member'
          ? `Member "${identity.member.name}" signed in (${identity.email})`
          : `Admin signed in: ${identity.email}`,
    });
    return { token, expiresAt };
  }

  /**
   * Resolves a session cookie. Member sessions end as soon as the member is deleted, expires or
   * gets a different email; admin sessions end if the email is removed from the admin list.
   */
  resolveWebSession(token: string): (WebIdentity & { expiresAt: string }) | null {
    if (!token.startsWith(WEB_SESSION_PREFIX)) return null;
    const hash = this.crypto.hashToken(token);
    const session = this.store
      .read()
      .webSessions.find((s) => CryptoBox.equalHex(s.tokenHash, hash));
    if (!session || Date.parse(session.expiresAt) <= this.now().getTime()) return null;
    const identity = this.identify(session.email);
    if (identity?.role !== session.role) return null;
    if (identity.role === 'member' && identity.member.id !== session.memberId) return null;
    return { ...identity, expiresAt: session.expiresAt };
  }

  async endWebSession(token: string): Promise<void> {
    const hash = this.crypto.hashToken(token);
    await this.store.update((s) => {
      s.webSessions = s.webSessions.filter((x) => !CryptoBox.equalHex(x.tokenHash, hash));
    });
  }

  // ---------------------------------------------------------------- accounts

  private tool(id: string): ToolProvider {
    const tool = this.tools.get(id);
    if (!tool) throw badRequest(`Unknown tool "${id}"`);
    return tool;
  }

  /** Admin view: every account, shared or member-owned. */
  listAccounts(): PublicAccount[] {
    return this.store.read().accounts.map((a) => this.toPublicAccount(a));
  }

  /** Accounts a member can use: its own plus the shared accounts granted to it. */
  listAccountsFor(member: Member): PublicAccount[] {
    return this.usableAccounts({ kind: 'member', member }).map((a) => this.toPublicAccount(a));
  }

  async createAccount(input: unknown, actor: Actor = ADMIN): Promise<PublicAccount> {
    const data = accountCreateSchema.parse(input);
    return this.addAccount(this.tool(data.tool), data.label, data.secret, 'token', actor);
  }

  private async addAccount(
    tool: ToolProvider,
    label: string,
    secret: string,
    method: 'token' | 'device-flow',
    actor: Actor,
  ): Promise<PublicAccount> {
    const identity = await this.verify(tool, secret);
    identity.connectedVia = method === 'token' ? 'pasted token' : `${tool.name} sign-in`;
    const ts = this.now().toISOString();
    const account: Account = {
      id: randomId(),
      tool: tool.id,
      label,
      secret,
      identity,
      createdAt: ts,
      lastVerifiedAt: ts,
      ownerMemberId: actor.kind === 'member' ? actor.member.id : null,
    };
    await this.store.update((s) => {
      s.accounts.push(account);
    });
    this.activity.add({
      kind: actor.kind,
      tool: tool.id,
      detail: `${actorName(actor)} connected account "${label}"`,
    });
    return this.toPublicAccount(account);
  }

  // ---------------------------------------------------------------- tool settings & sign-in

  /** Tools with their permission catalog and sign-in settings, for the UI. */
  toolCatalog(): ToolCatalogEntry[] {
    return this.tools.list().map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind ?? 'tool',
      oauthSignIn: t.oauthSignIn ? { help: t.oauthSignIn.help } : null,
      credentialHelp: t.credentialHelp,
      credentialPlaceholder: t.credentialPlaceholder,
      resourceHelp: t.resourceHelp,
      permissions: t.permissions,
      example: t.example,
      endpointApis: t.bindEndpoint ? LLM_ENDPOINT_APIS : null,
      signIn: t.deviceFlow
        ? {
            setupHelp: t.deviceFlow.setupHelp,
            registerUrl: t.deviceFlow.registerUrl,
            defaultScopes: t.deviceFlow.defaultScopes,
            label: t.deviceFlow.label ?? `Sign in with ${t.name}`,
            builtIn: t.deviceFlow.builtInClientId !== undefined,
            oauthClientId: t.deviceFlow.builtInClientId ?? this.toolSettings(t.id).oauthClientId,
          }
        : null,
    }));
  }

  toolSettings(toolId: string): { oauthClientId: string } {
    return { oauthClientId: this.store.read().toolSettings[toolId]?.oauthClientId ?? '' };
  }

  async updateToolSettings(toolId: string, input: unknown): Promise<{ oauthClientId: string }> {
    const tool = this.tool(toolId);
    const data = toolSettingsSchema.parse(input);
    await this.store.update((s) => {
      s.toolSettings[tool.id] = { ...s.toolSettings[tool.id], oauthClientId: data.oauthClientId };
    });
    this.activity.add({ kind: 'admin', tool: tool.id, detail: 'Updated OAuth client settings' });
    return this.toolSettings(tool.id);
  }

  async startDeviceFlow(
    input: unknown,
    actor: Actor = ADMIN,
  ): Promise<{
    flowId: string;
    userCode: string;
    verificationUri: string;
    expiresAt: string;
    intervalSeconds: number;
  }> {
    const data = deviceFlowStartSchema.parse(input);
    const tool = this.tool(data.tool);
    if (!tool.deviceFlow) throw badRequest(`${tool.name} does not support sign-in`);
    const clientId = tool.deviceFlow.builtInClientId ?? this.toolSettings(tool.id).oauthClientId;
    if (!clientId) throw badRequest(`Configure a ${tool.name} OAuth client ID first`);

    let auth;
    try {
      auth = await tool.deviceFlow.start(clientId, data.scopes ?? tool.deviceFlow.defaultScopes);
    } catch (err) {
      throw badGateway(`Could not start sign-in: ${(err as Error).message}`);
    }
    this.pruneDeviceFlows();
    const now = this.now().getTime();
    const flowId = randomToken('', DEVICE_FLOW_ID_BYTES);
    this.deviceFlows.set(flowId, {
      ownerMemberId: memberIdOf(actor),
      tool: tool.id,
      label: data.label,
      clientId,
      deviceCode: auth.deviceCode,
      intervalMs: auth.interval * MS_PER_SECOND,
      nextPollAt: now + auth.interval * MS_PER_SECOND,
      expiresAt: now + auth.expiresIn * MS_PER_SECOND,
      polling: false,
    });
    return {
      flowId,
      userCode: auth.userCode,
      verificationUri: auth.verificationUri,
      expiresAt: new Date(now + auth.expiresIn * MS_PER_SECOND).toISOString(),
      intervalSeconds: auth.interval,
    };
  }

  /**
   * Called repeatedly by the UI. Hits the tool at most once per the interval it mandates,
   * and connects the account once the user has approved the sign-in.
   */
  async pollDeviceFlow(flowId: string, actor: Actor = ADMIN): Promise<DeviceFlowStatus> {
    const flow = this.deviceFlow(flowId, actor);
    if (!flow) return { status: 'failed', message: 'Unknown or finished sign-in, start again' };
    const now = this.now().getTime();
    if (now >= flow.expiresAt) {
      this.deviceFlows.delete(flowId);
      return { status: 'failed', message: 'The code expired before it was approved' };
    }
    if (flow.polling || now < flow.nextPollAt) return { status: 'pending' };

    const tool = this.tool(flow.tool);
    if (!tool.deviceFlow) throw badRequest(`${tool.name} does not support sign-in`);
    flow.polling = true;
    try {
      const result = await tool.deviceFlow.poll(flow.clientId, flow.deviceCode);
      switch (result.status) {
        case 'pending':
          flow.nextPollAt = this.now().getTime() + flow.intervalMs;
          return { status: 'pending' };
        case 'slow_down':
          flow.intervalMs = result.interval * MS_PER_SECOND;
          flow.nextPollAt = this.now().getTime() + flow.intervalMs;
          return { status: 'pending' };
        case 'failed':
          this.deviceFlows.delete(flowId);
          return result;
        case 'complete': {
          this.deviceFlows.delete(flowId);
          const account = result.tokens
            ? await this.addOAuthAccount(tool.id, flow.label, result.tokens, actor)
            : await this.addAccount(tool, flow.label, result.secret, 'device-flow', actor);
          return { status: 'complete', account };
        }
      }
    } catch (err) {
      if (err instanceof HttpError) {
        this.deviceFlows.delete(flowId);
        return { status: 'failed', message: err.message };
      }
      // Transient network error: keep the flow alive and retry on the next poll.
      flow.nextPollAt = this.now().getTime() + flow.intervalMs;
      return { status: 'pending' };
    } finally {
      flow.polling = false;
    }
  }

  cancelDeviceFlow(flowId: string, actor: Actor = ADMIN): void {
    if (this.deviceFlow(flowId, actor)) this.deviceFlows.delete(flowId);
  }

  /** A device flow can only be polled or cancelled by whoever started it. */
  private deviceFlow(flowId: string, actor: Actor): PendingDeviceFlow | undefined {
    const flow = this.deviceFlows.get(flowId);
    return flow?.ownerMemberId === memberIdOf(actor) ? flow : undefined;
  }

  private pruneDeviceFlows(): void {
    const now = this.now().getTime();
    for (const [id, flow] of this.deviceFlows) {
      if (now >= flow.expiresAt) this.deviceFlows.delete(id);
    }
  }

  /** Relabel an account or rotate its token. The admin only manages shared accounts this way. */
  async updateAccount(id: string, input: unknown, actor: Actor = ADMIN): Promise<PublicAccount> {
    const data = accountUpdateSchema.parse(input);
    const existing = this.accountFor(actor, id, 'manage');
    const patch: Partial<Account> = {};
    if (data.label) patch.label = data.label;
    if (data.secret) {
      patch.secret = data.secret;
      patch.oauth = null;
      patch.identity = await this.verify(this.tool(existing.tool), data.secret);
      patch.lastVerifiedAt = this.now().toISOString();
    }
    const updated = await this.store.update((s) => {
      const acc = s.accounts.find((a) => a.id === id);
      if (!acc) throw notFound(ACCOUNT_NOT_FOUND);
      Object.assign(acc, patch);
      return acc;
    });
    this.activity.add({
      kind: actor.kind,
      tool: updated.tool,
      detail: `${actorName(actor)} updated account "${updated.label}"`,
    });
    return this.toPublicAccount(updated);
  }

  async reverifyAccount(id: string, actor: Actor = ADMIN): Promise<PublicAccount> {
    const acc = this.accountFor(actor, id, 'oversee');
    if (acc.oauth) return this.toPublicAccount(await this.freshAccount(acc, true));
    const identity = await this.verify(this.tool(acc.tool), acc.secret);
    const updated = await this.store.update((s) => {
      const a = s.accounts.find((x) => x.id === id);
      if (!a) throw notFound(ACCOUNT_NOT_FOUND);
      a.identity = identity;
      a.lastVerifiedAt = this.now().toISOString();
      return a;
    });
    return this.toPublicAccount(updated);
  }

  /** Connects an account from an OAuth sign-in (its access token is refreshed by the gateway). */
  async addOAuthAccount(
    toolId: string,
    label: string,
    tokens: OAuthTokens,
    actor: Actor,
  ): Promise<PublicAccount> {
    const tool = this.tool(toolId);
    const ts = this.now().toISOString();
    const account: Account = {
      id: randomId(),
      tool: tool.id,
      label,
      secret: tokens.access,
      oauth: { refreshToken: tokens.refresh, expiresAt: this.tokenExpiry(tokens) },
      identity: { ...tokens.identity, connectedVia: `${tool.name} sign-in` },
      createdAt: ts,
      lastVerifiedAt: ts,
      ownerMemberId: actor.kind === 'member' ? actor.member.id : null,
    };
    await this.store.update((s) => {
      s.accounts.push(account);
    });
    this.activity.add({
      kind: actor.kind,
      tool: tool.id,
      detail: `${actorName(actor)} signed in to ${tool.name} as account "${label}"`,
    });
    return this.toPublicAccount(account);
  }

  /**
   * The account with a usable credential: OAuth access tokens are refreshed shortly before they
   * expire (once at a time per account; refresh tokens are single-use).
   */
  async freshAccount(account: Account, force = false): Promise<Account> {
    const { oauth } = account;
    if (!oauth) return account;
    if (!force && Date.parse(oauth.expiresAt) > this.now().getTime()) return account;
    const pending = this.refreshing.get(account.id);
    if (pending) return pending;
    const refresh = this.refreshAccount(account, oauth.refreshToken).finally(() => {
      this.refreshing.delete(account.id);
    });
    this.refreshing.set(account.id, refresh);
    return refresh;
  }

  /** When to refresh an access token: a few minutes before it really expires. */
  private tokenExpiry(tokens: OAuthTokens): string {
    const lifetimeMs = tokens.expiresInSeconds * MS_PER_SECOND - TOKEN_REFRESH_MARGIN_MS;
    return new Date(this.now().getTime() + Math.max(0, lifetimeMs)).toISOString();
  }

  private async refreshAccount(account: Account, refreshToken: string): Promise<Account> {
    const tool = this.tool(account.tool);
    const refresher = tool.oauthSignIn ?? tool.deviceFlow;
    if (!refresher?.refresh) throw unauthorized('This account can no longer be refreshed');
    let tokens: OAuthTokens;
    try {
      tokens = await refresher.refresh(refreshToken);
    } catch (err) {
      throw badGateway(
        `Could not refresh "${account.label}": ${(err as Error).message}. Sign in again.`,
      );
    }
    return this.store.update((s) => {
      const acc = s.accounts.find((a) => a.id === account.id);
      if (!acc) throw unauthorized('Account behind this session was removed');
      acc.secret = tokens.access;
      acc.oauth = { refreshToken: tokens.refresh, expiresAt: this.tokenExpiry(tokens) };
      acc.lastVerifiedAt = this.now().toISOString();
      return acc;
    });
  }

  /** Members remove their own accounts; the admin can remove any account. */
  async deleteAccount(id: string, actor: Actor = ADMIN): Promise<void> {
    const acc = this.accountFor(actor, id, 'oversee');
    const revoked = await this.store.update((s) => {
      s.accounts = s.accounts.filter((a) => a.id !== id);
      for (const m of s.members) m.accountIds = m.accountIds.filter((x) => x !== id);
      return this.revokeWhere(s.sessions, (x) => usesAccount(x, (a) => a === id));
    });
    this.activity.add({
      kind: actor.kind,
      tool: acc.tool,
      detail: `${actorName(actor)} removed account "${acc.label}" (revoked ${revoked} session(s))`,
    });
  }

  /**
   * Looks up an account the actor may act on. Members only ever see their own accounts (others
   * are "not found"). The admin may oversee (re-verify, remove) member accounts, but only
   * manages (relabels, rotates tokens of) shared ones.
   */
  private accountFor(actor: Actor, id: string, purpose: 'manage' | 'oversee'): Account {
    const acc = this.store.read().accounts.find((a) => a.id === id);
    if (actor.kind === 'member') {
      if (acc?.ownerMemberId !== actor.member.id) throw notFound(ACCOUNT_NOT_FOUND);
      return acc;
    }
    if (!acc) throw notFound(ACCOUNT_NOT_FOUND);
    if (purpose === 'manage' && !isShared(acc)) {
      throw forbidden('This account belongs to a member; only they can change it');
    }
    return acc;
  }

  private async verify(tool: ToolProvider, secret: string): Promise<Record<string, string>> {
    try {
      return await tool.verifyCredential(secret);
    } catch (err) {
      throw unprocessable(`Could not verify credential: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- templates

  listTemplates(): PublicTemplate[] {
    return this.store.read().templates.map(publicTemplate);
  }

  /** `previous`: the template being edited, whose endpoint tokens are kept unless replaced. */
  private validateTemplate(
    input: unknown,
    previous?: Template,
  ): Omit<z.infer<typeof templateSchema>, 'grants'> & { grants: ToolGrant[] } {
    const data = templateSchema.parse(input);
    const egressDomains = data.egressDomains.map((d) => {
      const checked = checkDomainPattern(d);
      if ('error' in checked) throw badRequest(checked.error);
      return checked.pattern;
    });
    return {
      ...data,
      grants: data.grants.map((g) =>
        this.validateGrant(g, previous?.grants.find((p) => p.tool === g.tool)?.endpoint),
      ),
      egressDomains: [...new Set(egressDomains)],
    };
  }

  private validateGrant(
    grant: z.infer<typeof toolGrantSchema>,
    previousEndpoint: LlmEndpoint | undefined,
  ): ToolGrant {
    const tool = this.tool(grant.tool);
    const known = new Set(tool.permissions.map((p) => p.id));
    const unknown = grant.permissions.filter((p) => !known.has(p));
    if (unknown.length) {
      throw badRequest(`Unknown ${tool.name} permission(s): ${unknown.join(', ')}`);
    }
    const resources = [...new Set(grant.resources.filter(Boolean))];
    for (const r of resources) {
      const err = tool.validateResource(r);
      if (err) throw badRequest(`${tool.name}: ${err}`);
    }
    const endpoint = validateEndpoint(tool, grant.endpoint, previousEndpoint);
    return {
      tool: tool.id,
      permissions: [...new Set(grant.permissions)],
      resources,
      ...(endpoint && { endpoint }),
    };
  }

  async createTemplate(input: unknown): Promise<PublicTemplate> {
    const data = this.validateTemplate(input);
    const ts = this.now().toISOString();
    const template: Template = { id: randomId(), ...data, createdAt: ts, updatedAt: ts };
    await this.store.update((s) => {
      if (s.templates.some((t) => t.name.toLowerCase() === data.name.toLowerCase())) {
        throw conflict(`A template named "${data.name}" already exists`);
      }
      s.templates.push(template);
    });
    this.activity.add({
      kind: 'admin',
      tool: toolsOf(template),
      detail: `Created template "${data.name}"`,
    });
    return publicTemplate(template);
  }

  async updateTemplate(id: string, input: unknown): Promise<PublicTemplate> {
    const previous = this.store.read().templates.find((x) => x.id === id);
    if (!previous) throw notFound(TEMPLATE_NOT_FOUND);
    const data = this.validateTemplate(input, previous);
    const updated = await this.store.update((s) => {
      const t = s.templates.find((x) => x.id === id);
      if (!t) throw notFound(TEMPLATE_NOT_FOUND);
      const clash = s.templates.some(
        (x) => x.id !== id && x.name.toLowerCase() === data.name.toLowerCase(),
      );
      if (clash) throw conflict(`A template named "${data.name}" already exists`);
      Object.assign(t, data, { updatedAt: this.now().toISOString() });
      return t;
    });
    this.activity.add({
      kind: 'admin',
      tool: toolsOf(updated),
      detail: `Updated template "${data.name}"`,
    });
    return publicTemplate(updated);
  }

  async deleteTemplate(id: string): Promise<void> {
    const tpl = this.store.read().templates.find((t) => t.id === id);
    if (!tpl) throw notFound(TEMPLATE_NOT_FOUND);
    const revoked = await this.store.update((s) => {
      s.templates = s.templates.filter((t) => t.id !== id);
      for (const m of s.members) m.templateIds = m.templateIds.filter((x) => x !== id);
      return this.revokeWhere(s.sessions, (x) => x.templateId === id);
    });
    this.activity.add({
      kind: 'admin',
      tool: toolsOf(tpl),
      detail: `Deleted template "${tpl.name}" (revoked ${revoked} session(s))`,
    });
  }

  // ---------------------------------------------------------------- members

  listMembers(): PublicMember[] {
    return this.store.read().members.map((m) => this.toPublicMember(m));
  }

  /** Creates a member. The plaintext member key is returned exactly once. */
  async createMember(input: unknown): Promise<{ key: string; member: PublicMember }> {
    const data = this.validateMember(input);
    const key = randomToken(MEMBER_KEY_PREFIX);
    const ts = this.now().toISOString();
    const member: Member = {
      id: randomId(),
      name: data.name,
      email: data.email,
      keyHash: this.crypto.hashToken(key),
      keyHint: key.slice(0, MEMBER_KEY_PREFIX.length + KEY_HINT_CHARS),
      keyGeneration: 0,
      templateIds: data.templateIds,
      accountIds: data.accountIds,
      createdAt: ts,
      updatedAt: ts,
      expiresAt: data.expiresAt,
      lastUsedAt: null,
    };
    await this.store.update((s) => {
      if (s.members.some((m) => m.name.toLowerCase() === data.name.toLowerCase())) {
        throw conflict(`A member named "${data.name}" already exists`);
      }
      s.members.push(member);
    });
    this.activity.add({ kind: 'admin', detail: `Created member "${member.name}"` });
    return { key, member: this.toPublicMember(member) };
  }

  /** Updates a member's name, allowlists or expiry. Its key and issued sessions are kept. */
  async updateMember(id: string, input: unknown): Promise<PublicMember> {
    const data = this.validateMember(input, id);
    const updated = await this.store.update((s) => {
      const member = s.members.find((m) => m.id === id);
      if (!member) throw notFound(MEMBER_NOT_FOUND);
      const clash = s.members.some(
        (m) => m.id !== id && m.name.toLowerCase() === data.name.toLowerCase(),
      );
      if (clash) throw conflict(`A member named "${data.name}" already exists`);
      Object.assign(member, data, { updatedAt: this.now().toISOString() });
      return member;
    });
    this.activity.add({ kind: 'admin', detail: `Updated member "${updated.name}"` });
    return this.toPublicMember(updated);
  }

  /**
   * Replaces a member's key (e.g. after a leak). Session keys it issued are revoked, since
   * whoever held the old key may have minted them.
   */
  async rotateMemberKey(
    id: string,
    actor: Actor = ADMIN,
  ): Promise<{ key: string; member: PublicMember }> {
    const key = randomToken(MEMBER_KEY_PREFIX);
    const [member, revoked] = await this.store.update((s) => {
      const m = s.members.find((x) => x.id === id);
      if (!m) throw notFound(MEMBER_NOT_FOUND);
      m.keyHash = this.crypto.hashToken(key);
      m.keyHint = key.slice(0, MEMBER_KEY_PREFIX.length + KEY_HINT_CHARS);
      m.keyGeneration += 1;
      m.updatedAt = this.now().toISOString();
      return [m, this.revokeWhere(s.sessions, (x) => issuedByMember(x, id))] as const;
    });
    this.activity.add({
      kind: actor.kind,
      detail: `${actorName(actor)} rotated the key of member "${member.name}" (revoked ${revoked} session(s))`,
    });
    return { key, member: this.toPublicMember(member) };
  }

  /** Deletes a member together with the accounts it connected; revokes every key it could use. */
  async deleteMember(id: string): Promise<void> {
    const [member, revoked, removedAccounts] = await this.store.update((s) => {
      const m = s.members.find((x) => x.id === id);
      if (!m) throw notFound(MEMBER_NOT_FOUND);
      const owned = new Set(s.accounts.filter((a) => a.ownerMemberId === id).map((a) => a.id));
      s.members = s.members.filter((x) => x.id !== id);
      s.accounts = s.accounts.filter((a) => !owned.has(a.id));
      s.webSessions = s.webSessions.filter((w) => w.memberId !== id);
      const n = this.revokeWhere(
        s.sessions,
        (x) => issuedByMember(x, id) || usesAccount(x, (a) => owned.has(a)),
      );
      return [m, n, owned.size] as const;
    });
    this.activity.add({
      kind: 'admin',
      detail: `Deleted member "${member.name}" and its ${removedAccounts} account(s) (revoked ${revoked} session(s))`,
    });
  }

  /** Resolves a presented member key; throws 401 otherwise. */
  resolveMember(key: string): Member {
    if (!key.startsWith(MEMBER_KEY_PREFIX)) throw unauthorized('Member key required');
    const hash = this.crypto.hashToken(key);
    const member = this.store.read().members.find((m) => CryptoBox.equalHex(m.keyHash, hash));
    if (!member) throw unauthorized('Invalid member key');
    if (this.memberExpired(member)) throw unauthorized('Member key has expired');
    return member;
  }

  memberView(member: Member): MemberView {
    const state = this.store.read();
    return {
      id: member.id,
      name: member.name,
      email: member.email ?? null,
      keyHint: member.keyHint,
      expiresAt: member.expiresAt,
      templates: state.templates
        .filter((t) => member.templateIds.includes(t.id))
        .map(({ id, name, description, grants, defaultTtlSeconds, maxTtlSeconds }) => ({
          id,
          name,
          description,
          grants: grants.map(publicGrant),
          defaultTtlSeconds,
          maxTtlSeconds,
        })),
      accounts: this.usableAccounts({ kind: 'member', member }).map((a) => ({
        id: a.id,
        tool: a.tool,
        label: a.label,
        login: a.identity.login,
        owned: a.ownerMemberId === member.id,
      })),
    };
  }

  /** Session keys issued by a member, or by the launchpad for its runs. */
  listMemberSessions(member: Member): PublicSession[] {
    return this.listSessions().filter(
      (s) => s.issuedBy.kind !== 'admin' && s.issuedBy.memberId === member.id,
    );
  }

  /** A member may only revoke session keys it issued itself. */
  async revokeMemberSession(member: Member, sessionId: string): Promise<PublicSession> {
    const own = this.store
      .read()
      .sessions.some((s) => s.id === sessionId && issuedByMember(s, member.id));
    if (!own) throw notFound(SESSION_NOT_FOUND);
    return this.revokeSession(sessionId, {
      kind: 'member',
      memberId: member.id,
      memberName: member.name,
    });
  }

  private validateMember(input: unknown, selfId?: string): z.infer<typeof memberSchema> {
    const data = memberSchema.parse(input);
    const state = this.store.read();
    const unknownTemplates = data.templateIds.filter(
      (id) => !state.templates.some((t) => t.id === id),
    );
    if (unknownTemplates.length) {
      throw badRequest(`Unknown template(s): ${unknownTemplates.join(', ')}`);
    }
    // Only shared accounts can be granted; member-owned accounts stay with their owner.
    const notGrantable = data.accountIds.filter(
      (id) => !state.accounts.some((a) => a.id === id && isShared(a)),
    );
    if (notGrantable.length) {
      throw badRequest(`Unknown or non-shared account(s): ${notGrantable.join(', ')}`);
    }
    if (data.email) this.checkMemberEmail(data.email, selfId);
    if (data.expiresAt && Date.parse(data.expiresAt) <= this.now().getTime()) {
      throw badRequest('expiresAt must be in the future');
    }
    return {
      ...data,
      templateIds: [...new Set(data.templateIds)],
      accountIds: [...new Set(data.accountIds)],
      expiresAt: data.expiresAt && new Date(data.expiresAt).toISOString(),
    };
  }

  private checkMemberEmail(email: string, selfId: string | undefined): void {
    if (this.adminEmails.includes(email)) {
      throw badRequest(`${email} is an admin email: it already signs in as admin`);
    }
    const taken = this.store.read().members.some((m) => m.id !== selfId && m.email === email);
    if (taken) throw conflict(`Another member already uses ${email}`);
  }

  private memberExpired(m: Member): boolean {
    return m.expiresAt !== null && Date.parse(m.expiresAt) <= this.now().getTime();
  }

  private toPublicMember(m: Member): PublicMember {
    const { keyHash: _omit, email, ...rest } = m;
    const state = this.store.read();
    const activeSessions = state.sessions.filter(
      (s) => issuedByMember(s, m.id) && this.statusOf(s) === 'active',
    ).length;
    const ownAccounts = state.accounts.filter((a) => a.ownerMemberId === m.id).length;
    return {
      ...rest,
      email: email ?? null,
      activeSessions,
      ownAccounts,
      expired: this.memberExpired(m),
    };
  }

  private toPublicAccount(a: Account): PublicAccount {
    const { secret, ownerMemberId, oauth, ...rest } = a;
    const owner = ownerMemberId
      ? this.store.read().members.find((m) => m.id === ownerMemberId)
      : undefined;
    return {
      ...rest,
      kind: this.tools.get(a.tool)?.kind ?? 'tool',
      secretHint: oauth ? 'signed in' : `…${secret.slice(-SECRET_HINT_CHARS)}`,
      signedIn: Boolean(oauth),
      owner: owner
        ? { kind: 'member', memberId: owner.id, memberName: owner.name }
        : { kind: 'shared' },
    };
  }

  // ---------------------------------------------------------------- sessions

  listSessions(): PublicSession[] {
    return this.store
      .read()
      .sessions.map((s) => this.toPublicSession(s))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Issues a session key as the admin. The plaintext key is returned exactly once. */
  issueSession(input: unknown): Promise<{ key: string; session: PublicSession }> {
    const req = sessionRequestSchema.parse(input);
    const template = this.store.read().templates.find((t) => t.id === req.templateId);
    if (!template) throw notFound(TEMPLATE_NOT_FOUND);
    const accounts = this.pickAccounts(template, requestedAccounts(req), ADMIN);
    return this.issue(req, template, accounts, ADMIN_ISSUER);
  }

  /**
   * Self-serve issuance by a member: only for its allowed templates and accounts.
   * Unknown and disallowed ids get the same answer, so members can't probe for other ids.
   */
  issueSessionAsMember(
    member: Member,
    input: unknown,
  ): Promise<{ key: string; session: PublicSession }> {
    const req = sessionRequestSchema.parse(input);
    const template = member.templateIds.includes(req.templateId)
      ? this.store.read().templates.find((t) => t.id === req.templateId)
      : undefined;
    if (!template) throw forbidden(TEMPLATE_NOT_AVAILABLE);
    const accounts = this.pickAccounts(template, requestedAccounts(req), {
      kind: 'member',
      member,
    });
    return this.issue(
      req,
      template,
      accounts,
      { kind: 'member', memberId: member.id, memberName: member.name },
      member,
    );
  }

  /**
   * Issues a session key for an agent run the launchpad starts on a member's behalf: same limits
   * as the member's own self-serve keys. `keyGeneration`, when given, must still be the member's
   * current one (schedules stop once the member key was rotated).
   */
  async issueSessionForRun(
    memberId: string,
    runId: string,
    input: unknown,
    keyGeneration?: number,
    scope?: RunToolScope,
  ): Promise<{ key: string; session: PublicSession }> {
    const member = this.store.read().members.find((m) => m.id === memberId);
    if (!member || this.memberExpired(member)) throw unauthorized(MEMBER_NOT_VALID);
    if (keyGeneration !== undefined && member.keyGeneration !== keyGeneration) {
      throw unauthorized(MEMBER_KEY_ROTATED);
    }
    const req = sessionRequestSchema.parse(input);
    const template = member.templateIds.includes(req.templateId)
      ? this.store.read().templates.find((t) => t.id === req.templateId)
      : undefined;
    if (!template) throw forbidden(TEMPLATE_NOT_AVAILABLE);
    const accounts = this.pickAccounts(
      template,
      requestedAccounts(req),
      { kind: 'member', member },
      scope,
    );
    return this.issue(
      req,
      template,
      accounts,
      { kind: 'launchpad', memberId: member.id, memberName: member.name, runId },
      member,
    );
  }

  /** A member by id, or null when it is gone or expired. */
  activeMember(memberId: string): Member | null {
    const member = this.store.read().members.find((m) => m.id === memberId);
    return member && !this.memberExpired(member) ? member : null;
  }

  /**
   * Checks, without issuing anything, that a member could get a key for this template (and these
   * accounts). Returns the template, and the tools the key would cover with their accounts.
   */
  planMemberSession(
    member: Member,
    templateId: string,
    accountIds: readonly string[],
    scope?: RunToolScope,
  ): { template: Template; accountIds: string[]; tools: string[] } {
    const template = this.memberTemplate(member, templateId);
    const bound = this.pickAccounts(
      template,
      [...new Set(accountIds)],
      { kind: 'member', member },
      scope,
    );
    return {
      template,
      accountIds: bound.flatMap((b) => (b.account ? [b.account.id] : [])),
      tools: bound.map((b) => b.grant.tool),
    };
  }

  /** A template the member may use, as stored (endpoint tokens included: keep it server-side). */
  memberTemplate(member: Member, templateId: string): Template {
    const template = member.templateIds.includes(templateId)
      ? this.store.read().templates.find((t) => t.id === templateId)
      : undefined;
    if (!template) throw forbidden(TEMPLATE_NOT_AVAILABLE);
    return template;
  }

  /** The member's current key generation, or null when it is gone or expired. */
  memberKeyGeneration(memberId: string): number | null {
    const member = this.store.read().members.find((m) => m.id === memberId);
    return member && !this.memberExpired(member) ? member.keyGeneration : null;
  }

  /**
   * Accounts an actor can issue keys against: shared accounts for the admin; for a member, its
   * own accounts plus the shared accounts granted to it.
   */
  private usableAccounts(actor: Actor): Account[] {
    const accounts = this.store.read().accounts;
    if (actor.kind === 'admin') return accounts.filter(isShared);
    const m = actor.member;
    return accounts.filter(
      (a) => a.ownerMemberId === m.id || (isShared(a) && m.accountIds.includes(a.id)),
    );
  }

  /**
   * Resolves the account a key will use for each tool of the template, in template order: the
   * requested one, or the only usable account for that tool. A `scope` (agent runs) leaves some
   * of the template's tools out; requested accounts for dropped tools are ignored.
   */
  private pickAccounts(
    template: Template,
    requestedIds: string[],
    actor: Actor,
    scope?: RunToolScope,
  ): BoundGrant[] {
    const usable = this.usableAccounts(actor);
    const dropped = (tool: string) => scope?.drop.includes(tool) ?? false;
    const grants = template.grants.filter(
      (g) =>
        !dropped(g.tool) && !(scope && g.endpoint && !scope.endpointApis.includes(g.endpoint.api)),
    );
    const requested = requestedIds.flatMap((id) => {
      const account = usable.find((a) => a.id === id);
      if (!account) {
        throw actor.kind === 'admin'
          ? notFound(ACCOUNT_NOT_FOUND)
          : forbidden('This account is not available to you');
      }
      if (dropped(account.tool)) return [];
      if (!grants.some((g) => g.tool === account.tool)) {
        throw badRequest(
          `Account "${account.label}" is a ${account.tool} account but the template does not cover ${account.tool}`,
        );
      }
      return [account];
    });
    return grants.flatMap((grant): BoundGrant[] => {
      const { tool } = grant;
      if (grant.endpoint) return [{ grant, account: null }];
      const explicit = requested.filter((a) => a.tool === tool);
      const candidates = explicit.length ? explicit : usable.filter((a) => a.tool === tool);
      if (candidates.length === 0 && scope?.optional.includes(tool)) return [];
      const [only] = candidates;
      if (candidates.length !== 1 || !only) {
        throw badRequest(
          candidates.length === 0
            ? `No ${tool} account available`
            : `Several ${tool} accounts match this template: give exactly one in accountIds`,
        );
      }
      return [{ grant, account: only }];
    });
  }

  private async issue(
    req: z.infer<typeof sessionRequestSchema>,
    template: Template,
    bound: BoundGrant[],
    issuedBy: SessionIssuer,
    /** The member the request was authorized for, as it was then (member and launchpad keys). */
    member?: Member,
  ): Promise<{ key: string; session: PublicSession }> {
    const ttlSeconds = req.ttlSeconds ?? template.defaultTtlSeconds;
    if (ttlSeconds > template.maxTtlSeconds) {
      throw badRequest(`Requested TTL exceeds template maximum (${template.maxTtlSeconds}s)`);
    }

    const key = randomToken(SESSION_KEY_PREFIX);
    const now = this.now();
    const session: Session = {
      id: randomId(),
      keyHash: this.crypto.hashToken(key),
      keyHint: key.slice(0, SESSION_KEY_PREFIX.length + KEY_HINT_CHARS),
      label: req.label ?? '',
      templateId: template.id,
      templateName: template.name,
      grants: bound.map(({ grant, account }) => ({
        tool: grant.tool,
        accountId: account?.id ?? '',
        permissions: [...grant.permissions],
        resources: [...grant.resources],
        ...(grant.endpoint && { endpoint: { ...grant.endpoint } }),
      })),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * MS_PER_SECOND).toISOString(),
      revokedAt: null,
      lastUsedAt: null,
      requestCount: 0,
      issuedBy,
      tokenBudget: req.tokenBudget ?? null,
      egressDomains: [...(template.egressDomains ?? [])],
    };
    await this.store.update((s) => {
      // Re-checked inside the mutation: the request may have waited (slow body, queued run)
      // while the member was rotated, narrowed, expired or deleted.
      if (member) {
        const current = this.checkMemberStillAllows(s, member, template, bound);
        current.lastUsedAt = session.createdAt;
      }
      s.sessions.push(session);
    });
    const by = issuerName(issuedBy);
    const on = bound
      .map(({ grant, account }) => `"${account?.label ?? grant.endpoint?.url ?? grant.tool}"`)
      .join(', ');
    this.activity.add({
      kind: issuedBy.kind,
      tool: toolsOf(template),
      sessionId: session.id,
      sessionLabel: session.label,
      detail: `${by} issued a session from template "${template.name}" on account${bound.length === 1 ? '' : 's'} ${on} (TTL ${ttlSeconds}s)`,
    });
    return { key, session: this.toPublicSession(session) };
  }

  async revokeSession(id: string, by: SessionIssuer = ADMIN_ISSUER): Promise<PublicSession> {
    const revoked = await this.store.update((s) => {
      const session = s.sessions.find((x) => x.id === id);
      if (!session) throw notFound(SESSION_NOT_FOUND);
      session.revokedAt ??= this.now().toISOString();
      return session;
    });
    this.activity.add({
      kind: by.kind,
      tool: toolsOf(revoked),
      sessionId: id,
      sessionLabel: revoked.label,
      detail:
        by.kind === 'member' ? `Member "${by.memberName}" revoked a session` : 'Revoked session',
    });
    return this.toPublicSession(revoked);
  }

  /** Resolves a presented session key to an active session; throws 401 otherwise. */
  resolveSession(key: string): Session {
    if (!key.startsWith(SESSION_KEY_PREFIX)) throw unauthorized('Invalid session key');
    const hash = this.crypto.hashToken(key);
    const session = this.store.read().sessions.find((s) => CryptoBox.equalHex(s.keyHash, hash));
    if (!session) throw unauthorized('Invalid session key');
    const status = this.statusOf(session);
    if (status !== 'active') throw unauthorized(`Session key is ${status}`);
    return session;
  }

  /**
   * What an active session may do on one tool, with the account to use. Null when the session
   * does not cover that tool; throws 401 if its account or tool is gone.
   */
  resolveGrant(session: Session, toolId: string): ResolvedGrant | null {
    const grant = session.grants.find((g) => g.tool === toolId);
    if (!grant) return null;
    const tool = this.tools.get(grant.tool);
    if (grant.endpoint) {
      if (!tool?.bindEndpoint) throw unauthorized('Tool is no longer available');
      return {
        grant,
        account: endpointAccount(grant.endpoint, session),
        tool: tool.bindEndpoint(grant.endpoint),
      };
    }
    const account = this.store.read().accounts.find((a) => a.id === grant.accountId);
    if (!account) throw unauthorized('Account behind this session was removed');
    if (!tool) throw unauthorized('Tool is no longer available');
    return { grant, account, tool };
  }

  /** LLM tokens the session may still use, or null when it has no token budget. */
  tokensRemaining(session: Session): number | null {
    const budget = session.tokenBudget ?? null;
    if (budget === null) return null;
    return budget - this.llmUsage.totalsFor([session.id]).total;
  }

  recordUsage(sessionId: string): void {
    const entry = this.usage.get(sessionId) ?? { lastUsedAt: '', count: 0 };
    entry.count += 1;
    entry.lastUsedAt = this.now().toISOString();
    this.usage.set(sessionId, entry);
  }

  /** Persists buffered usage counters and prunes long-dead sessions. */
  async flush(): Promise<void> {
    const cutoff = this.now().getTime() - SESSION_RETENTION_MS;
    const usage = new Map(this.usage);
    const needsPrune = this.store
      .read()
      .sessions.some((s) => this.statusOf(s) !== 'active' && endOf(s) < cutoff);
    if (usage.size === 0 && !needsPrune) return;
    this.usage.clear();
    await this.store.update((s) => {
      for (const session of s.sessions) {
        const u = usage.get(session.id);
        if (!u) continue;
        session.requestCount += u.count;
        session.lastUsedAt = u.lastUsedAt;
      }
      s.sessions = s.sessions.filter((x) => this.statusOf(x) === 'active' || endOf(x) >= cutoff);
    });
  }

  private statusOf(s: Session): SessionStatus {
    if (s.revokedAt) return 'revoked';
    return Date.parse(s.expiresAt) <= this.now().getTime() ? 'expired' : 'active';
  }

  private toPublicSession(s: Session): PublicSession {
    const { keyHash: _omit, issuedBy, grants, ...rest } = s;
    const pending = this.usage.get(s.id);
    return {
      ...rest,
      grants: grants.map(publicGrant),
      issuedBy: issuedBy ?? ADMIN_ISSUER,
      requestCount: s.requestCount + (pending?.count ?? 0),
      lastUsedAt: pending?.lastUsedAt ?? s.lastUsedAt,
      status: this.statusOf(s),
    };
  }

  /** Throws unless the member, unchanged since `snapshot`, may still issue this key. */
  private checkMemberStillAllows(
    s: StoreState,
    snapshot: Member,
    template: Template,
    bound: BoundGrant[],
  ): Member {
    const member = s.members.find((m) => m.id === snapshot.id);
    if (!member || this.memberExpired(member)) throw unauthorized(MEMBER_NOT_VALID);
    if (member.keyHash !== snapshot.keyHash) throw unauthorized(MEMBER_KEY_ROTATED);
    if (!member.templateIds.includes(template.id)) {
      throw forbidden(TEMPLATE_NOT_AVAILABLE);
    }
    const usable = (a: Account): boolean =>
      a.ownerMemberId === member.id || (isShared(a) && member.accountIds.includes(a.id));
    for (const { account } of bound) {
      if (!account) continue;
      const current = s.accounts.find((a) => a.id === account.id);
      if (!current || !usable(current)) throw forbidden('This account is not available to you');
    }
    return member;
  }

  private revokeWhere(sessions: Session[], pred: (s: Session) => boolean): number {
    let n = 0;
    const ts = this.now().toISOString();
    for (const s of sessions) {
      if (pred(s) && this.statusOf(s) === 'active') {
        s.revokedAt = ts;
        n++;
      }
    }
    return n;
  }
}

/** Checks a grant's endpoint: required by tools configured per grant, refused by the others. */
function validateEndpoint(
  tool: ToolProvider,
  input: z.infer<typeof toolGrantSchema>['endpoint'],
  previous: LlmEndpoint | undefined,
): LlmEndpoint | undefined {
  if (!tool.bindEndpoint) {
    if (input) throw badRequest(`${tool.name} does not take an endpoint`);
    return undefined;
  }
  if (!input) throw badRequest(`${tool.name}: enter the endpoint URL and chat API`);
  const checked = validateEndpointUrl(input.url);
  if ('error' in checked) throw badRequest(`${tool.name}: ${checked.error}`);
  return { url: checked.url, api: input.api, token: input.token ?? previous?.token ?? '' };
}

function publicGrant<G extends ToolGrant>(grant: G): PublicGrant<G> {
  const { endpoint, ...rest } = grant;
  if (!endpoint) return rest;
  return {
    ...rest,
    endpoint: { url: endpoint.url, api: endpoint.api, hasToken: endpoint.token !== '' },
  };
}

function publicTemplate(t: Template): PublicTemplate {
  return { ...t, grants: t.grants.map(publicGrant) };
}

/** Stand-in account for an endpoint grant: its token is what the proxy sends upstream. */
function endpointAccount(endpoint: LlmEndpoint, session: Session): Account {
  return {
    id: '',
    tool: '',
    label: new URL(endpoint.url).host,
    secret: endpoint.token,
    identity: { api: endpoint.api },
    createdAt: session.createdAt,
    lastVerifiedAt: session.createdAt,
  };
}

/** Keys a member issued itself, or the launchpad issued for the member's runs. */
function issuedByMember(s: Session, memberId: string): boolean {
  return (
    (s.issuedBy?.kind === 'member' || s.issuedBy?.kind === 'launchpad') &&
    s.issuedBy.memberId === memberId
  );
}

function issuerName(issuedBy: SessionIssuer): string {
  switch (issuedBy.kind) {
    case 'admin':
      return 'Admin';
    case 'member':
      return `Member "${issuedBy.memberName}"`;
    case 'launchpad':
      return `Launchpad (run ${issuedBy.runId} of "${issuedBy.memberName}")`;
  }
}

function usesAccount(s: Session, matches: (accountId: string) => boolean): boolean {
  return s.grants.some((g) => matches(g.accountId));
}

/** Tools a template or session covers, for the activity log. */
function toolsOf(x: { grants: readonly ToolGrant[] }): string {
  return x.grants.map((g) => g.tool).join(', ');
}

/** Accounts named in a session request, deduplicated (`accountId` is the single-account form). */
function requestedAccounts(req: z.infer<typeof sessionRequestSchema>): string[] {
  return [...new Set(req.accountId ? [...req.accountIds, req.accountId] : req.accountIds)];
}

function endOf(s: Session): number {
  return s.revokedAt ? Date.parse(s.revokedAt) : Date.parse(s.expiresAt);
}

/** Accounts connected by the admin (no member owner). */
function isShared(a: Account): boolean {
  return !a.ownerMemberId;
}

function memberIdOf(actor: Actor): string | null {
  return actor.kind === 'member' ? actor.member.id : null;
}

function actorName(actor: Actor): string {
  return actor.kind === 'member' ? `Member "${actor.member.name}"` : 'Admin';
}
