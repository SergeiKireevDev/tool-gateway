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
  /** LLM tokens the session may still use, or null when it has no token budget. */
  tokensRemaining: number | null;
}

/** Tokens one LLM call used, normalized across providers (cached input is not counted twice). */
export interface TokenUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Reads an LLM response as it streams through the proxy (SSE or JSON) and reports the tokens it
 * used once it ends. Sees the bytes but never changes them.
 */
export interface UsageMeter {
  write(chunk: Uint8Array): void;
  /** Usage seen so far (also after an aborted stream), or null when the response had none. */
  end(): TokenUsage | null;
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
  /**
   * Absolute upstream URL to call instead of `upstreamBaseUrl` + path + query (e.g. git traffic,
   * which goes to github.com rather than the API host). Built by the tool from checked segments.
   */
  upstreamUrl?: string;
  /** Headers to send upstream instead of the tool's `upstreamHeaders` (same rules apply). */
  upstreamHeaders?: (secret: string, incoming: Headers) => Headers;
  /** LLM calls: meters the (streamed) response, given its content type, for token budgets. */
  meter?: (contentType: string) => UsageMeter;
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
  /** `tokens` for sign-ins that return refreshable OAuth tokens (the gateway refreshes them). */
  | { status: 'complete'; secret: string; tokens?: OAuthTokens }
  | { status: 'failed'; message: string };

/** OAuth 2.0 device authorization grant (RFC 8628): lets the admin sign in instead of pasting a token. */
export interface DeviceFlow {
  /** Instructions for registering the OAuth client whose client ID the flow needs. */
  setupHelp: string;
  /** Where the OAuth client is registered. */
  registerUrl: string;
  defaultScopes: string;
  /** A public client ID the tool's own CLI uses: no OAuth app to register. */
  builtInClientId?: string;
  /** Label of the sign-in button, e.g. "Sign in with ChatGPT". */
  label?: string;
  start(clientId: string, scopes: string): Promise<DeviceAuthorization>;
  poll(clientId: string, deviceCode: string): Promise<DevicePollResult>;
  /** Renews tokens a completed flow returned (see `DevicePollResult.tokens`). */
  refresh?(refreshToken: string): Promise<OAuthTokens>;
}

/** Tokens from an OAuth sign-in; the access token is the account's secret. */
export interface OAuthTokens {
  access: string;
  refresh: string;
  /** How long the access token lasts, in seconds (the gateway refreshes it a little earlier). */
  expiresInSeconds: number;
  /** Who signed in (e.g. email, organization), shown in the UI. */
  identity: Record<string, string>;
}

/**
 * OAuth authorization-code sign-in with PKCE, completed by pasting the redirect URL (or code) back:
 * the redirect goes to the user's own machine, not to the gateway.
 */
export interface OAuthSignIn {
  /** Explains the steps in the UI. */
  help: string;
  /**
   * The provider redirects back to the gateway (`GOOGLE_CALLBACK_PATH`), which hands the code to
   * the dialog that started the sign-in; otherwise the user pastes the address they landed on.
   */
  redirectsBack?: boolean;
  authorizeUrl(challenge: string, state: string): string;
  exchange(code: string, state: string, verifier: string): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
}

export interface ToolExample {
  method: 'GET' | 'POST';
  path: string;
  /** JSON request body, for POST examples. */
  body?: string;
  /** Client library hint, e.g. `Octokit baseUrl`. */
  clientHint: string;
}

/** Chat API dialects a custom LLM endpoint can speak. */
export const LLM_ENDPOINT_APIS = ['openai', 'anthropic'] as const;
export type LlmEndpointApi = (typeof LLM_ENDPOINT_APIS)[number];

/**
 * A model API at an address of the admin's choosing (a self-hosted or third-party server),
 * configured in the template grant itself rather than through an account.
 */
export interface LlmEndpoint {
  /** Base URL: requests go to `<url>/v1/…`, like the official API they mimic. */
  url: string;
  api: LlmEndpointApi;
  /** Sent upstream as `Authorization: Bearer …`; empty = no credential. Never returned by the API. */
  token: string;
}

export interface ToolProvider {
  id: string;
  name: string;
  /** `llm`: a model API used by agents themselves, not offered to them as a tool. */
  kind?: 'tool' | 'llm';
  /**
   * Request headers that may carry the session key besides `Authorization` (e.g. `x-api-key`),
   * so clients that send their API key their own way can use a session key unchanged.
   */
  sessionKeyHeaders?: readonly string[];
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
  /** "Sign in with …" through OAuth (tokens are refreshed by the gateway). */
  oauthSignIn?: OAuthSignIn;
  /**
   * Tools whose upstream is configured per grant (custom LLM endpoints) rather than by an
   * account: returns the provider that serves one endpoint.
   */
  bindEndpoint?(endpoint: LlmEndpoint): ToolProvider;
  /** Optional response header rewriting (e.g. pagination links pointing back at the gateway). */
  rewriteResponseHeader?(name: string, value: string, proxyBaseUrl: string): string;
}
