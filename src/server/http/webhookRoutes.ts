import express, { type Response, type Router } from 'express';
import type { Actor } from '../gateway.js';
import type { Webhooks } from '../webhooks.js';
import { created, h, param } from './handlers.js';

const MAX_DELIVERY_BYTES = '1mb';
const WEBHOOK_PATH = '/:id';

/** `POST /hooks/<token>`: public, the address itself is the first secret. */
export function webhookReceiver(webhooks: Webhooks): Router {
  const router = express.Router();
  router.post(
    '/:token',
    express.raw({ type: () => true, limit: MAX_DELIVERY_BYTES }),
    (req, res, next) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      webhooks
        .receive(param(req, 'token'), (name) => req.get(name), body)
        .then((delivery) => {
          res.set('cache-control', 'no-store').status(delivery.status).json(delivery.body);
        })
        .catch(next);
    },
  );
  return router;
}

/** Managing webhooks, for the admin (all) or a member (its own). */
export function webhookRoutes(webhooks: Webhooks, actorOf: (res: Response) => Actor): Router {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));
  router.get(
    '/',
    h((_req, res) => webhooks.list(actorOf(res))),
  );
  router.post(
    '/',
    created((req, res) => webhooks.create(req.body, actorOf(res))),
  );
  router.post(
    `${WEBHOOK_PATH}/rotate`,
    h((req, res) => webhooks.rotate(param(req, 'id'), actorOf(res))),
  );
  router.put(
    `${WEBHOOK_PATH}/auth`,
    h((req, res) => webhooks.setAuth(param(req, 'id'), req.body, actorOf(res))),
  );
  router.delete(
    WEBHOOK_PATH,
    h((req, res) => webhooks.delete(param(req, 'id'), actorOf(res))),
  );
  router.get(
    `${WEBHOOK_PATH}/events`,
    h((req, res) => webhooks.events(param(req, 'id'), actorOf(res))),
  );
  return router;
}
