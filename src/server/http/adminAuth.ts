import { parseCookie } from 'cookie';
import express, { type CookieOptions, type Request, type Response, type Router } from 'express';
import { LOGIN_TTL_MS, SignInError, type GoogleSignIn } from '../auth/google.js';
import type { GatewayConfig } from '../config.js';
import type { Gateway } from '../gateway.js';
import { HTTP } from '../httpStatus.js';

export const ADMIN_COOKIE = 'gw_admin';
const LOGIN_COOKIE = 'gw_login';
const LOGIN_COOKIE_PATH = '/auth/google';
/**
 * Cookie-authenticated API calls must carry this header. Browsers can't add custom headers to
 * cross-site requests without a CORS preflight (which the gateway never grants), so this blocks
 * CSRF on top of SameSite=Strict.
 */
export const CSRF_HEADER = 'x-gateway-request';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.get('cookie');
  return header ? parseCookie(header)[name] : undefined;
}

export interface CookieAdmin {
  email: string;
  expiresAt: string;
}

/** Resolves the admin behind the session cookie, if any (does not check the CSRF header). */
export function cookieAdmin(gateway: Gateway, req: Request): CookieAdmin | null {
  const token = readCookie(req, ADMIN_COOKIE);
  return token ? gateway.resolveAdminWebSession(token) : null;
}

export function adminAuthRoutes(
  gateway: Gateway,
  config: GatewayConfig,
  google: GoogleSignIn | null,
): Router {
  const router = express.Router();
  const publicUrl = new URL(config.publicUrl);
  const secure = publicUrl.protocol === 'https:';
  const base: CookieOptions = { httpOnly: true, secure };

  // ---- JSON endpoints used by the login screen
  router.get('/api/auth/config', (_req, res) => {
    res.json({ google: google !== null });
  });

  router.get('/api/auth/me', (req, res) => {
    const admin = cookieAdmin(gateway, req);
    if (!admin) {
      res.status(HTTP.UNAUTHORIZED).json({ error: 'gateway_error', message: 'Not signed in' });
      return;
    }
    res.json({ method: 'google', ...admin });
  });

  router.post('/api/auth/logout', (req, res, next) => {
    if (req.get(CSRF_HEADER) !== '1') {
      res
        .status(HTTP.FORBIDDEN)
        .json({ error: 'forbidden', message: `Missing ${CSRF_HEADER} header` });
      return;
    }
    const token = readCookie(req, ADMIN_COOKIE);
    res.clearCookie(ADMIN_COOKIE, { ...base, sameSite: 'strict', path: '/' });
    (token ? gateway.endAdminWebSession(token) : Promise.resolve())
      .then(() => res.status(HTTP.NO_CONTENT).end())
      .catch(next);
  });

  // ---- Browser navigations for the OIDC redirect dance
  const failed = (res: Response, message: string): void => {
    res.redirect(HTTP.SEE_OTHER, `/?login_error=${encodeURIComponent(message)}`);
  };

  router.get(`${LOGIN_COOKIE_PATH}/login`, (req, res, next) => {
    if (!google) {
      failed(res, 'Google sign-in is not configured');
      return;
    }
    // Cookies are per host: run the whole flow on the host Google redirects back to.
    if (req.get('host') !== publicUrl.host) {
      res.redirect(HTTP.FOUND, `${config.publicUrl}${LOGIN_COOKIE_PATH}/login`);
      return;
    }
    google
      .begin()
      .then(({ loginId, authorizationUrl }) => {
        res.cookie(LOGIN_COOKIE, loginId, {
          ...base,
          // Lax: the cookie must come back on Google's top-level redirect to the callback.
          sameSite: 'lax',
          path: LOGIN_COOKIE_PATH,
          maxAge: LOGIN_TTL_MS,
        });
        res.redirect(HTTP.FOUND, authorizationUrl.href);
      })
      .catch((err: unknown) => {
        if (err instanceof SignInError) failed(res, err.message);
        else next(err);
      });
  });

  router.get(`${LOGIN_COOKIE_PATH}/callback`, (req, res, next) => {
    if (!google) {
      failed(res, 'Google sign-in is not configured');
      return;
    }
    const loginId = readCookie(req, LOGIN_COOKIE);
    res.clearCookie(LOGIN_COOKIE, { ...base, sameSite: 'lax', path: LOGIN_COOKIE_PATH });
    google
      .complete(loginId, new URL(req.originalUrl, config.publicUrl))
      .then((email) => gateway.createAdminWebSession(email))
      .then(({ token, expiresAt }) => {
        res.cookie(ADMIN_COOKIE, token, {
          ...base,
          sameSite: 'strict',
          path: '/',
          expires: expiresAt,
        });
        res.redirect(HTTP.SEE_OTHER, '/');
      })
      .catch((err: unknown) => {
        if (err instanceof SignInError) failed(res, err.message);
        else next(err);
      });
  });

  return router;
}
