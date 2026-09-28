import express, { type Response, type Router } from 'express';
import type { Gateway } from '../gateway.js';
import type { Member } from '../store/types.js';
import { bearerToken } from './auth.js';
import { created, h, param } from './handlers.js';

const memberOf = (res: Response): Member => res.locals.member as Member;

/**
 * Self-serve API for members (`Authorization: Bearer gwm_…`): discover what they may request,
 * issue session keys within those limits, and list/revoke the keys they issued.
 */
export function memberRoutes(gateway: Gateway): Router {
  const router = express.Router();
  // Auth is scoped to the member paths so other /api/* paths still answer 404, not 401.
  router.use(
    ['/member', '/sessions'],
    (req, res, next) => {
      try {
        res.locals.member = gateway.resolveMember(bearerToken(req) ?? '');
        res.set('cache-control', 'no-store');
        next();
      } catch (err) {
        next(err);
      }
    },
    express.json({ limit: '16kb' }),
  );

  router.get(
    '/member',
    h((_req, res) => gateway.memberView(memberOf(res))),
  );
  router.post(
    '/sessions',
    created((req, res) => gateway.issueSessionAsMember(memberOf(res), req.body)),
  );
  router.get(
    '/sessions',
    h((_req, res) => gateway.listMemberSessions(memberOf(res))),
  );
  router.post(
    '/sessions/:id/revoke',
    h((req, res) => gateway.revokeMemberSession(memberOf(res), param(req, 'id'))),
  );
  return router;
}
