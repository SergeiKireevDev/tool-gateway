import { z } from 'zod';
import type { ActivityLog } from './activity.js';
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
import type { Account, Member, Session, SessionIssuer, Template } from './store/types.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolProvider } from './tools/types.js';
import { MS_PER_DAY, MS_PER_SECOND, SECONDS_PER_DAY, SECONDS_PER_HOUR } from './units.js';

export const SESSION_KEY_PREFIX = 'gws_';
export const ADMIN_TOKEN_PREFIX = 'gwa_';
export const ADMIN_WEB_SESSION_PREFIX = 'gwc_';
export const MEMBER_KEY_PREFIX = 'gwm_';
const ADMIN_WEB_SESSION_TTL_HOURS = 12;
export const ADMIN_WEB_SESSION_TTL_SECONDS = ADMIN_WEB_SESSION_TTL_HOURS * SECONDS_PER_HOUR;
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

/** Non-secret key prefix shown in the UI to tell keys apart. */
const KEY_HINT_CHARS = 6;
/** Trailing characters of a stored credential shown in the UI. */
const SECRET_HINT_CHARS = 4;
const DEVICE_FLOW_ID_BYTES = 16;

const ACCOUNT_NOT_FOUND = 'Account not found';
const TEMPLATE_NOT_FOUND = 'Template not found';
const MEMBER_NOT_FOUND = 'Member not found';
const SESSION_NOT_FOUND = 'Session not found';
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

export const templateSchema = z
  .object({
    tool: z.string().min(1),
    name: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
    description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).default(''),
    permissions: z.array(z.string()).min(1, 'Select at least one permission'),
    resources: z.array(z.string().trim()).default([]),
    defaultTtlSeconds: ttl,
    maxTtlSeconds: ttl,
  })
  .refine((t) => t.defaultTtlSeconds <= t.maxTtlSeconds, {
    message: 'Default TTL must not exceed max TTL',
    path: ['defaultTtlSeconds'],
  });

export const sessionRequestSchema = z.object({
  templateId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  ttlSeconds: ttl.optional(),
  label: z.string().trim().max(MAX_LABEL_LENGTH).optional(),
});

const idList = z.array(z.string().min(1)).min(1);

export const memberSchema = z.object({
  name: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
  templateIds: idList,
  accountIds: idList,
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

export type PublicAccount = Omit<Account, 'secret'> & { secretHint: string };
export type SessionStatus = 'active' | 'expired' | 'revoked';
export type PublicSession = Omit<Session, 'keyHash' | 'issuedBy'> & {
  status: SessionStatus;
  issuedBy: SessionIssuer;
};
export type PublicMember = Omit<Member, 'keyHash'> & { activeSessions: number; expired: boolean };

/** What a member sees about itself: the templates and accounts it may request keys for. */
export interface MemberView {
  id: string;
  name: string;
  expiresAt: string | null;
  templates: Pick<
    Template,
    | 'id'
    | 'tool'
    | 'name'
    | 'description'
    | 'permissions'
    | 'resources'
    | 'defaultTtlSeconds'
    | 'maxTtlSeconds'
  >[];
  accounts: { id: string; tool: string; label: string; login: string | undefined }[];
}

export interface ResolvedSession {
  session: Session;
  account: Account;
  tool: ToolProvider;
}

export class Gateway {
  private readonly usage = new Map<string, { lastUsedAt: string; count: number }>();
  private readonly deviceFlows = new Map<string, PendingDeviceFlow>();

  constructor(
    private readonly store: EncryptedStore,
    private readonly crypto: CryptoBox,
    readonly tools: ToolRegistry,
    readonly activity: ActivityLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

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

  // ---------------------------------------------------------------- admin web sessions

  /** Starts a browser session for an admin who signed in (e.g. with Google). Returns the cookie value. */
  async createAdminWebSession(email: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken(ADMIN_WEB_SESSION_PREFIX);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ADMIN_WEB_SESSION_TTL_SECONDS * MS_PER_SECOND);
    await this.store.update((s) => {
      s.adminSessions = s.adminSessions.filter((x) => Date.parse(x.expiresAt) > now.getTime());
      s.adminSessions.push({
        id: randomId(),
        tokenHash: this.crypto.hashToken(token),
        email,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
    });
    this.activity.add({ kind: 'admin', detail: `Admin signed in: ${email}` });
    return { token, expiresAt };
  }

  resolveAdminWebSession(token: string): { email: string; expiresAt: string } | null {
    if (!token.startsWith(ADMIN_WEB_SESSION_PREFIX)) return null;
    const hash = this.crypto.hashToken(token);
    const session = this.store
      .read()
      .adminSessions.find((s) => CryptoBox.equalHex(s.tokenHash, hash));
    if (!session || Date.parse(session.expiresAt) <= this.now().getTime()) return null;
    return { email: session.email, expiresAt: session.expiresAt };
  }

  async endAdminWebSession(token: string): Promise<void> {
    const hash = this.crypto.hashToken(token);
    await this.store.update((s) => {
      s.adminSessions = s.adminSessions.filter((x) => !CryptoBox.equalHex(x.tokenHash, hash));
    });
  }

  // ---------------------------------------------------------------- accounts

  private tool(id: string): ToolProvider {
    const tool = this.tools.get(id);
    if (!tool) throw badRequest(`Unknown tool "${id}"`);
    return tool;
  }

  listAccounts(): PublicAccount[] {
    return this.store.read().accounts.map(toPublicAccount);
  }

  async createAccount(input: unknown): Promise<PublicAccount> {
    const data = accountCreateSchema.parse(input);
    return this.addAccount(this.tool(data.tool), data.label, data.secret, 'token');
  }

  private async addAccount(
    tool: ToolProvider,
    label: string,
    secret: string,
    method: 'token' | 'device-flow',
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
    };
    await this.store.update((s) => {
      s.accounts.push(account);
    });
    this.activity.add({ kind: 'admin', tool: tool.id, detail: `Connected account "${label}"` });
    return toPublicAccount(account);
  }

  // ---------------------------------------------------------------- tool settings & sign-in

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

  async startDeviceFlow(input: unknown): Promise<{
    flowId: string;
    userCode: string;
    verificationUri: string;
    expiresAt: string;
    intervalSeconds: number;
  }> {
    const data = deviceFlowStartSchema.parse(input);
    const tool = this.tool(data.tool);
    if (!tool.deviceFlow) throw badRequest(`${tool.name} does not support sign-in`);
    const clientId = this.toolSettings(tool.id).oauthClientId;
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
  async pollDeviceFlow(flowId: string): Promise<DeviceFlowStatus> {
    const flow = this.deviceFlows.get(flowId);
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
          const account = await this.addAccount(tool, flow.label, result.secret, 'device-flow');
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

  cancelDeviceFlow(flowId: string): void {
    this.deviceFlows.delete(flowId);
  }

  private pruneDeviceFlows(): void {
    const now = this.now().getTime();
    for (const [id, flow] of this.deviceFlows) {
      if (now >= flow.expiresAt) this.deviceFlows.delete(id);
    }
  }

  async updateAccount(id: string, input: unknown): Promise<PublicAccount> {
    const data = accountUpdateSchema.parse(input);
    const existing = this.findAccount(id);
    const patch: Partial<Account> = {};
    if (data.label) patch.label = data.label;
    if (data.secret) {
      patch.secret = data.secret;
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
      kind: 'admin',
      tool: updated.tool,
      detail: `Updated account "${updated.label}"`,
    });
    return toPublicAccount(updated);
  }

  async reverifyAccount(id: string): Promise<PublicAccount> {
    const acc = this.findAccount(id);
    const identity = await this.verify(this.tool(acc.tool), acc.secret);
    const updated = await this.store.update((s) => {
      const a = s.accounts.find((x) => x.id === id);
      if (!a) throw notFound(ACCOUNT_NOT_FOUND);
      a.identity = identity;
      a.lastVerifiedAt = this.now().toISOString();
      return a;
    });
    return toPublicAccount(updated);
  }

  async deleteAccount(id: string): Promise<void> {
    const acc = this.findAccount(id);
    const revoked = await this.store.update((s) => {
      s.accounts = s.accounts.filter((a) => a.id !== id);
      for (const m of s.members) m.accountIds = m.accountIds.filter((x) => x !== id);
      return this.revokeWhere(s.sessions, (x) => x.accountId === id);
    });
    this.activity.add({
      kind: 'admin',
      tool: acc.tool,
      detail: `Removed account "${acc.label}" (revoked ${revoked} session(s))`,
    });
  }

  private findAccount(id: string): Account {
    const acc = this.store.read().accounts.find((a) => a.id === id);
    if (!acc) throw notFound(ACCOUNT_NOT_FOUND);
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

  listTemplates(): Template[] {
    return [...this.store.read().templates];
  }

  private validateTemplate(input: unknown): z.infer<typeof templateSchema> {
    const data = templateSchema.parse(input);
    const tool = this.tool(data.tool);
    const known = new Set(tool.permissions.map((p) => p.id));
    const unknown = data.permissions.filter((p) => !known.has(p));
    if (unknown.length) throw badRequest(`Unknown permission(s): ${unknown.join(', ')}`);
    data.permissions = [...new Set(data.permissions)];
    data.resources = [...new Set(data.resources.filter(Boolean))];
    for (const r of data.resources) {
      const err = tool.validateResource(r);
      if (err) throw badRequest(err);
    }
    return data;
  }

  async createTemplate(input: unknown): Promise<Template> {
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
      tool: data.tool,
      detail: `Created template "${data.name}"`,
    });
    return template;
  }

  async updateTemplate(id: string, input: unknown): Promise<Template> {
    const data = this.validateTemplate(input);
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
      tool: data.tool,
      detail: `Updated template "${data.name}"`,
    });
    return updated;
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
      tool: tpl.tool,
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
      keyHash: this.crypto.hashToken(key),
      keyHint: key.slice(0, MEMBER_KEY_PREFIX.length + KEY_HINT_CHARS),
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
    const data = this.validateMember(input);
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
  async rotateMemberKey(id: string): Promise<{ key: string; member: PublicMember }> {
    const key = randomToken(MEMBER_KEY_PREFIX);
    const [member, revoked] = await this.store.update((s) => {
      const m = s.members.find((x) => x.id === id);
      if (!m) throw notFound(MEMBER_NOT_FOUND);
      m.keyHash = this.crypto.hashToken(key);
      m.keyHint = key.slice(0, MEMBER_KEY_PREFIX.length + KEY_HINT_CHARS);
      m.updatedAt = this.now().toISOString();
      return [m, this.revokeWhere(s.sessions, (x) => issuedByMember(x, id))] as const;
    });
    this.activity.add({
      kind: 'admin',
      detail: `Rotated key of member "${member.name}" (revoked ${revoked} session(s))`,
    });
    return { key, member: this.toPublicMember(member) };
  }

  async deleteMember(id: string): Promise<void> {
    const [member, revoked] = await this.store.update((s) => {
      const m = s.members.find((x) => x.id === id);
      if (!m) throw notFound(MEMBER_NOT_FOUND);
      s.members = s.members.filter((x) => x.id !== id);
      return [m, this.revokeWhere(s.sessions, (x) => issuedByMember(x, id))] as const;
    });
    this.activity.add({
      kind: 'admin',
      detail: `Deleted member "${member.name}" (revoked ${revoked} session(s))`,
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
      expiresAt: member.expiresAt,
      templates: state.templates
        .filter((t) => member.templateIds.includes(t.id))
        .map(
          ({
            id,
            tool,
            name,
            description,
            permissions,
            resources,
            defaultTtlSeconds,
            maxTtlSeconds,
          }) => ({
            id,
            tool,
            name,
            description,
            permissions,
            resources,
            defaultTtlSeconds,
            maxTtlSeconds,
          }),
        ),
      accounts: state.accounts
        .filter((a) => member.accountIds.includes(a.id))
        .map((a) => ({ id: a.id, tool: a.tool, label: a.label, login: a.identity.login })),
    };
  }

  listMemberSessions(member: Member): PublicSession[] {
    return this.listSessions().filter(
      (s) => s.issuedBy.kind === 'member' && s.issuedBy.memberId === member.id,
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

  private validateMember(input: unknown): z.infer<typeof memberSchema> {
    const data = memberSchema.parse(input);
    const state = this.store.read();
    const unknownTemplates = data.templateIds.filter(
      (id) => !state.templates.some((t) => t.id === id),
    );
    if (unknownTemplates.length)
      throw badRequest(`Unknown template(s): ${unknownTemplates.join(', ')}`);
    const unknownAccounts = data.accountIds.filter(
      (id) => !state.accounts.some((a) => a.id === id),
    );
    if (unknownAccounts.length)
      throw badRequest(`Unknown account(s): ${unknownAccounts.join(', ')}`);
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

  private memberExpired(m: Member): boolean {
    return m.expiresAt !== null && Date.parse(m.expiresAt) <= this.now().getTime();
  }

  private toPublicMember(m: Member): PublicMember {
    const { keyHash: _omit, ...rest } = m;
    const activeSessions = this.store
      .read()
      .sessions.filter((s) => issuedByMember(s, m.id) && this.statusOf(s) === 'active').length;
    return { ...rest, activeSessions, expired: this.memberExpired(m) };
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
    const account = this.pickAccount(template, req.accountId, null);
    return this.issue(req, template, account, ADMIN_ISSUER);
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
    if (!template) throw forbidden('This template is not available to you');
    const account = this.pickAccount(template, req.accountId, member.accountIds);
    return this.issue(req, template, account, {
      kind: 'member',
      memberId: member.id,
      memberName: member.name,
    });
  }

  /**
   * Resolves the account a key will use. `allowed` restricts the choice (members); null means
   * any account of the template's tool (admin).
   */
  private pickAccount(
    template: Template,
    requestedId: string | undefined,
    allowed: readonly string[] | null,
  ): Account {
    const usable = this.store
      .read()
      .accounts.filter((a) => allowed === null || allowed.includes(a.id));
    if (requestedId) {
      const account = usable.find((a) => a.id === requestedId);
      if (!account) {
        throw allowed === null
          ? notFound(ACCOUNT_NOT_FOUND)
          : forbidden('This account is not available to you');
      }
      if (account.tool !== template.tool) {
        throw badRequest(
          `Account is a ${account.tool} account but template targets ${template.tool}`,
        );
      }
      return account;
    }
    const candidates = usable.filter((a) => a.tool === template.tool);
    const [only] = candidates;
    if (candidates.length !== 1 || !only) {
      throw badRequest(
        candidates.length === 0
          ? `No ${template.tool} account available`
          : 'Several accounts match this template: specify accountId',
      );
    }
    return only;
  }

  private async issue(
    req: z.infer<typeof sessionRequestSchema>,
    template: Template,
    account: Account,
    issuedBy: SessionIssuer,
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
      tool: template.tool,
      accountId: account.id,
      templateId: template.id,
      templateName: template.name,
      permissions: [...template.permissions],
      resources: [...template.resources],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * MS_PER_SECOND).toISOString(),
      revokedAt: null,
      lastUsedAt: null,
      requestCount: 0,
      issuedBy,
    };
    await this.store.update((s) => {
      s.sessions.push(session);
      if (issuedBy.kind === 'member') {
        const member = s.members.find((m) => m.id === issuedBy.memberId);
        if (member) member.lastUsedAt = session.createdAt;
      }
    });
    const by = issuedBy.kind === 'member' ? `Member "${issuedBy.memberName}"` : 'Admin';
    this.activity.add({
      kind: issuedBy.kind,
      tool: template.tool,
      sessionId: session.id,
      sessionLabel: session.label,
      detail: `${by} issued a session from template "${template.name}" on account "${account.label}" (TTL ${ttlSeconds}s)`,
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
      tool: revoked.tool,
      sessionId: id,
      sessionLabel: revoked.label,
      detail:
        by.kind === 'member' ? `Member "${by.memberName}" revoked a session` : 'Revoked session',
    });
    return this.toPublicSession(revoked);
  }

  /** Resolves a presented session key; throws 401/403 with a useful message otherwise. */
  resolveSession(key: string): ResolvedSession {
    if (!key.startsWith(SESSION_KEY_PREFIX)) throw unauthorized('Invalid session key');
    const hash = this.crypto.hashToken(key);
    const state = this.store.read();
    const session = state.sessions.find((s) => CryptoBox.equalHex(s.keyHash, hash));
    if (!session) throw unauthorized('Invalid session key');
    const status = this.statusOf(session);
    if (status !== 'active') throw unauthorized(`Session key is ${status}`);
    const account = state.accounts.find((a) => a.id === session.accountId);
    if (!account) throw unauthorized('Account behind this session was removed');
    const tool = this.tools.get(session.tool);
    if (!tool) throw unauthorized('Tool is no longer available');
    return { session, account, tool };
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
    const { keyHash: _omit, issuedBy, ...rest } = s;
    const pending = this.usage.get(s.id);
    return {
      ...rest,
      issuedBy: issuedBy ?? ADMIN_ISSUER,
      requestCount: s.requestCount + (pending?.count ?? 0),
      lastUsedAt: pending?.lastUsedAt ?? s.lastUsedAt,
      status: this.statusOf(s),
    };
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

function issuedByMember(s: Session, memberId: string): boolean {
  return s.issuedBy?.kind === 'member' && s.issuedBy.memberId === memberId;
}

function endOf(s: Session): number {
  return s.revokedAt ? Date.parse(s.revokedAt) : Date.parse(s.expiresAt);
}

function toPublicAccount(a: Account): PublicAccount {
  const { secret, ...rest } = a;
  return { ...rest, secretHint: `…${secret.slice(-SECRET_HINT_CHARS)}` };
}
