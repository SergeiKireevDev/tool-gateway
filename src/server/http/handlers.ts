import type { Request, RequestHandler, Response } from 'express';
import { badRequest } from '../errors.js';
import { HTTP } from '../httpStatus.js';

type Handler = (req: Request, res: Response) => unknown;

/** Wraps a (possibly async) handler: returned values are sent as JSON, errors go to `next`. */
export const h =
  (fn: Handler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .then((body) => {
        if (!res.headersSent) {
          if (body === undefined) res.status(HTTP.NO_CONTENT).end();
          else res.json(body);
        }
      })
      .catch(next);
  };

/** Like `h`, but answers 201 Created. */
export const created = (fn: Handler): RequestHandler =>
  h((req, res) => {
    res.status(HTTP.CREATED);
    return fn(req, res);
  });

export const param = (req: Request, name: string): string => {
  const value = req.params[name];
  if (typeof value !== 'string') throw badRequest(`Missing ${name}`);
  return value;
};
