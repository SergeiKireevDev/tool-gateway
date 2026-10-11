import { isRedirect } from '../httpStatus.js';
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
 * Gemini API image and video generation (`https://generativelanguage.googleapis.com/v1beta/…`),
 * as a tool agents call rather than the model they run on: Gemini image models
 * (`<model>:generateContent`), Imagen (`<model>:predict`) and Veo (`<model>:predictLongRunning`,
 * then polling the operation and downloading the video file). Each method only serves its own
 * model family, so the key can't be used as an unmetered text model. The client sends its session
 * key as `x-goog-api-key` (never `?key=`).
 */

const API = 'https://generativelanguage.googleapis.com';
const API_HOST = new URL(API).host;
const VERSION = 'v1beta';
const MODELS = 'models';
const FILES = 'files';
const OPERATIONS = 'operations';
const API_KEY_HEADER = 'x-goog-api-key';
/** Hops followed when a file download redirects to Google's storage. */
const MAX_REDIRECTS = 3;
const REDIRECT_HOSTS = ['.googleapis.com', '.googleusercontent.com'];

const PERM = {
  IMAGES: 'images:generate',
  VIDEOS: 'videos:generate',
  MODELS_READ: 'models:read',
} as const;

const PERMISSIONS = [
  {
    id: PERM.IMAGES,
    label: 'Generate images',
    description:
      'Gemini image models (POST /v1beta/models/<model>:generateContent, models named *image*) and Imagen (POST /v1beta/models/imagen-…:predict). Limited to the model allowlist; server-side tools (e.g. Google Search) are refused.',
  },
  {
    id: PERM.VIDEOS,
    label: 'Generate videos',
    description:
      'Veo (POST /v1beta/models/veo-…:predictLongRunning), polling the operation (GET /v1beta/models/<model>/operations/<id>) and downloading the video (GET /v1beta/files/<id>:download?alt=media: replace https://generativelanguage.googleapis.com in the returned URI with the gateway URL).',
  },
  {
    id: PERM.MODELS_READ,
    label: 'Models (list)',
    description: 'List the models the API key can use.',
  },
] as const;

/** Generation methods, the model family each serves and the permission it needs. */
const METHODS: Record<string, { permission: string; serves: (model: string) => boolean }> = {
  generateContent: { permission: PERM.IMAGES, serves: (model) => model.includes('image') },
  predict: { permission: PERM.IMAGES, serves: (model) => model.startsWith('imagen') },
  predictLongRunning: { permission: PERM.VIDEOS, serves: (model) => model.startsWith('veo') },
};

/** Refuses `?key=` and any query parameter not in `allowed` (name → required value, or any). */
function checkQuery(search: string, allowed: Record<string, string | null>): void {
  for (const [name, value] of new URLSearchParams(search)) {
    if (name === 'key') throw new Denied('Send the session key in x-goog-api-key, not ?key=');
    const expected = allowed[name];
    if (expected === undefined || (expected !== null && value !== expected)) {
      throw new Denied(`Unsupported query parameter "${name}"`);
    }
  }
}

function notCovered(request: ToolRequest): Denied {
  return new Denied(
    `${request.method.toUpperCase()} /${request.segments.join('/')} is not covered by any gateway permission`,
  );
}

/** `POST /v1beta/models/<model>:<method>`. */
function generate(request: ToolRequest, grant: Grant, target: string): AuthzAllowed {
  checkQuery(request.search, {});
  const colon = target.lastIndexOf(':');
  const method = colon > 0 ? METHODS[target.slice(colon + 1)] : undefined;
  if (!method) throw notCovered(request);
  requirePermission(grant, method.permission);
  const model = checkModel(grant, target.slice(0, colon));
  if (!method.serves(model)) {
    throw new Denied(`${target.slice(colon + 1)} is not available for model "${model}"`);
  }
  const body = jsonBody(request);
  if ('tools' in body) throw new Denied('Server-side tools are not allowed for media generation');
  return {
    allowed: true,
    permission: method.permission,
    detail: target,
    body: canonical(body),
  };
}

/** `GET /v1beta/models[/<model>[/operations/<id>]]`. */
function readModels(request: ToolRequest, grant: Grant, rest: readonly string[]): AuthzAllowed {
  const [model, operations, id, ...extra] = rest;
  if (operations === undefined) {
    checkQuery(request.search, model === undefined ? { pageSize: null, pageToken: null } : {});
    requirePermission(grant, PERM.MODELS_READ);
    return { allowed: true, permission: PERM.MODELS_READ };
  }
  if (operations !== OPERATIONS || !id || extra.length > 0 || model === undefined) {
    throw notCovered(request);
  }
  checkQuery(request.search, {});
  requirePermission(grant, PERM.VIDEOS);
  checkModel(grant, model);
  return { allowed: true, permission: PERM.VIDEOS, detail: `operation ${model}/${id}` };
}

/** A Google storage address a file download may redirect to; anything else is not followed. */
function redirectTarget(location: string | null, base: string): URL | null {
  if (!location) return null;
  let url: URL;
  try {
    url = new URL(location, base);
  } catch {
    return null;
  }
  const google = REDIRECT_HOSTS.some((suffix) => url.hostname.endsWith(suffix));
  return url.protocol === 'https:' && google ? url : null;
}

/** Follows a download's redirects to Google's storage, which agents can't reach themselves. */
function followDownload(fetchImpl: typeof fetch, secret: string) {
  return async (upstream: Response): Promise<Response> => {
    let response = upstream;
    let from = `${API}/`;
    for (let hop = 0; hop < MAX_REDIRECTS && isRedirect(response.status); hop += 1) {
      const next = redirectTarget(response.headers.get('location'), from);
      if (!next) return response;
      await response.body?.cancel();
      // The API key only goes to the API host itself; storage URLs are signed.
      const headers = next.host === API_HOST ? { [API_KEY_HEADER]: secret } : undefined;
      response = await fetchImpl(next.href, { headers, redirect: 'manual' });
      from = next.href;
    }
    return response;
  };
}

/** `GET /v1beta/files/<id>:download?alt=media`. */
function download(
  request: ToolRequest,
  grant: Grant,
  rest: readonly string[],
  follow: AuthzAllowed['transformResponse'],
): AuthzAllowed {
  const [file, ...extra] = rest;
  if (!file?.endsWith(':download') || extra.length > 0) throw notCovered(request);
  checkQuery(request.search, { alt: 'media' });
  requirePermission(grant, PERM.VIDEOS);
  return {
    allowed: true,
    permission: PERM.VIDEOS,
    detail: `download ${file.slice(0, -':download'.length)}`,
    transformResponse: follow,
  };
}

function authorizeRequest(
  request: ToolRequest,
  grant: Grant,
  follow: AuthzAllowed['transformResponse'],
): AuthzDecision {
  const verb = request.method.toUpperCase();
  const [version, collection, ...rest] = request.segments;
  if (version !== VERSION) throw new Denied(`Only /${VERSION}/… calls are supported`);
  if (verb === 'POST' && collection === MODELS && rest.length === 1 && rest[0]) {
    return generate(request, grant, rest[0]);
  }
  if (verb === 'GET' && collection === MODELS) return readModels(request, grant, rest);
  if (verb === 'GET' && collection === FILES) return download(request, grant, rest, follow);
  throw notCovered(request);
}

export function createGeminiMediaProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  return {
    id: 'gemini-media',
    name: 'Gemini image & video generation',
    sessionKeyHeaders: [API_KEY_HEADER],
    credentialHelp:
      'A Gemini API key (aistudio.google.com → API keys). Agents generate images (Gemini image models, Imagen) and videos (Veo) through the gateway with their session key and never see this key.',
    credentialPlaceholder: 'AIza…',
    resourceHelp:
      'One model per line; `*` matches any characters (e.g. imagen-4.0-*, veo-3.*). Leave empty to allow every image and video model.',
    permissions: PERMISSIONS,
    upstreamBaseUrl: API,
    example: {
      method: 'POST',
      path: `/${VERSION}/${MODELS}/imagen-4.0-generate-001:predict`,
      body: '{"instances":[{"prompt":"A lighthouse at dawn"}],"parameters":{"sampleCount":1}}',
      clientHint: `Gemini API base URL, session key in ${API_KEY_HEADER}`,
    },

    validateResource: validateModelPattern,

    async verifyCredential(secret) {
      const res = await fetchImpl(`${API}/${VERSION}/${MODELS}?pageSize=1`, {
        headers: { [API_KEY_HEADER]: secret },
      });
      if (!res.ok) throw new Error(`Google rejected the API key (HTTP ${res.status})`);
      return { keyType: 'API key' };
    },

    authorize: (request, grant, { secret }) =>
      decide(() => authorizeRequest(request, grant, followDownload(fetchImpl, secret))),

    upstreamHeaders(secret, incoming) {
      const headers = forwardHeaders(incoming, ['content-type', 'accept']);
      headers.set(API_KEY_HEADER, secret);
      return headers;
    },
  };
}
