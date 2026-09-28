export interface Account {
  id: string;
  tool: string;
  label: string;
  /** Third-party credential. Only ever persisted inside the encrypted store. */
  secret: string;
  /** Tool-specific identity info gathered when the account was verified. */
  identity: Record<string, string>;
  createdAt: string;
  lastVerifiedAt: string;
}

export interface Template {
  id: string;
  tool: string;
  name: string;
  description: string;
  permissions: string[];
  /** Resource allowlist, e.g. `octo-org/*` or `octo-org/repo` for GitHub. Empty = unrestricted. */
  resources: string[];
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  /** Keyed BLAKE2b hash of the session key; the key itself is never stored. */
  keyHash: string;
  /** Short non-secret prefix to help identify a key in the UI. */
  keyHint: string;
  label: string;
  tool: string;
  accountId: string;
  templateId: string;
  templateName: string;
  /** Snapshot of the template at issuance: later template edits do not widen live sessions. */
  permissions: string[];
  resources: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  requestCount: number;
}

/** Browser session of a signed-in admin (cookie-based). */
export interface AdminWebSession {
  id: string;
  /** Keyed hash of the cookie value. */
  tokenHash: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

export interface StoreState {
  version: 1;
  adminTokenHash: string | null;
  adminSessions: AdminWebSession[];
  accounts: Account[];
  templates: Template[];
  sessions: Session[];
  /** Non-secret per-tool settings, e.g. `{ github: { oauthClientId: 'Iv1…' } }`. */
  toolSettings: Record<string, ToolSettings>;
}

export interface ToolSettings {
  oauthClientId?: string;
}

export function emptyState(): StoreState {
  return {
    version: 1,
    adminTokenHash: null,
    adminSessions: [],
    accounts: [],
    templates: [],
    sessions: [],
    toolSettings: {},
  };
}
