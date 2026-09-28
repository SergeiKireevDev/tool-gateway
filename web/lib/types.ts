// Shapes returned by the gateway admin API (see src/server/gateway.ts).

export interface PermissionDef {
  id: string;
  label: string;
  description: string;
}

export interface SignInConfig {
  setupHelp: string;
  defaultScopes: string;
  oauthClientId: string;
}

export interface Tool {
  id: string;
  name: string;
  credentialHelp: string;
  resourceHelp: string;
  permissions: PermissionDef[];
  /** Present when the tool supports interactive sign-in (OAuth device flow). */
  signIn: SignInConfig | null;
}

export interface DeviceFlowStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
}

export type DeviceFlowStatus =
  | { status: 'pending' }
  | { status: 'complete'; account: Account }
  | { status: 'failed'; message: string };

export type AccountOwner =
  { kind: 'shared' } | { kind: 'member'; memberId: string; memberName: string };

export interface Account {
  id: string;
  tool: string;
  label: string;
  identity: Record<string, string>;
  secretHint: string;
  createdAt: string;
  lastVerifiedAt: string;
  owner: AccountOwner;
}

/** What every viewer sees of a template (members get only this). */
export interface TemplateSummary {
  id: string;
  tool: string;
  name: string;
  description: string;
  permissions: string[];
  resources: string[];
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
}

export interface Template extends TemplateSummary {
  createdAt: string;
  updatedAt: string;
}

export interface TemplateInput {
  tool: string;
  name: string;
  description: string;
  permissions: string[];
  resources: string[];
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
}

export type SessionStatus = 'active' | 'expired' | 'revoked';

export type SessionIssuer =
  { kind: 'admin' } | { kind: 'member'; memberId: string; memberName: string };

export interface Member {
  id: string;
  name: string;
  email: string | null;
  keyHint: string;
  templateIds: string[];
  accountIds: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  activeSessions: number;
  ownAccounts: number;
  expired: boolean;
}

export interface MemberInput {
  name: string;
  email: string | null;
  templateIds: string[];
  accountIds: string[];
  expiresAt: string | null;
}

export interface Session {
  id: string;
  keyHint: string;
  label: string;
  tool: string;
  accountId: string;
  templateId: string;
  templateName: string;
  permissions: string[];
  resources: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  requestCount: number;
  status: SessionStatus;
  issuedBy: SessionIssuer;
}

export interface ActivityEntry {
  at: string;
  kind: 'proxy' | 'admin' | 'member';
  sessionId?: string;
  sessionLabel?: string;
  tool?: string;
  method?: string;
  path?: string;
  status?: number;
  decision?: 'allowed' | 'denied';
  detail: string;
}

/** The signed-in member's own view (member portal). */
export interface MemberSelf {
  id: string;
  name: string;
  email: string | null;
  keyHint: string;
  expiresAt: string | null;
  templates: TemplateSummary[];
}
