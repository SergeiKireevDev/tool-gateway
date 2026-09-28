import { HTTP_NO_CONTENT, HTTP_UNAUTHORIZED } from './http';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'gateway.adminToken';
const TOKEN_EVENT = 'gateway:token';

/** Admin token kept in sessionStorage (cleared when the tab closes). */
export const tokenStore = {
  get: (): string | null => sessionStorage.getItem(TOKEN_KEY),
  set: (token: string): void => {
    sessionStorage.setItem(TOKEN_KEY, token);
    window.dispatchEvent(new Event(TOKEN_EVENT));
  },
  clear: (): void => {
    sessionStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new Event(TOKEN_EVENT));
  },
  subscribe: (onChange: () => void): (() => void) => {
    window.addEventListener(TOKEN_EVENT, onChange);
    return () => {
      window.removeEventListener(TOKEN_EVENT, onChange);
    };
  },
};

export type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/**
 * Admin API client. With an admin token it authenticates with a bearer header; without one it
 * relies on the Google sign-in session cookie. The CSRF header is required for cookie sessions.
 */
/** Admin API, or the member portal API when a member is signed in: same paths, other base. */
export const ADMIN_API = '/api/admin';
export const MEMBER_API = '/api/me';

export function createApi(
  token: string | null,
  onUnauthorized: () => void,
  base: string = ADMIN_API,
): Api {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'x-gateway-request': '1',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    if (res.status === HTTP_UNAUTHORIZED) onUnauthorized();
    if (res.status === HTTP_NO_CONTENT) return undefined as T;
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, errorMessage(data, res.status));
    return data as T;
  };
}

function errorMessage(data: unknown, status: number): string {
  return data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
    ? data.message
    : `Request failed (HTTP ${status})`;
}

/** Who is signed in with Google (session cookie): the admin or a member. */
export type WebUser =
  | { role: 'admin'; email: string; expiresAt: string }
  | { role: 'member'; email: string; expiresAt: string; memberId: string; memberName: string };

export async function fetchWebUser(): Promise<WebUser | null> {
  const res = await fetch('/api/auth/me', { cache: 'no-store' });
  if (res.status === HTTP_UNAUTHORIZED) return null;
  if (!res.ok) throw new ApiError(res.status, `Request failed (HTTP ${res.status})`);
  return (await res.json()) as WebUser;
}

export async function fetchAuthConfig(): Promise<{ google: boolean }> {
  const res = await fetch('/api/auth/config', { cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status, `Request failed (HTTP ${res.status})`);
  return (await res.json()) as { google: boolean };
}

export async function signOutGoogle(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-gateway-request': '1' } });
}
