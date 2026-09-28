import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { ZodError } from 'zod';
import type { GatewayConfig } from '../config.js';
import { HttpError } from '../errors.js';
import type { Gateway } from '../gateway.js';
import { GoogleSignIn } from '../auth/google.js';
import { adminAuthRoutes, cookieAdmin, CSRF_HEADER } from './adminAuth.js';
import { bearerToken } from './auth.js';
import { proxyHandler } from './proxy.js';

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;

/** Wraps an async handler: resolved values are sent as JSON, rejections go to the error handler. */
const h =
  (fn: AsyncHandler | ((req: Request, res: Response) => unknown)): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res))
      .then((body) => {
        if (!res.headersSent) {
          if (body === undefined) res.status(204).end();
          else res.json(body);
        }
      })
      .catch(next);
  };

const param = (req: Request, name: string): string => {
  const value = req.params[name];
  if (typeof value !== 'string') throw new HttpError(400, `Missing ${name}`);
  return value;
};

export interface AppOptions {
  /** Used for upstream calls; injectable for tests. */
  fetch?: typeof fetch;
  /** Overrides the Google sign-in built from `config.google` (tests). */
  googleSignIn?: GoogleSignIn | null;
}

export function createApp(
  gateway: Gateway,
  config: GatewayConfig,
  options: AppOptions = {},
): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // ------------------------------------------------------------------ proxy (session keys)
  app.all(['/proxy/:tool', '/proxy/:tool/*rest'], proxyHandler(gateway, config, options.fetch));

  app.get(
    '/api/session',
    h((req) => {
      const key = bearerToken(req);
      if (!key) throw new HttpError(401, 'Missing session key');
      const { session, account } = gateway.resolveSession(key);
      return {
        id: session.id,
        tool: session.tool,
        template: session.templateName,
        account: { label: account.label, identity: account.identity },
        permissions: session.permissions,
        resources: session.resources,
        expiresAt: session.expiresAt,
        proxyBaseUrl: `${config.publicUrl}/proxy/${session.tool}`,
      };
    }),
  );

  // ------------------------------------------------------------------ admin API
  const google =
    options.googleSignIn !== undefined
      ? options.googleSignIn
      : config.google &&
        new GoogleSignIn(config.google, `${config.publicUrl}/auth/google/callback`);
  app.use(adminAuthRoutes(gateway, config, google));

  const admin = express.Router();
  admin.use((_req, res, next) => {
    res.set('cache-control', 'no-store');
    next();
  });
  // Admins authenticate with the admin token (API/scripts) or a Google sign-in session cookie (UI).
  admin.use((req: Request, _res: Response, next: NextFunction) => {
    const token = bearerToken(req);
    if (token) {
      next(gateway.verifyAdminToken(token) ? undefined : new HttpError(401, 'Invalid admin token'));
      return;
    }
    if (cookieAdmin(gateway, req)) {
      next(
        req.get(CSRF_HEADER) === '1'
          ? undefined
          : new HttpError(403, `Missing ${CSRF_HEADER} header`),
      );
      return;
    }
    next(new HttpError(401, 'Sign in required'));
  });
  admin.use(express.json({ limit: '256kb' }));

  admin.get(
    '/status',
    h(() => ({ ok: true, publicUrl: config.publicUrl })),
  );
  admin.get(
    '/tools',
    h(() =>
      gateway.tools.list().map((t) => ({
        id: t.id,
        name: t.name,
        credentialHelp: t.credentialHelp,
        resourceHelp: t.resourceHelp,
        permissions: t.permissions,
        signIn: t.deviceFlow
          ? {
              setupHelp: t.deviceFlow.setupHelp,
              defaultScopes: t.deviceFlow.defaultScopes,
              ...gateway.toolSettings(t.id),
            }
          : null,
      })),
    ),
  );

  admin.put(
    '/tools/:tool/settings',
    h((req) => gateway.updateToolSettings(param(req, 'tool'), req.body)),
  );
  admin.post(
    '/device-flows',
    h(async (req, res) => {
      res.status(201);
      return gateway.startDeviceFlow(req.body);
    }),
  );
  admin.post(
    '/device-flows/:id/poll',
    h((req) => gateway.pollDeviceFlow(param(req, 'id'))),
  );
  admin.delete(
    '/device-flows/:id',
    h((req) => {
      gateway.cancelDeviceFlow(param(req, 'id'));
    }),
  );

  admin.get(
    '/accounts',
    h(() => gateway.listAccounts()),
  );
  admin.post(
    '/accounts',
    h(async (req, res) => {
      res.status(201);
      return gateway.createAccount(req.body);
    }),
  );
  admin.patch(
    '/accounts/:id',
    h((req) => gateway.updateAccount(param(req, 'id'), req.body)),
  );
  admin.post(
    '/accounts/:id/verify',
    h((req) => gateway.reverifyAccount(param(req, 'id'))),
  );
  admin.delete(
    '/accounts/:id',
    h((req) => gateway.deleteAccount(param(req, 'id'))),
  );

  admin.get(
    '/templates',
    h(() => gateway.listTemplates()),
  );
  admin.post(
    '/templates',
    h(async (req, res) => {
      res.status(201);
      return gateway.createTemplate(req.body);
    }),
  );
  admin.put(
    '/templates/:id',
    h((req) => gateway.updateTemplate(param(req, 'id'), req.body)),
  );
  admin.delete(
    '/templates/:id',
    h((req) => gateway.deleteTemplate(param(req, 'id'))),
  );

  admin.get(
    '/sessions',
    h(() => gateway.listSessions()),
  );
  admin.post(
    '/sessions',
    h(async (req, res) => {
      res.status(201);
      return gateway.issueSession(req.body);
    }),
  );
  admin.post(
    '/sessions/:id/revoke',
    h((req) => gateway.revokeSession(param(req, 'id'))),
  );

  admin.get(
    '/activity',
    h(() => gateway.activity.recent()),
  );

  app.use('/api/admin', admin);
  app.use('/api', (_req, _res, next) => {
    next(new HttpError(404, 'Not found'));
  });

  app.use(errorHandler);
  return app;
}

export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'validation_error',
      message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: 'gateway_error', message: err.message });
    return;
  }
  const status = (err as { status?: number }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // body-parser errors (malformed JSON, payload too large, …)
    res.status(status).json({ error: 'bad_request', message: (err as Error).message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: 'Internal gateway error' });
};
