export interface PermissionDef {
  id: string;
  label: string;
  description: string;
}

export interface Grant {
  permissions: readonly string[];
  resources: readonly string[];
}

export type AuthzDecision =
  { allowed: true; permission: string } | { allowed: false; reason: string };

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'complete'; secret: string }
  | { status: 'failed'; message: string };

/** OAuth 2.0 device authorization grant (RFC 8628): lets the admin sign in instead of pasting a token. */
export interface DeviceFlow {
  /** Instructions for registering the OAuth client whose client ID the flow needs. */
  setupHelp: string;
  defaultScopes: string;
  start(clientId: string, scopes: string): Promise<DeviceAuthorization>;
  poll(clientId: string, deviceCode: string): Promise<DevicePollResult>;
}

export interface ToolProvider {
  id: string;
  name: string;
  /** Shown in the admin UI next to the credential field. */
  credentialHelp: string;
  /** Explains what a resource pattern means for this tool. */
  resourceHelp: string;
  permissions: readonly PermissionDef[];
  upstreamBaseUrl: string;

  /** Returns an error message, or null when the pattern is valid. */
  validateResource(pattern: string): string | null;
  /** Checks the credential against the tool and returns identity info to display. */
  verifyCredential(secret: string): Promise<Record<string, string>>;
  /** Decides whether a proxied request is covered by the grant. */
  authorize(method: string, pathSegments: readonly string[], grant: Grant): AuthzDecision;
  /** Headers sent upstream: auth is injected here, everything else is an explicit allowlist. */
  upstreamHeaders(secret: string, incoming: Headers): Headers;
  deviceFlow?: DeviceFlow;
  /** Optional response header rewriting (e.g. pagination links pointing back at the gateway). */
  rewriteResponseHeader?(name: string, value: string, proxyBaseUrl: string): string;
}
