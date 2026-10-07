import { z } from 'zod';
import type { ActivityLog } from './activity.js';
import type { Database } from './db/database.js';
import { redactDeep } from './db/redact.js';
import { badRequest, notFound } from './errors.js';
import type { Actor } from './gateway.js';
import { HTTP } from './httpStatus.js';
import {
  CryptoBox,
  fromBase64Url,
  randomId,
  randomToken,
  verifyHmacSha256,
} from './store/crypto.js';
import type { EncryptedStore } from './store/store.js';
import type { Webhook, WebhookAuth, WebhookSource } from './store/types.js';
import { isRecord } from './tools/json.js';
import { BYTES_PER_KIB, MS_PER_MINUTE, MS_PER_SECOND } from './units.js';

/**
 * Inbound webhooks: `POST <publicUrl>/hooks/<token>`. Every webhook has a hard-to-guess address
 * (256 random bits, only its keyed hash is stored) and may also require an `Authorization` check:
 * a JWT signed with a shared secret (monday.com apps) or a bearer secret. Every delivery is
 * logged, accepted or not; accepted payloads are kept (redacted, size-capped) for triggers.
 */

const TOKEN_BYTES = 32;
const SECRET_PREFIX = 'gwk_';
const MAX_NAME = 100;
const MAX_SIGNING_SECRET = 500;
const MAX_PAYLOAD_KIB = 64;
const MAX_PAYLOAD_CHARS = MAX_PAYLOAD_KIB * BYTES_PER_KIB;
const MAX_REASON_CHARS = 300;
const DEFAULT_EVENTS = 100;
const MAX_EVENTS = 1000;
/** Deliveries accepted per webhook and minute; more get 429. */
const RATE_PER_MINUTE = 120;
/** Clock skew tolerated on JWT `exp` / `iat`. */
const JWT_LEEWAY_SECONDS = 60;
const JWT_PARTS = 3;
const WEBHOOK_NOT_FOUND = 'Webhook not found';

const name = z.string().trim().min(1).max(MAX_NAME);
const source = z.enum(['monday', 'linear', 'github', 'generic']);
const signingSecret = z.string().trim().min(1).max(MAX_SIGNING_SECRET);

export const webhookSchema = z
  .discriminatedUnion('auth', [
    z.object({ name, source, auth: z.literal('url') }),
    /** e.g. the Signing Secret of the monday.com app that creates the webhook. */
    z.object({ name, source, auth: z.literal('jwt'), signingSecret }),
    z.object({ name, source, auth: z.literal('bearer') }),
    /** The webhook's signing secret, as shown by Linear or set in GitHub. */
    z.object({ name, source, auth: z.literal('hmac'), signingSecret }),
  ])
  .refine((w) => w.auth !== 'hmac' || w.source in SIGNATURE_HEADERS, {
    message: 'Signed bodies are checked for Linear and GitHub webhooks',
    path: ['auth'],
  });

/** Changing how a webhook checks deliveries (e.g. once Linear has shown its signing secret). */
export const webhookAuthSchema = z.discriminatedUnion('auth', [
  z.object({ auth: z.literal('url') }),
  z.object({ auth: z.literal('jwt'), signingSecret }),
  z.object({ auth: z.literal('bearer') }),
  z.object({ auth: z.literal('hmac'), signingSecret }),
]);

/** Where each sender puts the HMAC-SHA256 of the body, and how (hex, maybe prefixed). */
const SIGNATURE_HEADERS: Partial<Record<WebhookSource, { header: string; prefix: string }>> = {
  linear: { header: 'linear-signature', prefix: '' },
  github: { header: 'x-hub-signature-256', prefix: 'sha256=' },
};
/** Linear deliveries carry `webhookTimestamp` (ms): older ones are replays. */
const MAX_DELIVERY_AGE_MS = MS_PER_MINUTE;
const HEX_RE = /^[0-9a-f]+$/i;

export type PublicWebhook = Omit<Webhook, 'tokenHash' | 'auth'> & {
  auth: WebhookAuth['kind'];
  lastEventAt: string | null;
  accepted: number;
  rejected: number;
};

export interface WebhookEvent {
  id: number;
  at: string;
  accepted: boolean;
  reason: string | null;
  eventType: string | null;
  payload: unknown;
}

/** An accepted delivery, as given to delivery listeners (agent triggers). */
export interface AcceptedDelivery {
  webhook: PublicWebhook;
  eventId: number;
  eventType: string | null;
  /** The payload, redacted like the logged one (but not size-capped). */
  payload: unknown;
}

/** The answer to give the sender. */
export interface Delivery {
  status: number;
  body: Record<string, unknown>;
}

/** The webhook and its fresh address (and bearer secret), shown once. */
export interface CreatedWebhook {
  webhook: PublicWebhook;
  url: string;
  bearerSecret?: string;
}

interface EventRow {
  id: number;
  at: string;
  accepted: number;
  reason: string | null;
  event_type: string | null;
  payload: string | null;
}

class Rejected extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Verifies an HS256 JWT (signature, `exp`, `iat`); returns its claims or throws `Rejected`. */
export async function verifyJwt(
  token: string,
  secret: string,
  nowSeconds: number,
): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  const [header = '', payload = '', signature = ''] = parts;
  const sig = fromBase64Url(signature);
  if (parts.length !== JWT_PARTS || !sig)
    throw new Rejected(HTTP.UNAUTHORIZED, 'Malformed Authorization token');
  const decode = (part: string): unknown => {
    const bytes = fromBase64Url(part);
    try {
      return bytes ? (JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown) : null;
    } catch {
      return null;
    }
  };
  const head = decode(header);
  if (!isRecord(head) || head.alg !== 'HS256')
    throw new Rejected(HTTP.UNAUTHORIZED, 'Unsupported token algorithm');
  if (!(await verifyHmacSha256(secret, `${header}.${payload}`, sig))) {
    throw new Rejected(HTTP.UNAUTHORIZED, 'Invalid token signature');
  }
  const claims = decode(payload);
  if (!isRecord(claims)) throw new Rejected(HTTP.UNAUTHORIZED, 'Malformed token claims');
  if (typeof claims.exp === 'number' && claims.exp + JWT_LEEWAY_SECONDS < nowSeconds) {
    throw new Rejected(HTTP.UNAUTHORIZED, 'Expired token');
  }
  if (typeof claims.iat === 'number' && claims.iat - JWT_LEEWAY_SECONDS > nowSeconds) {
    throw new Rejected(HTTP.UNAUTHORIZED, 'Token issued in the future');
  }
  return claims;
}

/** monday.com sends the JWT bare in `Authorization`; others prefix it with `Bearer`. */
const authorizationValue = (header: string | undefined): string =>
  (header ?? '').trim().replace(/^bearer\s+/i, '');

/**
 * The event's type, for the log: monday's `event.type`, Linear's `type` + `action`, or a
 * generic `type` / `event` field.
 */
function eventTypeOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.type === 'string' && typeof payload.action === 'string') {
    return `${payload.type}.${payload.action}`;
  }
  const event = payload.event;
  if (isRecord(event) && typeof event.type === 'string') return event.type;
  if (typeof event === 'string') return event;
  return typeof payload.type === 'string' ? payload.type : null;
}

/** GitHub names the event in `X-GitHub-Event` and its action in the body: `issues.opened`. */
function githubEventType(event: string, payload: unknown): string {
  return isRecord(payload) && typeof payload.action === 'string'
    ? `${event}.${payload.action}`
    : event;
}

export class Webhooks {
  private readonly rate = new Map<string, { windowStart: number; count: number }>();
  private readonly deliveryListeners: ((delivery: AcceptedDelivery) => void)[] = [];

  constructor(
    private readonly store: EncryptedStore,
    private readonly crypto: CryptoBox,
    private readonly db: Database,
    private readonly activity: ActivityLog,
    private readonly publicUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Called after each accepted delivery (agent triggers launch from it). */
  onDelivery(listener: (delivery: AcceptedDelivery) => void): void {
    this.deliveryListeners.push(listener);
  }

  /** A webhook the actor may see, or null. */
  visible(id: string, actor: Actor): PublicWebhook | null {
    const w = this.store.read().webhooks.find((x) => x.id === id && this.visibleTo(x, actor));
    return w ? this.toPublic(w) : null;
  }

  // ---------------------------------------------------------------- management

  async create(input: unknown, actor: Actor): Promise<CreatedWebhook> {
    const data = webhookSchema.parse(input);
    const token = randomToken('', TOKEN_BYTES);
    const bearerSecret = data.auth === 'bearer' ? randomToken(SECRET_PREFIX) : undefined;
    const auth = this.authOf(data, bearerSecret);
    const webhook: Webhook = {
      id: randomId(),
      name: data.name,
      source: data.source,
      tokenHash: this.crypto.hashToken(token),
      auth,
      ownerMemberId: actor.kind === 'member' ? actor.member.id : null,
      createdAt: this.now().toISOString(),
    };
    await this.store.update((s) => {
      s.webhooks.push(webhook);
    });
    this.log(actor, `created webhook "${webhook.name}" (${auth.kind})`);
    return {
      webhook: this.toPublic(webhook),
      url: this.url(token),
      ...(bearerSecret ? { bearerSecret } : {}),
    };
  }

  /** Sets how deliveries are checked; a new bearer secret is returned once. */
  async setAuth(
    id: string,
    input: unknown,
    actor: Actor,
  ): Promise<{ webhook: PublicWebhook; bearerSecret?: string }> {
    const data = webhookAuthSchema.parse(input);
    const bearerSecret = data.auth === 'bearer' ? randomToken(SECRET_PREFIX) : undefined;
    const auth = this.authOf(data, bearerSecret);
    const updated = await this.store.update((s) => {
      const w = s.webhooks.find((x) => x.id === id && this.visibleTo(x, actor));
      if (!w) throw notFound(WEBHOOK_NOT_FOUND);
      if (auth.kind === 'hmac' && !(w.source in SIGNATURE_HEADERS)) {
        throw badRequest('Signed bodies are checked for Linear and GitHub webhooks');
      }
      w.auth = auth;
      return w;
    });
    this.log(actor, `set access control of webhook "${updated.name}" to ${auth.kind}`);
    return { webhook: this.toPublic(updated), ...(bearerSecret ? { bearerSecret } : {}) };
  }

  private authOf(
    data: z.infer<typeof webhookAuthSchema>,
    bearerSecret: string | undefined,
  ): WebhookAuth {
    switch (data.auth) {
      case 'jwt':
      case 'hmac':
        return { kind: data.auth, signingSecret: data.signingSecret };
      case 'bearer':
        return { kind: 'bearer', secretHash: this.crypto.hashToken(bearerSecret ?? '') };
      case 'url':
        return { kind: 'url' };
    }
  }

  list(actor: Actor): PublicWebhook[] {
    return this.store
      .read()
      .webhooks.filter((w) => this.visibleTo(w, actor))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((w) => this.toPublic(w));
  }

  /** A new address; the old one stops working at once. */
  async rotate(id: string, actor: Actor): Promise<CreatedWebhook> {
    const token = randomToken('', TOKEN_BYTES);
    const updated = await this.store.update((s) => {
      const w = s.webhooks.find((x) => x.id === id && this.visibleTo(x, actor));
      if (!w) throw notFound(WEBHOOK_NOT_FOUND);
      w.tokenHash = this.crypto.hashToken(token);
      return w;
    });
    this.log(actor, `rotated the address of webhook "${updated.name}"`);
    return { webhook: this.toPublic(updated), url: this.url(token) };
  }

  async delete(id: string, actor: Actor): Promise<void> {
    const removed = await this.store.update((s) => {
      const w = s.webhooks.find((x) => x.id === id && this.visibleTo(x, actor));
      if (!w) throw notFound(WEBHOOK_NOT_FOUND);
      s.webhooks = s.webhooks.filter((x) => x.id !== id);
      return w;
    });
    this.rate.delete(id);
    this.log(actor, `deleted webhook "${removed.name}"`);
  }

  events(id: string, actor: Actor, limit = DEFAULT_EVENTS): WebhookEvent[] {
    const w = this.store.read().webhooks.find((x) => x.id === id && this.visibleTo(x, actor));
    if (!w) throw notFound(WEBHOOK_NOT_FOUND);
    const rows = this.db.sql
      .prepare('SELECT * FROM webhook_events WHERE webhook_id = ? ORDER BY id DESC LIMIT ?')
      .all(id, Math.max(1, Math.min(MAX_EVENTS, limit))) as unknown as EventRow[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      accepted: r.accepted === 1,
      reason: r.reason,
      eventType: r.event_type,
      payload: r.payload === null ? null : (JSON.parse(r.payload) as unknown),
    }));
  }

  // ---------------------------------------------------------------- deliveries

  /**
   * Handles `POST /hooks/<token>`. Unknown addresses get 404 (and are not logged: nothing to
   * attach them to); a known address with a failing Authorization check gets 401 and is logged.
   */
  async receive(
    token: string,
    header: (name: string) => string | undefined,
    body: Buffer,
  ): Promise<Delivery> {
    const webhook = this.byToken(token);
    if (!webhook) return { status: HTTP.NOT_FOUND, body: { error: 'not_found' } };
    let payload: unknown;
    try {
      payload = body.length ? (JSON.parse(body.toString('utf8')) as unknown) : null;
    } catch {
      return this.reject(webhook, new Rejected(HTTP.BAD_REQUEST, 'Body is not JSON'));
    }
    // monday.com checks a new address by asking it to echo a challenge: harmless to answer.
    if (
      webhook.source === 'monday' &&
      isRecord(payload) &&
      typeof payload.challenge === 'string' &&
      Object.keys(payload).length === 1
    ) {
      return { status: HTTP.OK, body: { challenge: payload.challenge } };
    }
    try {
      if (webhook.auth.kind === 'hmac') {
        await this.checkSignature(webhook, webhook.auth.signingSecret, header, body, payload);
      } else {
        await this.checkAuthorization(webhook.auth, header('authorization'));
      }
      this.checkRate(webhook.id);
    } catch (err) {
      if (err instanceof Rejected) return this.reject(webhook, err);
      throw err;
    }
    const github = header('x-github-event');
    const eventType = github ? githubEventType(github, payload) : eventTypeOf(payload);
    const redacted = payload === null ? null : redactDeep(payload);
    const eventId = this.record(webhook.id, true, null, eventType, redacted);
    this.notify({ webhook: this.toPublic(webhook), eventId, eventType, payload: redacted });
    return { status: HTTP.OK, body: { ok: true } };
  }

  /** A failing listener never changes the sender's answer: the delivery is already logged. */
  private notify(delivery: AcceptedDelivery): void {
    for (const listener of this.deliveryListeners) {
      try {
        listener(delivery);
      } catch (err) {
        console.error('Webhooks: delivery listener failed', err);
      }
    }
  }

  /** The sender's HMAC-SHA256 of the raw body, and for Linear a fresh `webhookTimestamp`. */
  private async checkSignature(
    webhook: Webhook,
    secret: string,
    header: (name: string) => string | undefined,
    body: Buffer,
    payload: unknown,
  ): Promise<void> {
    const scheme = SIGNATURE_HEADERS[webhook.source];
    const value = scheme ? header(scheme.header)?.trim() : undefined;
    if (!scheme || !value?.startsWith(scheme.prefix)) {
      throw new Rejected(HTTP.UNAUTHORIZED, 'Missing body signature');
    }
    const hex = value.slice(scheme.prefix.length);
    if (!HEX_RE.test(hex) || !(await verifyHmacSha256(secret, body, Buffer.from(hex, 'hex')))) {
      throw new Rejected(HTTP.UNAUTHORIZED, 'Invalid body signature');
    }
    if (webhook.source !== 'linear') return;
    const sent = isRecord(payload) ? payload.webhookTimestamp : undefined;
    if (typeof sent !== 'number' || Math.abs(this.now().getTime() - sent) > MAX_DELIVERY_AGE_MS) {
      throw new Rejected(HTTP.UNAUTHORIZED, 'Stale or missing webhookTimestamp');
    }
  }

  private async checkAuthorization(auth: WebhookAuth, header: string | undefined): Promise<void> {
    const value = authorizationValue(header);
    switch (auth.kind) {
      case 'url':
        return;
      case 'jwt':
        if (!value) throw new Rejected(HTTP.UNAUTHORIZED, 'Missing Authorization token');
        await verifyJwt(
          value,
          auth.signingSecret,
          Math.floor(this.now().getTime() / MS_PER_SECOND),
        );
        return;
      case 'bearer':
        if (!value || !CryptoBox.equalHex(this.crypto.hashToken(value), auth.secretHash)) {
          throw new Rejected(HTTP.UNAUTHORIZED, 'Invalid or missing bearer secret');
        }
        return;
      case 'hmac':
        throw new Rejected(HTTP.UNAUTHORIZED, 'This webhook checks a body signature');
    }
  }

  private checkRate(id: string): void {
    const now = this.now().getTime();
    const entry = this.rate.get(id);
    if (!entry || now - entry.windowStart >= MS_PER_MINUTE) {
      this.rate.set(id, { windowStart: now, count: 1 });
      return;
    }
    entry.count += 1;
    if (entry.count > RATE_PER_MINUTE)
      throw new Rejected(HTTP.TOO_MANY_REQUESTS, 'Too many deliveries');
  }

  private reject(webhook: Webhook, err: Rejected): Delivery {
    this.record(webhook.id, false, err.message, null, null);
    return { status: err.status, body: { error: 'rejected', message: err.message } };
  }

  private record(
    id: string,
    accepted: boolean,
    reason: string | null,
    eventType: string | null,
    payload: unknown,
  ): number {
    const json = payload === null ? null : JSON.stringify(redactDeep(payload));
    const result = this.db.sql
      .prepare(
        'INSERT INTO webhook_events (webhook_id, at, accepted, reason, event_type, payload) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        this.now().toISOString(),
        accepted ? 1 : 0,
        reason === null ? null : reason.slice(0, MAX_REASON_CHARS),
        eventType,
        json !== null && json.length > MAX_PAYLOAD_CHARS
          ? JSON.stringify({ truncated: true })
          : json,
      );
    return Number(result.lastInsertRowid);
  }

  private byToken(token: string): Webhook | undefined {
    if (!token) return undefined;
    const hash = this.crypto.hashToken(token);
    return this.store.read().webhooks.find((w) => CryptoBox.equalHex(w.tokenHash, hash));
  }

  // ---------------------------------------------------------------- helpers

  private url(token: string): string {
    return `${this.publicUrl}/hooks/${token}`;
  }

  private visibleTo(w: Webhook, actor: Actor): boolean {
    return actor.kind === 'admin' || w.ownerMemberId === actor.member.id;
  }

  private toPublic(w: Webhook): PublicWebhook {
    const { tokenHash: _t, auth, ...rest } = w;
    const stats = this.db.sql
      .prepare(
        `SELECT MAX(at) AS last, COALESCE(SUM(accepted), 0) AS accepted, COUNT(*) - COALESCE(SUM(accepted), 0) AS rejected
         FROM webhook_events WHERE webhook_id = ?`,
      )
      .get(w.id) as { last: string | null; accepted: number; rejected: number };
    return {
      ...rest,
      auth: auth.kind,
      lastEventAt: stats.last,
      accepted: stats.accepted,
      rejected: stats.rejected,
    };
  }

  private log(actor: Actor, what: string): void {
    const who = actor.kind === 'member' ? `Member "${actor.member.name}"` : 'Admin';
    this.activity.add({ kind: actor.kind, detail: `${who} ${what}` });
  }
}
