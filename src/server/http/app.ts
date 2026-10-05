import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { ZodError } from 'zod';
import type { GatewayConfig } from '../config.js';
import { forbidden, HttpError, notFound, unauthorized } from '../errors.js';
import { ADMIN, type Gateway } from '../gateway.js';
import { HTTP, isClientError } from '../httpStatus.js';
import { GoogleSignIn } from '../auth/google.js';
import { adminAuthRoutes, cookieIdentity, CSRF_HEADER } from './adminAuth.js';
import { bearerToken } from './auth.js';
import { created, h, param } from './handlers.js';
import { memberPortalRoutes } from './memberPortalRoutes.js';
import { memberRoutes } from './memberRoutes.js';
import { proxyHandler } from './proxy.js';
import type { Launchpad } from '../launchpad/launchpad.js';
import type { Scheduler } from '../launchpad/scheduler.js';
import { adminLaunchRoutes, runnerRoutes } from '../launchpad/routes.js';

export interface AppOptions {
  /** Used for upstream calls; injectable for tests. */
  fetch?: typeof fetch;
  /** Overrides the Google sign-in built from `config.google` (tests). */
  googleSignIn?: GoogleSignIn | null;
  /** The agent launchpad; its routes are off when absent. */
  launchpad?: Launchpad | null;
  scheduler?: Scheduler | null;
}

export function createApp(
  gateway: Gateway,
  config: GatewayConfig,
  options: AppOptions = {},
): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  mountSessionKeyRoutes(app, gateway, config, options.fetch);
  if (options.launchpad) app.use('/runner', runnerRoutes(options.launchpad));

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
      next(gateway.verifyAdminToken(token) ? undefined : unauthorized('Invalid admin token'));
      return;
    }
    if (cookieIdentity(gateway, req)?.role === 'admin') {
      next(req.get(CSRF_HEADER) === '1' ? undefined : forbidden(`Missing ${CSRF_HEADER} header`));
      return;
    }
    next(unauthorized('Sign in required'));
  });
  admin.use(express.json({ limit: '256kb' }));

  admin.get(
    '/status',
    h(() => ({ ok: true, publicUrl: config.publicUrl })),
  );
  admin.get(
    '/tools',
    h(() => gateway.toolCatalog()),
  );

  admin.put(
    '/tools/:tool/settings',
    h((req) => gateway.updateToolSettings(param(req, 'tool'), req.body)),
  );
  admin.post(
    '/sign-ins',
    created((req) => gateway.signIns.start(req.body, ADMIN)),
  );
  admin.post(
    '/sign-ins/:id/complete',
    created((req) => gateway.signIns.complete(param(req, 'id'), req.body, ADMIN)),
  );
  admin.delete(
    '/sign-ins/:id',
    h((req) => {
      gateway.signIns.cancel(param(req, 'id'), ADMIN);
    }),
  );
  admin.post(
    '/device-flows',
    created((req) => gateway.startDeviceFlow(req.body)),
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
    created((req) => gateway.createAccount(req.body)),
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
    created((req) => gateway.createTemplate(req.body)),
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
    created((req) => gateway.issueSession(req.body)),
  );
  admin.post(
    '/sessions/:id/revoke',
    h((req) => gateway.revokeSession(param(req, 'id'))),
  );

  admin.get(
    '/members',
    h(() => gateway.listMembers()),
  );
  admin.post(
    '/members',
    created((req) => gateway.createMember(req.body)),
  );
  admin.put(
    '/members/:id',
    h((req) => gateway.updateMember(param(req, 'id'), req.body)),
  );
  admin.post(
    '/members/:id/rotate',
    h((req) => gateway.rotateMemberKey(param(req, 'id'))),
  );
  admin.delete(
    '/members/:id',
    h((req) => gateway.deleteMember(param(req, 'id'))),
  );

  admin.get(
    '/activity',
    h(() => gateway.activity.recent()),
  );
  if (options.launchpad) {
    admin.use(
      '/launchpad',
      adminLaunchRoutes(options.launchpad, gateway, options.scheduler ?? null),
    );
  }

  app.use('/api/admin', admin);
  app.use(
    '/api/me',
    memberPortalRoutes(gateway, options.launchpad ?? null, options.scheduler ?? null),
  );
  app.use('/api', memberRoutes(gateway));
  app.use('/api', (_req, _res, next) => {
    next(notFound('Not found'));
  });

  app.use(errorHandler);
  return app;
}

/**
 * The app agent microVMs talk to (bound on the VM bridge): the proxy and session introspection
 * only. No UI, sign-in, admin or member routes, so a compromised agent can't reach them.
 */
export function createVmApp(
  gateway: Gateway,
  config: GatewayConfig,
  options: Pick<AppOptions, 'fetch' | 'launchpad'> = {},
): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  mountSessionKeyRoutes(app, gateway, config, options.fetch);
  if (options.launchpad) app.use('/runner', runnerRoutes(options.launchpad));
  app.use((_req, _res, next) => {
    next(notFound('Not found'));
  });
  app.use(errorHandler);
  return app;
}

/** Routes authenticated by a session key: the tool proxy and key introspection. */
function mountSessionKeyRoutes(
  app: express.Express,
  gateway: Gateway,
  config: GatewayConfig,
  fetchImpl: typeof fetch | undefined,
): void {
  app.all(['/proxy/:tool', '/proxy/:tool/*rest'], proxyHandler(gateway, config, fetchImpl));

  app.get(
    '/api/session',
    h((req) => {
      const key = bearerToken(req);
      if (!key) throw unauthorized('Missing session key');
      const session = gateway.resolveSession(key);
      return {
        id: session.id,
        template: session.templateName,
        expiresAt: session.expiresAt,
        tokenBudget: session.tokenBudget ?? null,
        tokensRemaining: gateway.tokensRemaining(session),
        grants: session.grants.map(({ tool, permissions, resources }) => {
          const resolved = gateway.resolveGrant(session, tool);
          const account = resolved?.account;
          const provider = resolved?.tool;
          return {
            tool,
            kind: provider?.kind ?? 'tool',
            name: provider?.name ?? tool,
            permissionDetails: (provider?.permissions ?? []).filter((p) =>
              permissions.includes(p.id),
            ),
            resourceHelp: provider?.resourceHelp ?? '',
            example: provider?.example ?? null,
            account: account && { label: account.label, identity: account.identity },
            permissions,
            resources,
            proxyBaseUrl: `${config.publicUrl}/proxy/${tool}`,
          };
        }),
      };
    }),
  );
}

export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ZodError) {
    res.status(HTTP.BAD_REQUEST).json({
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
  if (typeof status === 'number' && isClientError(status)) {
    // body-parser errors (malformed JSON, payload too large, …)
    res.status(status).json({ error: 'bad_request', message: (err as Error).message });
    return;
  }
  console.error(err);
  res
    .status(HTTP.INTERNAL_SERVER_ERROR)
    .json({ error: 'internal_error', message: 'Internal gateway error' });
};
