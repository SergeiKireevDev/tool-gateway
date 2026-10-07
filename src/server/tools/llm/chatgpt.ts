import { HTTP } from '../../httpStatus.js';
import { SECONDS_PER_MINUTE } from '../../units.js';
import { isRecord } from '../json.js';
import type { DeviceFlow, DevicePollResult, OAuthTokens } from '../types.js';

/**
 * "Sign in with ChatGPT" (Codex, ChatGPT Plus/Pro/Team): OAuth device code flow with the public
 * client Codex CLI uses, and the ChatGPT backend that serves Codex's Responses calls for such
 * accounts. API keys keep using api.openai.com.
 */

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH = 'https://auth.openai.com';
const USER_CODE_URL = `${AUTH}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${AUTH}/oauth/token`;
const VERIFICATION_URI = `${AUTH}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH}/deviceauth/callback`;
/** Codex's device codes last 15 minutes. */
const DEVICE_CODE_TTL_MINUTES = 15;
const DEVICE_CODE_TTL_SECONDS = DEVICE_CODE_TTL_MINUTES * SECONDS_PER_MINUTE;
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_SECONDS = 10;
const JWT_PARTS = 3;
const AUTH_CLAIM = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';
const PENDING_STATUSES = new Set<number>([HTTP.FORBIDDEN, HTTP.NOT_FOUND]);

export const CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

/** Claims of a ChatGPT access token (a JWT), or null when the secret isn't one. */
function claimsOf(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== JWT_PARTS || !parts[1]) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return isRecord(json) ? json : null;
  } catch {
    return null;
  }
}

/** The ChatGPT account a sign-in token belongs to; null for API keys. */
export function chatgptAccountId(secret: string): string | null {
  const auth = claimsOf(secret)?.[AUTH_CLAIM];
  const id = isRecord(auth) ? auth.chatgpt_account_id : undefined;
  return typeof id === 'string' && id !== '' ? id : null;
}

function identityOf(access: string): Record<string, string> {
  const claims = claimsOf(access) ?? {};
  const identity: Record<string, string> = { keyType: 'ChatGPT subscription (sign-in)' };
  const profile = claims[PROFILE_CLAIM];
  if (isRecord(profile) && typeof profile.email === 'string') identity.login = profile.email;
  const auth = claims[AUTH_CLAIM];
  if (isRecord(auth) && typeof auth.chatgpt_plan_type === 'string')
    identity.plan = auth.chatgpt_plan_type;
  return identity;
}

/** The device flow's handle: the device auth id and the user code, both needed to poll. */
interface DeviceHandle {
  deviceAuthId: string;
  userCode: string;
}

export function createChatGptDeviceFlow(fetchImpl: typeof fetch): DeviceFlow {
  const json = async (url: string, body: Record<string, string>): Promise<Response> =>
    fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });

  const tokens = async (body: Record<string, string>): Promise<OAuthTokens> => {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...body }).toString(),
    });
    const data: unknown = await res.json().catch(() => null);
    if (
      !res.ok ||
      !isRecord(data) ||
      typeof data.access_token !== 'string' ||
      typeof data.refresh_token !== 'string'
    ) {
      throw new Error(`ChatGPT sign-in failed (HTTP ${res.status})`);
    }
    if (!chatgptAccountId(data.access_token)) throw new Error('The token has no ChatGPT account');
    return {
      access: data.access_token,
      refresh: data.refresh_token,
      expiresInSeconds: typeof data.expires_in === 'number' ? data.expires_in : 0,
      identity: identityOf(data.access_token),
    };
  };

  return {
    label: 'Sign in with ChatGPT',
    setupHelp:
      'Uses your ChatGPT subscription (Plus, Pro, Team…), like Codex does: open the link, enter the code, approve. No OAuth app to set up.',
    registerUrl: VERIFICATION_URI,
    defaultScopes: '',
    builtInClientId: CLIENT_ID,

    async start() {
      const res = await json(USER_CODE_URL, { client_id: CLIENT_ID });
      const data: unknown = await res.json().catch(() => null);
      if (
        !res.ok ||
        !isRecord(data) ||
        typeof data.device_auth_id !== 'string' ||
        typeof data.user_code !== 'string'
      ) {
        throw new Error(`OpenAI answered HTTP ${res.status}`);
      }
      const interval = Number(data.interval);
      const handle: DeviceHandle = { deviceAuthId: data.device_auth_id, userCode: data.user_code };
      return {
        deviceCode: JSON.stringify(handle),
        userCode: data.user_code,
        verificationUri: VERIFICATION_URI,
        expiresIn: DEVICE_CODE_TTL_SECONDS,
        interval: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_SECONDS,
      };
    },

    async poll(_clientId, deviceCode): Promise<DevicePollResult> {
      const handle = JSON.parse(deviceCode) as DeviceHandle;
      const res = await json(DEVICE_TOKEN_URL, {
        device_auth_id: handle.deviceAuthId,
        user_code: handle.userCode,
      });
      // Not approved yet: OpenAI answers 403/404 until the user enters the code.
      if (PENDING_STATUSES.has(res.status)) return { status: 'pending' };
      const data: unknown = await res.json().catch(() => null);
      const error = isRecord(data)
        ? isRecord(data.error)
          ? data.error.code
          : data.error
        : undefined;
      if (error === 'deviceauth_authorization_pending') return { status: 'pending' };
      if (error === 'slow_down') return { status: 'slow_down', interval: SLOW_DOWN_SECONDS };
      if (
        !res.ok ||
        !isRecord(data) ||
        typeof data.authorization_code !== 'string' ||
        typeof data.code_verifier !== 'string'
      ) {
        return { status: 'failed', message: `OpenAI sign-in failed (HTTP ${res.status})` };
      }
      const signedIn = await tokens({
        grant_type: 'authorization_code',
        code: data.authorization_code,
        code_verifier: data.code_verifier,
        redirect_uri: DEVICE_REDIRECT_URI,
      });
      return { status: 'complete', secret: signedIn.access, tokens: signedIn };
    },

    refresh: (refreshToken) => tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  };
}

/** Headers for the ChatGPT backend, as Codex sends them for a signed-in account. */
export function chatgptHeaders(secret: string, incoming: Headers): Headers {
  const headers = new Headers({
    'content-type': 'application/json',
    accept: incoming.get('accept') ?? 'text/event-stream',
    'user-agent': 'local-gateway',
    'openai-beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    authorization: `Bearer ${secret}`,
  });
  const account = chatgptAccountId(secret);
  if (account) headers.set('chatgpt-account-id', account);
  return headers;
}
