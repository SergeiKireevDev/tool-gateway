import { HTTP } from './httpStatus.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string): HttpError => new HttpError(HTTP.BAD_REQUEST, msg);
export const unauthorized = (msg: string): HttpError => new HttpError(HTTP.UNAUTHORIZED, msg);
export const forbidden = (msg: string): HttpError => new HttpError(HTTP.FORBIDDEN, msg);
export const notFound = (msg: string): HttpError => new HttpError(HTTP.NOT_FOUND, msg);
export const conflict = (msg: string): HttpError => new HttpError(HTTP.CONFLICT, msg);
export const unprocessable = (msg: string): HttpError =>
  new HttpError(HTTP.UNPROCESSABLE_ENTITY, msg);
export const badGateway = (msg: string): HttpError => new HttpError(HTTP.BAD_GATEWAY, msg);
