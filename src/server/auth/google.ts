/**
 * Admin sign-in with Google (OpenID Connect, authorization code flow + PKCE).
 * All protocol work — discovery, PKCE, state/nonce checks, ID token validation — is done by
 * `openid-client`; this module only tracks pending logins and returns the verified email.
 * Deciding what that email may do (admin, member, or nothing) is up to the caller.
 */
import * as oidc from 'openid-client';
import type { GoogleSignInConfig } from '../config.js';
import { randomToken } from '../store/crypto.js';
import { MS_PER_MINUTE } from '../units.js';

const GOOGLE_ISSUER = new URL('https://accounts.google.com');
const LOGIN_TTL_MINUTES = 10;
/** How long a started Google sign-in stays valid (also the login cookie lifetime). */
export const LOGIN_TTL_MS = LOGIN_TTL_MINUTES * MS_PER_MINUTE;
const LOGIN_ID_BYTES = 24;
/** The login endpoint is unauthenticated: bound the number of pending logins kept in memory. */
const MAX_PENDING_LOGINS = 100;

/** A sign-in failure whose message is safe to show to the user. */
export class SignInError extends Error {}

interface PendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

export class GoogleSignIn {
  private configuration: Promise<oidc.Configuration> | null = null;
  private readonly pending = new Map<string, PendingLogin>();

  constructor(
    private readonly config: GoogleSignInConfig,
    readonly redirectUri: string,
    private readonly discover: () => Promise<oidc.Configuration> = () =>
      oidc.discovery(GOOGLE_ISSUER, config.clientId, config.clientSecret),
    private readonly now: () => number = Date.now,
  ) {}

  /** Discovery is lazy (first sign-in) and retried if it failed. */
  private getConfiguration(): Promise<oidc.Configuration> {
    this.configuration ??= this.discover().catch((err: unknown) => {
      this.configuration = null;
      throw err;
    });
    return this.configuration;
  }

  /** Starts a login. The returned `loginId` must be bound to the browser (cookie). */
  async begin(): Promise<{ loginId: string; authorizationUrl: URL }> {
    const configuration = await this.getConfiguration().catch((err: unknown) => {
      console.error('Google discovery failed', err);
      throw new SignInError('Could not reach Google, try again');
    });
    this.prune();
    if (this.pending.size >= MAX_PENDING_LOGINS) {
      throw new SignInError('Too many sign-in attempts in progress, try again in a few minutes');
    }
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const authorizationUrl = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri,
      scope: 'openid email',
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
      prompt: 'select_account',
    });
    const loginId = randomToken('', LOGIN_ID_BYTES);
    this.pending.set(loginId, { state, nonce, codeVerifier, expiresAt: this.now() + LOGIN_TTL_MS });
    return { loginId, authorizationUrl };
  }

  /** Completes a login from Google's redirect and returns the verified (lower-cased) email. */
  async complete(loginId: string | undefined, callbackUrl: URL): Promise<string> {
    const login = loginId ? this.pending.get(loginId) : undefined;
    if (loginId) this.pending.delete(loginId);
    if (!login || login.expiresAt <= this.now()) {
      throw new SignInError('Sign-in expired or was started in another browser, try again');
    }
    const googleError = callbackUrl.searchParams.get('error');
    if (googleError) {
      throw new SignInError(
        googleError === 'access_denied' ? 'Sign-in was cancelled' : `Google error: ${googleError}`,
      );
    }

    let claims;
    try {
      const tokens = await oidc.authorizationCodeGrant(await this.getConfiguration(), callbackUrl, {
        pkceCodeVerifier: login.codeVerifier,
        expectedState: login.state,
        expectedNonce: login.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (err) {
      console.error('Google sign-in failed', err);
      throw new SignInError('Google sign-in failed, try again');
    }

    const email = typeof claims?.email === 'string' ? claims.email.toLowerCase() : null;
    if (!email || claims?.email_verified !== true) {
      throw new SignInError('Your Google account has no verified email address');
    }
    return email;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, login] of this.pending) {
      if (login.expiresAt <= now) this.pending.delete(id);
    }
  }
}
