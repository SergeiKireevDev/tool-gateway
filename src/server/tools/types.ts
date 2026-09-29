export interface PermissionDef {
  id: string;
  label: string;
  description: string;
}

export interface Grant {
  permissions: readonly string[];
  resources: readonly string[];
}

/** A proxied request, as seen by a tool when deciding whether a grant covers it. */
export interface ToolRequest {
  method: string;
  /** Decoded path segments, already rejected if ambiguous (see `parseSafePath`). */
  segments: readonly string[];
  /** Raw query string including the leading `?`, or `''`. */
  search: string;
  headers: Headers;
  body: Buffer | undefined;
}

/** What a tool may use while authorizing: the session it runs for and its upstream credential. */
export interface ToolRequestContext {
  sessionId: string;
  /** Only for lookups the decision depends on (e.g. which board an item is on). Never log it. */
  secret: string;
}

export interface AuthzAllowed {
  allowed: true;
  /** Permission(s) that covered the request, for the activity log. */
  permission: string;
  /** What the request does, when the path alone doesn't say (e.g. GraphQL operations). */
  detail?: string;
  /**
   * Body to send upstream instead of the client's. Tools that inspect the body return the
   * re-serialized form they checked, so the upstream can't read it differently.
   */
  body?: Buffer;
  /** HTTP method to use upstream instead of the client's (e.g. when parameters moved to the body). */
  method?: string;
  /** Query string (with `?`, or `''`) to send upstream instead of the client's. */
  search?: string;
  /** Called with the parsed JSON response of an allowed request (e.g. to remember cursors). */
  observeResponse?: (json: unknown) => void;
}

export type AuthzDecision = AuthzAllowed | { allowed: false; reason: string };

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
  /** Where the OAuth client is registered. */
  registerUrl: string;
  defaultScopes: string;
  start(clientId: string, scopes: string): Promise<DeviceAuthorization>;
  poll(clientId: string, deviceCode: string): Promise<DevicePollResult>;
}

export interface ToolExample {
  method: 'GET' | 'POST';
  path: string;
  /** JSON request body, for POST examples. */
  body?: string;
  /** Client library hint, e.g. `Octokit baseUrl`. */
  clientHint: string;
}

export interface ToolProvider {
  id: string;
  name: string;
  /** Shown in the admin UI next to the credential field. */
  credentialHelp: string;
  /** Placeholder for the credential field, e.g. the token's prefix. */
  credentialPlaceholder: string;
  /** Explains what a resource pattern means for this tool. */
  resourceHelp: string;
  permissions: readonly PermissionDef[];
  upstreamBaseUrl: string;
  /** Example call through the gateway, relative to the tool's proxy base URL. */
  example: ToolExample;

  /** Returns an error message, or null when the pattern is valid. */
  validateResource(pattern: string): string | null;
  /** Checks the credential against the tool and returns identity info to display. */
  verifyCredential(secret: string): Promise<Record<string, string>>;
  /** Decides whether a proxied request is covered by the grant. Deny anything not understood. */
  authorize(
    request: ToolRequest,
    grant: Grant,
    context: ToolRequestContext,
  ): AuthzDecision | Promise<AuthzDecision>;
  /** Headers sent upstream: auth is injected here, everything else is an explicit allowlist. */
  upstreamHeaders(secret: string, incoming: Headers): Headers;
  deviceFlow?: DeviceFlow;
  /** Optional response header rewriting (e.g. pagination links pointing back at the gateway). */
  rewriteResponseHeader?(name: string, value: string, proxyBaseUrl: string): string;
}
