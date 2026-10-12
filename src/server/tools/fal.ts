import { HTTP } from '../httpStatus.js';
import { isRecord } from './json.js';
import type { AuthzAllowed, AuthzDecision, Grant, ToolProvider, ToolRequest } from './types.js';
import {
  canonical,
  checkModel,
  decide,
  Denied,
  forwardHeaders,
  jsonBody,
  requirePermission,
  validateModelPattern,
} from './llm/common.js';

/**
 * fal.ai model APIs through the queue (`https://queue.fal.run/<endpoint id>…`), as a tool agents
 * call: requests to image, video and audio models are submitted, polled, read and cancelled.
 * Results point at fal's CDN, which agents can't reach, so the gateway downloads files from it for
 * them. Nothing fal would fetch or call on the agent's behalf (webhooks, media URLs off fal's own
 * storage) gets through without a permission, so it can't be used to get around a network lockdown.
 */

const API = 'https://queue.fal.run';
/** fal's platform API, which lists past requests to an endpoint. */
const REQUESTS_BY_ENDPOINT = 'https://api.fal.ai/v1/models/requests/by-endpoint';
/** Query parameters of the request listing (filters, pagination, `expand=payloads`). */
const LIST_PARAMS = [
  'limit',
  'cursor',
  'start',
  'end',
  'status',
  'request_id',
  'expand',
  'sort_by',
];
const REQUESTS = 'requests';
/** Endpoint ids under these namespaces have three segments (`workflows/<owner>/<app>`). */
const NAMESPACES = ['workflows', 'comfy'];
const APP_SEGMENTS = 2;
const NAMESPACED_APP_SEGMENTS = 3;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
/** Gateway path (`GET /files?url=…`) that downloads a file from fal's storage. */
const FILES = 'files';
/** Where fal serves generated and uploaded files; downloads elsewhere are refused. */
const STORAGE_HOSTS = ['fal.media'];
const LEGACY_STORAGE = { host: 'storage.googleapis.com', path: '/falserverless/' };
/** Request headers fal's clients send to tune a submission (no credentials, no callbacks). */
const FAL_HEADERS = [
  'x-fal-queue-priority',
  'x-fal-runner-hint',
  'x-fal-request-timeout',
  'x-fal-request-timeout-type',
  'x-fal-object-lifecycle-preference',
];
/** A probe request id: the queue answers 401/403 for a bad key, 404 for a good one. */
const PROBE_PATH = '/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status';
const AUTH_ERRORS = new Set<number>([HTTP.UNAUTHORIZED, HTTP.FORBIDDEN]);

const PERM = {
  SUBMIT: 'requests:submit',
  READ: 'requests:read',
  CANCEL: 'requests:cancel',
  REMOTE_MEDIA: 'media:remote-urls',
} as const;

const PERMISSIONS = [
  {
    id: PERM.SUBMIT,
    label: 'Submit requests',
    description:
      'Queue a request to a model (POST /<endpoint id>, e.g. /fal-ai/flux/dev). Limited to the endpoint allowlist; webhooks are refused.',
  },
  {
    id: PERM.READ,
    label: 'Requests (read, download)',
    description: `List past requests to an endpoint (GET /<endpoint id>/requests), poll a request and read its result (GET /<owner>/<app>/requests/<id>[/status[/stream]]), and download a generated file from fal's storage through the gateway (GET /${FILES}?url=<file URL>).`,
  },
  {
    id: PERM.CANCEL,
    label: 'Requests (cancel)',
    description: 'Cancel a queued request (PUT /<owner>/<app>/requests/<id>/cancel).',
  },
  {
    id: PERM.REMOTE_MEDIA,
    label: 'Media by URL',
    description:
      'Let requests reference images, videos or audio by URL. fal fetches them from the internet: without this permission only inline (data:) media and files on fal’s own storage are accepted, so an agent can’t use them to get around its network lockdown.',
  },
] as const;

function notCovered(request: ToolRequest): Denied {
  return new Denied(
    `${request.method.toUpperCase()} /${request.segments.join('/')} is not covered by any gateway permission`,
  );
}

/** Refuses any query parameter not in `allowed`. */
function checkQuery(search: string, allowed: readonly string[]): URLSearchParams {
  const params = new URLSearchParams(search);
  for (const name of params.keys()) {
    if (name === 'fal_webhook') throw new Denied('Webhooks are not allowed: poll the request');
    if (!allowed.includes(name)) throw new Denied(`Unsupported query parameter "${name}"`);
  }
  return params;
}

/** A file on fal's storage, or null for any other address. */
function storageUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const fal = STORAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  const legacy = host === LEGACY_STORAGE.host && url.pathname.startsWith(LEGACY_STORAGE.path);
  return fal || legacy ? url : null;
}

/**
 * Media URLs anywhere in the input: fal fetches them, so anything but inline data and fal's own
 * storage needs the remote media permission.
 */
function checkMedia(grant: Grant, value: unknown): void {
  if (typeof value === 'string') {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) && !storageUrl(value.trim())) {
      requirePermission(grant, PERM.REMOTE_MEDIA);
    }
    return;
  }
  const items = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  for (const item of items) checkMedia(grant, item);
}

/** Length of the app id (`<owner>/<app>`, or namespaced) at the start of the path. */
function appLength(segments: readonly string[]): number {
  const length = NAMESPACES.includes(segments[0] ?? '') ? NAMESPACED_APP_SEGMENTS : APP_SEGMENTS;
  if (segments.length < length || !segments.every((s) => SEGMENT.test(s))) {
    throw new Denied('Use /<owner>/<app>[/<path>] (e.g. /fal-ai/flux/dev)');
  }
  return length;
}

/** `POST /<endpoint id>`: queues a request. */
function submit(request: ToolRequest, grant: Grant): AuthzAllowed {
  checkQuery(request.search, []);
  requirePermission(grant, PERM.SUBMIT);
  const endpoint = checkModel(grant, request.segments.join('/'));
  const body = jsonBody(request);
  checkMedia(grant, body);
  return { allowed: true, permission: PERM.SUBMIT, detail: endpoint, body: canonical(body) };
}

/** `GET|PUT /<app id>/requests/<id>[/status[/stream]|/cancel]`. */
function queued(request: ToolRequest, grant: Grant, rest: readonly string[]): AuthzAllowed {
  const verb = request.method.toUpperCase();
  const [id, action, stream, ...extra] = rest;
  if (id === undefined || extra.length > 0) throw notCovered(request);
  if (verb === 'PUT' && action === 'cancel' && stream === undefined) {
    checkQuery(request.search, []);
    requirePermission(grant, PERM.CANCEL);
    return { allowed: true, permission: PERM.CANCEL, detail: `cancel request ${id}` };
  }
  if (verb !== 'GET') throw notCovered(request);
  if (action === undefined) {
    checkQuery(request.search, []);
  } else if (action === 'status' && (stream === undefined || stream === 'stream')) {
    checkQuery(request.search, ['logs']);
  } else {
    throw notCovered(request);
  }
  requirePermission(grant, PERM.READ);
  return { allowed: true, permission: PERM.READ, detail: `request ${id}` };
}

/**
 * `GET /<endpoint id>/requests`: lists past requests to an endpoint (with their inputs and outputs
 * given `expand=payloads`), from fal's platform API.
 */
function list(request: ToolRequest, grant: Grant, segments: readonly string[]): AuthzAllowed {
  if (request.method.toUpperCase() !== 'GET') throw notCovered(request);
  const params = checkQuery(request.search, LIST_PARAMS);
  requirePermission(grant, PERM.READ);
  const endpoint = checkModel(grant, segments.join('/'));
  params.set('endpoint_id', endpoint);
  return {
    allowed: true,
    permission: PERM.READ,
    detail: `list requests to ${endpoint}`,
    upstreamUrl: `${REQUESTS_BY_ENDPOINT}?${params.toString()}`,
  };
}

/** `GET /files?url=<file URL>`: downloads a file from fal's storage, which agents can't reach. */
function download(request: ToolRequest, grant: Grant): AuthzAllowed {
  const url = checkQuery(request.search, ['url']).get('url');
  requirePermission(grant, PERM.READ);
  const file = url === null ? null : storageUrl(url);
  if (!file)
    throw new Denied('Only files on fal’s storage (https://…fal.media/…) can be downloaded');
  return {
    allowed: true,
    permission: PERM.READ,
    detail: `download ${file.pathname}`,
    upstreamUrl: file.href,
    method: 'GET',
    // Files are public on fal's CDN: the API key never leaves for them.
    upstreamHeaders: () => new Headers({ 'user-agent': 'local-gateway' }),
  };
}

function authorizeRequest(request: ToolRequest, grant: Grant): AuthzDecision {
  const verb = request.method.toUpperCase();
  const { segments } = request;
  if (verb === 'GET' && segments.length === 1 && segments[0] === FILES) {
    return download(request, grant);
  }
  const length = appLength(segments);
  const rest = segments.slice(length + 1);
  if (segments[length] === REQUESTS && rest.length > 0) return queued(request, grant, rest);
  if (segments.at(-1) === REQUESTS) return list(request, grant, segments.slice(0, -1));
  if (verb === 'POST') return submit(request, grant);
  throw notCovered(request);
}

function keyHeader(secret: string): Headers {
  return new Headers({ 'user-agent': 'local-gateway', authorization: `Key ${secret}` });
}

export function createFalProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  return {
    id: 'fal',
    name: 'fal.ai',
    credentialHelp:
      'A fal.ai API key (fal.ai/dashboard/keys, scope API). Agents call fal models through the gateway with their session key and never see this key.',
    credentialPlaceholder: 'fal API key (key_id:key_secret)',
    resourceHelp:
      'One endpoint id per line; `*` matches any characters (e.g. fal-ai/flux/*, fal-ai/kling-video/*). Leave empty to allow every endpoint.',
    permissions: PERMISSIONS,
    upstreamBaseUrl: API,
    example: {
      method: 'POST',
      path: '/fal-ai/flux/dev',
      body: '{"prompt":"A lighthouse at dawn, watercolor"}',
      clientHint:
        'Queue base URL instead of https://queue.fal.run, session key as `Key …` or bearer',
    },

    validateResource: validateModelPattern,

    async verifyCredential(secret) {
      const res = await fetchImpl(`${API}${PROBE_PATH}`, { headers: keyHeader(secret) });
      await res.body?.cancel();
      if (AUTH_ERRORS.has(res.status)) {
        throw new Error(`fal.ai rejected the API key (HTTP ${res.status})`);
      }
      return { keyType: 'fal.ai API key' };
    },

    authorize: (request, grant) => decide(() => authorizeRequest(request, grant)),

    upstreamHeaders(secret, incoming) {
      const headers = forwardHeaders(incoming, ['content-type', 'accept', ...FAL_HEADERS]);
      headers.set('authorization', `Key ${secret}`);
      return headers;
    },
  };
}
