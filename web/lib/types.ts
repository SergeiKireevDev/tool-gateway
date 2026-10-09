// Shapes returned by the gateway admin API (see src/server/gateway.ts).

export interface PermissionDef {
  id: string;
  label: string;
  description: string;
}

export interface SignInConfig {
  setupHelp: string;
  registerUrl: string;
  defaultScopes: string;
  oauthClientId: string;
  /** Button label, e.g. "Sign in with ChatGPT". */
  label: string;
  /** The tool's public client ID is built in: there is no OAuth app to set up. */
  builtIn: boolean;
}

/** Example call through the gateway, relative to the tool's proxy base URL. */
export interface ToolExample {
  method: 'GET' | 'POST';
  path: string;
  body?: string;
  clientHint: string;
}

export interface Tool {
  id: string;
  name: string;
  /** `llm`: a model API agents call themselves (Anthropic, OpenAI, Gemini). */
  kind: 'tool' | 'llm';
  credentialHelp: string;
  credentialPlaceholder: string;
  resourceHelp: string;
  permissions: PermissionDef[];
  example: ToolExample;
  /** Chat APIs a per-template endpoint may speak (custom LLM); null for account-based tools. */
  endpointApis: LlmEndpointApi[] | null;
  /** Present when the tool supports interactive sign-in (OAuth device flow). */
  signIn: SignInConfig | null;
  /**
   * Present when the tool supports "Sign in with …" through OAuth. `redirectsBack`: the provider
   * returns to the gateway's callback page; otherwise the redirect address is pasted back.
   */
  oauthSignIn: { help: string; redirectsBack: boolean } | null;
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
  /** `tool` (GitHub, Slack…) or `llm` (a model provider). */
  kind: 'tool' | 'llm';
  secretHint: string;
  /** Connected by signing in (the gateway refreshes it) rather than with a pasted token. */
  signedIn: boolean;
  createdAt: string;
  lastVerifiedAt: string;
  owner: AccountOwner;
}

export type LlmEndpointApi = 'openai' | 'anthropic';

/** A custom LLM endpoint configured in a template (its token is never returned). */
export interface LlmEndpoint {
  url: string;
  api: LlmEndpointApi;
  hasToken: boolean;
}

/** What a template grants on one tool. Empty resources = unrestricted. */
export interface ToolGrant {
  tool: string;
  permissions: string[];
  resources: string[];
  endpoint?: LlmEndpoint;
}

/** A grant as sent when saving a template: no `token` keeps the endpoint's current one. */
export interface ToolGrantInput extends Omit<ToolGrant, 'endpoint'> {
  endpoint?: Omit<LlmEndpoint, 'hasToken'> & { token?: string };
}

/** What every viewer sees of a template (members get only this). */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  /** One per tool the template covers. */
  grants: ToolGrant[];
  /** HTTPS domains launched agents may reach directly. */
  egressDomains?: string[];
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
}

export interface Template extends TemplateSummary {
  createdAt: string;
  updatedAt: string;
}

export interface TemplateInput {
  name: string;
  description: string;
  grants: ToolGrantInput[];
  egressDomains: string[];
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
}

export type SessionStatus = 'active' | 'expired' | 'revoked';

export type SessionIssuer =
  | { kind: 'admin' }
  | { kind: 'member'; memberId: string; memberName: string }
  | { kind: 'launchpad'; memberId: string; memberName: string; runId: string };

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

/** A session's snapshot of a template grant, with the account it uses for that tool. */
export interface SessionGrant extends ToolGrant {
  accountId: string;
}

export interface Session {
  id: string;
  keyHint: string;
  label: string;
  templateId: string;
  templateName: string;
  grants: SessionGrant[];
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
  kind: 'proxy' | 'admin' | 'member' | 'launchpad';
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
