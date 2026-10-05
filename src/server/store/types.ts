export interface Account {
  id: string;
  tool: string;
  label: string;
  /** Third-party credential. Only ever persisted inside the encrypted store. */
  secret: string;
  /**
   * OAuth sign-in accounts: the refresh token and when `secret` (the access token) expires.
   * The gateway refreshes the access token before it does.
   */
  oauth?: { refreshToken: string; expiresAt: string } | null;
  /** Tool-specific identity info gathered when the account was verified. */
  identity: Record<string, string>;
  createdAt: string;
  lastVerifiedAt: string;
  /**
   * The member who connected (and owns) this account. Absent/null = a shared account connected
   * by the admin, which the admin can grant to members.
   */
  ownerMemberId?: string | null;
}

/** What a template grants on one tool. */
export interface ToolGrant {
  tool: string;
  permissions: string[];
  /**
   * Resource allowlist in the tool's own terms (`octo-org/*` repositories for GitHub, board IDs
   * for monday.com, channel IDs for Slack). Empty = unrestricted.
   */
  resources: string[];
}

/**
 * A template grants access to one or more tools (at most one grant per tool), so a single session
 * key can e.g. open pull requests on GitHub and update items on monday.com.
 */
export interface Template {
  id: string;
  name: string;
  description: string;
  grants: ToolGrant[];
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A member can request session keys by itself (self-serve), but only for the templates and
 * accounts the admin allowed. Its key is stored as a keyed hash only.
 */
export interface Member {
  id: string;
  name: string;
  /** Google account email the member signs in to the member portal with (lower-cased). */
  email?: string | null;
  keyHash: string;
  keyHint: string;
  /**
   * Bumped each time the member key is rotated. Launchpad schedules record it and stop once it
   * changes, so a rotated (revoked) member key also stops scheduled agents.
   */
  keyGeneration: number;
  templateIds: string[];
  /** Shared (admin) accounts granted to this member. Its own accounts are always usable. */
  accountIds: string[];
  createdAt: string;
  updatedAt: string;
  /** null = never expires. */
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/** A template grant bound to the account a session key uses for that tool. */
export interface SessionGrant extends ToolGrant {
  accountId: string;
}

/** Who issued a session key. */
export type SessionIssuer =
  | { kind: 'admin' }
  | { kind: 'member'; memberId: string; memberName: string }
  /** Issued by the agent launchpad for a run it launched on a member's behalf. */
  | { kind: 'launchpad'; memberId: string; memberName: string; runId: string };

export interface Session {
  id: string;
  /** Keyed BLAKE2b hash of the session key; the key itself is never stored. */
  keyHash: string;
  /** Short non-secret prefix to help identify a key in the UI. */
  keyHint: string;
  label: string;
  templateId: string;
  templateName: string;
  /** Snapshot of the template at issuance: later template edits do not widen live sessions. */
  grants: SessionGrant[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  requestCount: number;
  /** Absent on sessions created before members existed: those were issued by the admin. */
  issuedBy?: SessionIssuer;
  /** Most LLM tokens the key may use (see `llmUsage.ts`); null/absent = no budget. */
  tokenBudget?: number | null;
}

/** Browser session after signing in with Google (cookie-based), for the admin or a member. */
export type WebSessionRole = 'admin' | 'member';

export interface WebSession {
  id: string;
  /** Keyed hash of the cookie value. */
  tokenHash: string;
  role: WebSessionRole;
  email: string;
  /** Set for member sessions. */
  memberId: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Bumped whenever the persisted shape changes; see `migrate.ts`. */
export const STORE_VERSION = 3;

export interface StoreState {
  version: typeof STORE_VERSION;
  adminTokenHash: string | null;
  webSessions: WebSession[];
  accounts: Account[];
  templates: Template[];
  sessions: Session[];
  members: Member[];
  /** Non-secret per-tool settings, e.g. `{ github: { oauthClientId: 'Iv1…' } }`. */
  toolSettings: Record<string, ToolSettings>;
}

export interface ToolSettings {
  oauthClientId?: string;
}

export function emptyState(): StoreState {
  return {
    version: STORE_VERSION,
    adminTokenHash: null,
    webSessions: [],
    accounts: [],
    templates: [],
    sessions: [],
    members: [],
    toolSettings: {},
  };
}
