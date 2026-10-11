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
 * ByteDance Seedance video generation on BytePlus ModelArk
 * (`https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks…`), as a tool agents
 * call. Tasks are created, polled, listed and cancelled; the finished video sits on BytePlus
 * storage agents can't reach, so the gateway downloads it for them. Only Seedance models are
 * served, and nothing the provider would fetch or call on the agent's behalf (callback URLs, media
 * URLs) gets through without a permission, so it can't be used to get around a network lockdown.
 */

const API = 'https://ark.ap-southeast.bytepluses.com';
const PREFIX = ['api', 'v3', 'contents', 'generations', 'tasks'] as const;
const BASE_PATH = `/${PREFIX.join('/')}`;
/** Media the provider takes inline (base64) or from the account's asset library. */
const INLINE_SCHEMES = ['data:', 'asset://'];
/** Hosts BytePlus serves generated files from; downloads elsewhere are refused. */
const STORAGE_HOSTS = ['.bytepluses.com', '.byteplus.com', '.volces.com'];
const LIST_QUERY = ['page_num', 'page_size', 'filter.status', 'filter.task_ids', 'filter.model'];

const PERM = {
  GENERATE: 'videos:generate',
  READ: 'videos:read',
  CANCEL: 'videos:cancel',
  REMOTE_MEDIA: 'media:remote-urls',
} as const;

const PERMISSIONS = [
  {
    id: PERM.GENERATE,
    label: 'Generate videos',
    description: `Create Seedance tasks (POST ${BASE_PATH}). Limited to the model allowlist; callback URLs are refused.`,
  },
  {
    id: PERM.READ,
    label: 'Tasks (read, download)',
    description: `Poll and list tasks (GET ${BASE_PATH}[/<id>]) and download a finished task's video (GET ${BASE_PATH}/<id>/video) or last frame (…/<id>/last-frame) through the gateway.`,
  },
  {
    id: PERM.CANCEL,
    label: 'Tasks (cancel, delete)',
    description: `Cancel a queued task or delete a task record (DELETE ${BASE_PATH}/<id>).`,
  },
  {
    id: PERM.REMOTE_MEDIA,
    label: 'Media by URL',
    description:
      'Let tasks reference images, videos or audio by http(s) URL. BytePlus fetches them from the internet: without this permission only inline (data:) and asset:// media are accepted, so an agent can’t use them to get around its network lockdown.',
  },
] as const;

/** Downloadable files of a finished task: path suffix → field of the task's `content`. */
const FILES: Record<string, string> = { video: 'video_url', 'last-frame': 'last_frame_url' };

/** Refuses any query parameter not in `allowed`. */
function checkQuery(search: string, allowed: readonly string[]): void {
  for (const name of new URLSearchParams(search).keys()) {
    if (!allowed.includes(name)) throw new Denied(`Unsupported query parameter "${name}"`);
  }
}

function notCovered(request: ToolRequest): Denied {
  return new Denied(
    `${request.method.toUpperCase()} /${request.segments.join('/')} is not covered by any gateway permission`,
  );
}

/** Media URLs in the task's content: only inline ones unless the grant allows remote media. */
function checkContent(grant: Grant, content: unknown): void {
  if (!Array.isArray(content)) throw new Denied('"content" must be an array');
  for (const item of content) {
    if (!isRecord(item)) throw new Denied('Each "content" item must be an object');
    for (const value of Object.values(item)) {
      const url = isRecord(value) ? value.url : undefined;
      if (url === undefined) continue;
      if (typeof url !== 'string') throw new Denied('Media URLs must be strings');
      if (INLINE_SCHEMES.some((scheme) => url.startsWith(scheme))) continue;
      if (!/^https?:\/\//i.test(url))
        throw new Denied('Media URLs must be data:, asset:// or http(s)');
      requirePermission(grant, PERM.REMOTE_MEDIA);
    }
  }
}

/** `POST /api/v3/contents/generations/tasks`. */
function create(request: ToolRequest, grant: Grant): AuthzAllowed {
  checkQuery(request.search, []);
  requirePermission(grant, PERM.GENERATE);
  const body = jsonBody(request);
  const model = checkModel(grant, body.model);
  if (!model.toLowerCase().includes('seedance')) {
    throw new Denied(`Model "${model}" is not a Seedance model`);
  }
  if ('callback_url' in body) {
    throw new Denied('Callback URLs are not allowed: poll the task instead');
  }
  checkContent(grant, body.content);
  return { allowed: true, permission: PERM.GENERATE, detail: model, body: canonical(body) };
}

/** A BytePlus storage address a generated file may be downloaded from; anything else is refused. */
function storageUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const byteplus = STORAGE_HOSTS.some((suffix) => url.hostname.endsWith(suffix));
  return url.protocol === 'https:' && byteplus ? url : null;
}

const notAvailable = (message: string): Response =>
  Response.json({ error: { code: 'FileNotAvailable', message } }, { status: HTTP.NOT_FOUND });

/** Reads the task the gateway fetched and downloads one of its files from BytePlus storage. */
function downloadFile(fetchImpl: typeof fetch, field: string) {
  return async (upstream: Response): Promise<Response> => {
    if (!upstream.ok) return upstream;
    const task: unknown = await upstream.json();
    const content = isRecord(task) ? task.content : undefined;
    const value = isRecord(content) ? content[field] : undefined;
    if (value === undefined) {
      const status = isRecord(task) && typeof task.status === 'string' ? task.status : 'unknown';
      return notAvailable(`The task has no ${field} (status: ${status})`);
    }
    const url = storageUrl(value);
    if (!url) return notAvailable(`The task's ${field} is not on BytePlus storage`);
    // Storage URLs are signed: the API key never leaves for them.
    return fetchImpl(url.href, { redirect: 'manual' });
  };
}

/** `GET|DELETE /api/v3/contents/generations/tasks[/<id>[/video|/last-frame]]`. */
function task(
  request: ToolRequest,
  grant: Grant,
  rest: readonly string[],
  fetchImpl: typeof fetch,
): AuthzAllowed {
  const verb = request.method.toUpperCase();
  const [id, file, ...extra] = rest;
  if (extra.length > 0 || (verb === 'DELETE' && (id === undefined || file !== undefined))) {
    throw notCovered(request);
  }
  if (verb === 'DELETE') {
    checkQuery(request.search, []);
    requirePermission(grant, PERM.CANCEL);
    return { allowed: true, permission: PERM.CANCEL, detail: `task ${String(id)}` };
  }
  checkQuery(request.search, id === undefined ? LIST_QUERY : []);
  requirePermission(grant, PERM.READ);
  if (id === undefined) return { allowed: true, permission: PERM.READ };
  if (file === undefined) return { allowed: true, permission: PERM.READ, detail: `task ${id}` };
  const field = Object.hasOwn(FILES, file) ? FILES[file] : undefined;
  if (!field) throw notCovered(request);
  return {
    allowed: true,
    permission: PERM.READ,
    detail: `download ${file} of task ${id}`,
    upstreamUrl: `${API}${BASE_PATH}/${encodeURIComponent(id)}`,
    method: 'GET',
    upstreamHeaders: (secret) => bearer(secret),
    transformResponse: downloadFile(fetchImpl, field),
  };
}

function bearer(secret: string): Headers {
  return new Headers({ 'user-agent': 'local-gateway', authorization: `Bearer ${secret}` });
}

function authorizeRequest(
  request: ToolRequest,
  grant: Grant,
  fetchImpl: typeof fetch,
): AuthzDecision {
  const verb = request.method.toUpperCase();
  const prefix = request.segments.slice(0, PREFIX.length);
  if (prefix.length < PREFIX.length || prefix.some((s, i) => s !== PREFIX[i])) {
    throw new Denied(`Only ${BASE_PATH}… calls are supported`);
  }
  const rest = request.segments.slice(PREFIX.length);
  if (verb === 'POST' && rest.length === 0) return create(request, grant);
  if (verb === 'GET' || verb === 'DELETE') return task(request, grant, rest, fetchImpl);
  throw notCovered(request);
}

export function createSeedanceProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  return {
    id: 'seedance',
    name: 'Seedance video generation',
    credentialHelp:
      'A BytePlus ModelArk API key (console.byteplus.com → ModelArk → API keys), with the Seedance models activated. Agents generate videos through the gateway with their session key and never see this key.',
    credentialPlaceholder: 'ModelArk API key',
    resourceHelp:
      'One model per line; `*` matches any characters (e.g. seedance-2-5-*, seedance-1-0-pro-*). Leave empty to allow every Seedance model.',
    permissions: PERMISSIONS,
    upstreamBaseUrl: API,
    example: {
      method: 'POST',
      path: BASE_PATH,
      body: '{"model":"seedance-1-0-pro-250528","content":[{"type":"text","text":"A lighthouse at dawn --duration 5"}]}',
      clientHint: 'ModelArk base URL (…/api/v3), session key as the bearer API key',
    },

    validateResource: validateModelPattern,

    async verifyCredential(secret) {
      const res = await fetchImpl(`${API}${BASE_PATH}?page_num=1&page_size=1`, {
        headers: bearer(secret),
      });
      if (!res.ok) throw new Error(`BytePlus rejected the API key (HTTP ${res.status})`);
      return { keyType: 'ModelArk API key' };
    },

    authorize: (request, grant) => decide(() => authorizeRequest(request, grant, fetchImpl)),

    upstreamHeaders(secret, incoming) {
      const headers = forwardHeaders(incoming, ['content-type', 'accept']);
      headers.set('authorization', `Bearer ${secret}`);
      return headers;
    },
  };
}
