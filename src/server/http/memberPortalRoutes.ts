import express, { type Response, type Router } from 'express';
import { forbidden, unauthorized } from '../errors.js';
import type { Actor, Gateway } from '../gateway.js';
import type { Member } from '../store/types.js';
import { cookieIdentity, CSRF_HEADER } from './adminAuth.js';
import type { Launchpad } from '../launchpad/launchpad.js';
import { memberLaunchRoutes } from '../launchpad/routes.js';
import { created, h, param } from './handlers.js';

const memberOf = (res: Response): Member => res.locals.member as Member;
const actorOf = (res: Response): Actor => ({ kind: 'member', member: memberOf(res) });

/**
 * The member portal API, for members signed in with Google (session cookie). Paths mirror the
 * admin API so the UI can reuse its screens; every operation is scoped to the signed-in member.
 */
export function memberPortalRoutes(gateway: Gateway, launchpad: Launchpad | null): Router {
  const router = express.Router();
  router.use((req, res, next) => {
    const identity = cookieIdentity(gateway, req);
    if (identity?.role !== 'member') {
      next(unauthorized('Member sign-in required'));
      return;
    }
    if (req.get(CSRF_HEADER) !== '1') {
      next(forbidden(`Missing ${CSRF_HEADER} header`));
      return;
    }
    res.locals.member = identity.member;
    res.set('cache-control', 'no-store');
    next();
  });
  router.use(express.json({ limit: '64kb' }));

  router.get(
    '/',
    h((_req, res) => gateway.memberView(memberOf(res))),
  );
  // No key rotation here: members never handle their member key, only the admin rotates it.
  router.get(
    '/tools',
    h(() => gateway.toolCatalog()),
  );
  router.get(
    '/templates',
    h((_req, res) => gateway.memberView(memberOf(res)).templates),
  );

  // Accounts: the member's own, plus shared accounts granted to it (read-only for the member).
  router.get(
    '/accounts',
    h((_req, res) => gateway.listAccountsFor(memberOf(res))),
  );
  router.post(
    '/accounts',
    created((req, res) => gateway.createAccount(req.body, actorOf(res))),
  );
  router.patch(
    '/accounts/:id',
    h((req, res) => gateway.updateAccount(param(req, 'id'), req.body, actorOf(res))),
  );
  router.post(
    '/accounts/:id/verify',
    h((req, res) => gateway.reverifyAccount(param(req, 'id'), actorOf(res))),
  );
  router.delete(
    '/accounts/:id',
    h((req, res) => gateway.deleteAccount(param(req, 'id'), actorOf(res))),
  );
  router.post(
    '/device-flows',
    created((req, res) => gateway.startDeviceFlow(req.body, actorOf(res))),
  );
  router.post(
    '/device-flows/:id/poll',
    h((req, res) => gateway.pollDeviceFlow(param(req, 'id'), actorOf(res))),
  );
  router.delete(
    '/device-flows/:id',
    h((req, res) => {
      gateway.cancelDeviceFlow(param(req, 'id'), actorOf(res));
    }),
  );

  if (launchpad) router.use('/launchpad', memberLaunchRoutes(launchpad, gateway));

  // Session keys issued by this member.
  router.get(
    '/sessions',
    h((_req, res) => gateway.listMemberSessions(memberOf(res))),
  );
  router.post(
    '/sessions',
    created((req, res) => gateway.issueSessionAsMember(memberOf(res), req.body)),
  );
  router.post(
    '/sessions/:id/revoke',
    h((req, res) => gateway.revokeMemberSession(memberOf(res), param(req, 'id'))),
  );
  return router;
}
