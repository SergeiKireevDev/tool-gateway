import { lookup as dnsLookup } from 'node:dns/promises';
import type { IncomingMessage, Server } from 'node:http';
import { isIP, connect as netConnect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { domainAllowed, isMediated, isPublicAddress, parseHost } from '../egress/domains.js';
import { HttpError } from '../errors.js';
import { SESSION_KEY_PREFIX, type Gateway } from '../gateway.js';
import { HTTP } from '../httpStatus.js';
import type { Session } from '../store/types.js';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../units.js';
import { basicAuthKey } from './auth.js';

/**
 * The egress proxy: agents in microVMs reach the HTTPS domains their template allows with
 * `CONNECT host:443`, authenticated by their session key (`Proxy-Authorization`, as the
 * password of `HTTPS_PROXY=http://agent:gws_…@gateway`). The gateway resolves the name itself,
 * refuses private and local addresses, and relays the encrypted bytes without reading them:
 * it knows the domain, never the requests.
 */

export const EGRESS_TOOL = 'internet';
const HTTPS_PORT = 443;
/** Addresses tried in turn, each for this long. */
const CONNECT_ATTEMPTS = 3;
const CONNECT_TIMEOUT_SECONDS = 5;
const IPV4 = 4;
const IDLE_TIMEOUT_MINUTES = 5;
/** Tunnels one session key may hold open at once. */
const MAX_TUNNELS_PER_SESSION = 64;
const MAX_LOGGED_AUTHORITY = 300;
const AUTHORITY_RE = /^([^:[\]\s]+):(\d{1,5})$/;
const STATUS_TEXT: Record<number, string> = {
  [HTTP.OK]: 'Connection Established',
  [HTTP.FORBIDDEN]: 'Forbidden',
  [HTTP.BAD_REQUEST]: 'Bad Request',
  [HTTP.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HTTP.BAD_GATEWAY]: 'Bad Gateway',
  [HTTP.PROXY_AUTHENTICATION_REQUIRED]: 'Proxy Authentication Required',
};

export interface EgressDeps {
  /** Every address a host name resolves to. */
  lookup?: (host: string) => Promise<{ address: string }[]>;
  /** Opens the upstream TCP connection (to an already checked address). */
  connect?: (address: string, port: number) => Socket;
  now?: () => number;
}

/** Serves `CONNECT` on the VM listener (plain HTTP keeps going to the app). */
export function attachEgressProxy(server: Server, gateway: Gateway, deps: EgressDeps = {}): void {
  const open = new Map<string, number>();
  const ctx: TunnelContext = {
    gateway,
    open,
    lookup: deps.lookup ?? ((host) => dnsLookup(host, { all: true, verbatim: true })),
    connect: deps.connect ?? ((address, port) => netConnect({ host: address, port })),
    now: deps.now ?? Date.now,
  };
  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => client.destroy());
    void tunnel(ctx, req, client, head);
  });
}

interface TunnelContext {
  gateway: Gateway;
  /** Open tunnels per session id. */
  open: Map<string, number>;
  lookup: (host: string) => Promise<{ address: string }[]>;
  connect: (address: string, port: number) => Socket;
  now: () => number;
}

function reply(client: Duplex, status: number, message = '', headers: string[] = []): void {
  const head = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ''}`, ...headers];
  if (status !== HTTP.OK) {
    head.push('x-gateway-denied: true', 'Content-Type: text/plain', 'Connection: close');
    head.push(`Content-Length: ${Buffer.byteLength(message)}`);
  }
  const text = `${head.join('\r\n')}\r\n\r\n${status === HTTP.OK ? '' : message}`;
  if (status === HTTP.OK) client.write(text);
  else client.end(text);
}

/** The session key from `Proxy-Authorization` (Basic, or Bearer). */
function proxyKey(req: IncomingMessage): string | null {
  const header = req.headers['proxy-authorization']?.trim() ?? '';
  const bearer = /^bearer\s+(\S+)$/i.exec(header)?.[1];
  if (bearer?.startsWith(SESSION_KEY_PREFIX)) return bearer;
  const basic = /^basic\s+(\S+)$/i.exec(header)?.[1];
  return basic ? basicAuthKey(basic) : null;
}

function authenticate(ctx: TunnelContext, req: IncomingMessage, client: Duplex): Session | null {
  const key = proxyKey(req);
  try {
    if (key) return ctx.gateway.resolveSession(key);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    reply(client, HTTP.PROXY_AUTHENTICATION_REQUIRED, err.message);
    return null;
  }
  reply(
    client,
    HTTP.PROXY_AUTHENTICATION_REQUIRED,
    'Session key required (HTTPS_PROXY=http://agent:gws_…@gateway)',
    ['Proxy-Authenticate: Basic realm="gateway"'],
  );
  return null;
}

/** Checks the target and resolves it to public addresses (IPv4 first); an error otherwise. */
async function checkTarget(
  ctx: TunnelContext,
  session: Session,
  authority: string,
): Promise<{ host: string; addresses: string[] } | { status: number; message: string }> {
  const match = AUTHORITY_RE.exec(authority);
  const host = match?.[1] ? parseHost(match[1]) : null;
  if (!host) return { status: HTTP.BAD_REQUEST, message: 'Expected CONNECT <domain>:443' };
  if (Number(match?.[2]) !== HTTPS_PORT) {
    return { status: HTTP.FORBIDDEN, message: 'Only HTTPS (port 443) is allowed' };
  }
  if (isMediated(host)) {
    return {
      status: HTTP.FORBIDDEN,
      message: `${host} is brokered by the gateway: use its tool (or git through the gateway)`,
    };
  }
  if (!domainAllowed(host, session.egressDomains ?? [])) {
    return { status: HTTP.FORBIDDEN, message: `${host} is not in this run's allowed domains` };
  }
  let resolved: { address: string }[];
  try {
    resolved = await ctx.lookup(host);
  } catch {
    return { status: HTTP.BAD_GATEWAY, message: `Could not resolve ${host}` };
  }
  const addresses = resolved.map((a) => a.address);
  // All of them, not just the one used: a name mixing public and private addresses is suspect.
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    return { status: HTTP.FORBIDDEN, message: `${host} resolves to a non-public address` };
  }
  // IPv4 first: many hosts have no IPv6 route.
  const ordered = [
    ...addresses.filter((a) => isIP(a) === IPV4),
    ...addresses.filter((a) => isIP(a) !== IPV4),
  ];
  return { host, addresses: ordered.slice(0, CONNECT_ATTEMPTS) };
}

/** Connects to the first of the (checked) addresses that answers; null when none does. */
async function openUpstream(
  ctx: TunnelContext,
  addresses: readonly string[],
): Promise<Socket | null> {
  for (const address of addresses) {
    const socket = ctx.connect(address, HTTPS_PORT);
    socket.setTimeout(CONNECT_TIMEOUT_SECONDS * MS_PER_SECOND);
    const connected = await new Promise<boolean>((resolve) => {
      socket.once('connect', () => {
        resolve(true);
      });
      socket.once('timeout', () => {
        resolve(false);
      });
      socket.once('error', () => {
        resolve(false);
      });
    });
    socket.removeAllListeners('timeout');
    socket.removeAllListeners('error');
    if (connected) return socket;
    socket.destroy();
  }
  return null;
}

async function tunnel(
  ctx: TunnelContext,
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
): Promise<void> {
  const session = authenticate(ctx, req, client);
  if (!session) return;
  const authority = req.url ?? '';
  const log = (decision: 'allowed' | 'denied', status: number, detail: string): void => {
    ctx.gateway.activity.add({
      kind: 'proxy',
      sessionId: session.id,
      sessionLabel: session.label,
      tool: EGRESS_TOOL,
      method: 'CONNECT',
      path: authority.slice(0, MAX_LOGGED_AUTHORITY),
      status,
      decision,
      detail,
    });
  };
  const deny = (status: number, message: string): void => {
    log('denied', status, message);
    reply(client, status, message);
  };

  const target = await checkTarget(ctx, session, authority);
  if ('status' in target) {
    deny(target.status, target.message);
    return;
  }
  const count = ctx.open.get(session.id) ?? 0;
  if (count >= MAX_TUNNELS_PER_SESSION) {
    deny(HTTP.TOO_MANY_REQUESTS, `At most ${MAX_TUNNELS_PER_SESSION} connections at once`);
    return;
  }
  ctx.open.set(session.id, count + 1);
  const release = (): void => {
    const left = (ctx.open.get(session.id) ?? 1) - 1;
    if (left > 0) ctx.open.set(session.id, left);
    else ctx.open.delete(session.id);
  };
  ctx.gateway.recordUsage(session.id);
  const upstream = await openUpstream(ctx, target.addresses);
  if (!upstream || client.destroyed) {
    release();
    if (upstream) upstream.destroy();
    else deny(HTTP.BAD_GATEWAY, `Could not connect to ${target.host}`);
    return;
  }
  relay(ctx, session, { client, upstream, head, host: target.host }, (detail) => {
    release();
    log('allowed', HTTP.OK, detail);
  });
}

/** Pipes an open tunnel both ways until either side closes, it idles, or the key expires. */
function relay(
  ctx: TunnelContext,
  session: Session,
  ends: { client: Duplex; upstream: Socket; head: Buffer; host: string },
  onClose: (detail: string) => void,
): void {
  const { client, upstream, head, host } = ends;
  const started = ctx.now();
  let sent = head.length;
  let received = 0;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(expiry);
    upstream.destroy();
    client.destroy();
    const seconds = Math.round((ctx.now() - started) / MS_PER_SECOND);
    onClose(`${host}: ${sent} B sent, ${received} B received, ${seconds}s`);
  };
  // A tunnel never outlives its key.
  const expiry = setTimeout(close, Math.max(0, Date.parse(session.expiresAt) - ctx.now()));
  expiry.unref();

  upstream.setTimeout(IDLE_TIMEOUT_MINUTES * MS_PER_MINUTE);
  upstream.on('timeout', close);
  upstream.on('error', close);
  upstream.on('close', close);
  client.on('close', close);
  reply(client, HTTP.OK);
  if (head.length) upstream.write(head);
  client.on('data', (chunk: Buffer) => {
    sent += chunk.length;
  });
  upstream.on('data', (chunk: Buffer) => {
    received += chunk.length;
  });
  client.pipe(upstream);
  upstream.pipe(client);
}
