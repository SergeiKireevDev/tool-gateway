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

export interface Account {
  id: string;
  tool: string;
  label: string;
  identity: Record<string, string>;
  secretHint: string;
  createdAt: string;
  lastVerifiedAt: string;
}

export interface Template {
  id: string;
  tool: string;
  name: string;
  description: string;
  permissions: string[];
  resources: string[];
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
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
}

export interface ActivityEntry {
  at: string;
  kind: 'proxy' | 'admin';
  sessionId?: string;
  sessionLabel?: string;
  tool?: string;
  method?: string;
  path?: string;
  status?: number;
  decision?: 'allowed' | 'denied';
  detail: string;
}
