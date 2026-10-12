import { isRedirect } from '../httpStatus.js';
import { isRecord } from './json.js';
import type { AuthzAllowed, AuthzDecision, Grant, ToolProvider, ToolRequest } from './types.js';
import {
  canonical,
  decide,
  Denied,
  forwardHeaders,
  jsonBody,
  requirePermission,
} from './llm/common.js';

/**
 * Google Maps Platform web services, as a tool agents call: geocoding, places, directions and
 * distances, elevation, time zones, map images and address validation. The classic web services
 * live on `https://maps.googleapis.com/maps/api/…` (the key goes in `?key=`); Places (New), Routes
 * and Address Validation each have their own host, reached through `/places/…`, `/routes/…` and
 * `/addressvalidation/…`. Clients send their session key as `x-goog-api-key` or bearer, never
 * `?key=`. Photos redirect to Google's image CDN, which agents can't reach: the gateway follows
 * those redirects (only there) for them.
 */

const API = 'https://maps.googleapis.com';
const API_KEY_HEADER = 'x-goog-api-key';
/** Request headers the newer APIs read (which response fields to return, result language). */
const FORWARDED_HEADERS = ['content-type', 'accept', 'accept-language', 'x-goog-fieldmask'];
/** Hops followed when a photo redirects to Google's image CDN. */
const MAX_REDIRECTS = 3;
const REDIRECT_HOSTS = ['.googleusercontent.com', '.ggpht.com'];
/** Path segments of the newer APIs (place ids, photo names, `places:searchText`…). */
const SEGMENT = /^[A-Za-z0-9._:-]+$/;
/** Query parameters that would replace the gateway's credential or billing. */
const CREDENTIAL_PARAMS = new Set(['key', 'signature', 'client']);
/** Street View metadata requests are free, and answer REQUEST_DENIED for an invalid key. */
const PROBE_URL = `${API}/maps/api/streetview/metadata?location=0,0`;

const PERM = {
  GEOCODING: 'geocoding:read',
  PLACES: 'places:read',
  ROUTES: 'routes:read',
  ELEVATION: 'elevation:read',
  TIMEZONE: 'timezone:read',
  IMAGES: 'maps:images',
  ADDRESSES: 'addresses:validate',
} as const;

const PERMISSIONS = [
  {
    id: PERM.GEOCODING,
    label: 'Geocoding',
    description:
      'Addresses to coordinates and back (GET /maps/api/geocode/json?address=… or ?latlng=…).',
  },
  {
    id: PERM.PLACES,
    label: 'Places',
    description:
      'Search places, autocomplete, details and photos: Places API (GET /maps/api/place/<textsearch|nearbysearch|findplacefromtext|autocomplete|queryautocomplete|details>/json, GET /maps/api/place/photo) and Places API (New) (POST /places/v1/places:searchText, :searchNearby, :autocomplete; GET /places/v1/places/<id>[/photos/<photo>/media]).',
  },
  {
    id: PERM.ROUTES,
    label: 'Directions & distances',
    description:
      'Directions and travel times: GET /maps/api/directions/json, GET /maps/api/distancematrix/json, and the Routes API (POST /routes/directions/v2:computeRoutes, POST /routes/distanceMatrix/v2:computeRouteMatrix).',
  },
  {
    id: PERM.ELEVATION,
    label: 'Elevation',
    description: 'Elevation of points or along a path (GET /maps/api/elevation/json).',
  },
  {
    id: PERM.TIMEZONE,
    label: 'Time zones',
    description: 'Time zone of a location (GET /maps/api/timezone/json).',
  },
  {
    id: PERM.IMAGES,
    label: 'Map images',
    description:
      'Static map and Street View images (GET /maps/api/staticmap, GET /maps/api/streetview[/metadata]). Custom marker icons are refused: Google would fetch them from the internet.',
  },
  {
    id: PERM.ADDRESSES,
    label: 'Address validation',
    description:
      'Validate and standardize postal addresses (POST /addressvalidation/v1:validateAddress).',
  },
] as const;

interface WebService {
  permission: string;
  params: readonly string[];
  /** Answers in `/json` or `/xml` (otherwise the path ends with the service name). */
  outputs: boolean;
}

const PLACE_SEARCH = ['location', 'radius', 'language', 'maxprice', 'minprice', 'opennow'];
const ROUTE_PARAMS = [
  'mode',
  'avoid',
  'language',
  'units',
  'region',
  'arrival_time',
  'departure_time',
  'traffic_model',
  'transit_mode',
  'transit_routing_preference',
];
const STREETVIEW = ['size', 'location', 'pano', 'heading', 'fov', 'pitch', 'radius', 'source'];

/** Classic web services under `/maps/api/`, with the query parameters each accepts. */
const WEB_SERVICES: Record<string, WebService> = {
  geocode: {
    permission: PERM.GEOCODING,
    outputs: true,
    params: [
      'address',
      'components',
      'bounds',
      'language',
      'region',
      'latlng',
      'result_type',
      'location_type',
      'place_id',
      'extra_computations',
    ],
  },
  'place/textsearch': {
    permission: PERM.PLACES,
    outputs: true,
    params: [...PLACE_SEARCH, 'query', 'pagetoken', 'region', 'type'],
  },
  'place/nearbysearch': {
    permission: PERM.PLACES,
    outputs: true,
    params: [...PLACE_SEARCH, 'keyword', 'name', 'pagetoken', 'rankby', 'type'],
  },
  'place/findplacefromtext': {
    permission: PERM.PLACES,
    outputs: true,
    params: ['input', 'inputtype', 'fields', 'language', 'locationbias'],
  },
  'place/details': {
    permission: PERM.PLACES,
    outputs: true,
    params: [
      'place_id',
      'fields',
      'language',
      'region',
      'reviews_no_translations',
      'reviews_sort',
      'sessiontoken',
    ],
  },
  'place/autocomplete': {
    permission: PERM.PLACES,
    outputs: true,
    params: [
      'input',
      'sessiontoken',
      'components',
      'strictbounds',
      'offset',
      'origin',
      'location',
      'locationbias',
      'locationrestriction',
      'radius',
      'region',
      'types',
      'language',
    ],
  },
  'place/queryautocomplete': {
    permission: PERM.PLACES,
    outputs: true,
    params: ['input', 'offset', 'location', 'radius', 'language'],
  },
  'place/photo': {
    permission: PERM.PLACES,
    outputs: false,
    params: ['photo_reference', 'photoreference', 'maxwidth', 'maxheight'],
  },
  directions: {
    permission: PERM.ROUTES,
    outputs: true,
    params: [...ROUTE_PARAMS, 'origin', 'destination', 'waypoints', 'alternatives'],
  },
  distancematrix: {
    permission: PERM.ROUTES,
    outputs: true,
    params: [...ROUTE_PARAMS, 'origins', 'destinations'],
  },
  elevation: {
    permission: PERM.ELEVATION,
    outputs: true,
    params: ['locations', 'path', 'samples'],
  },
  timezone: {
    permission: PERM.TIMEZONE,
    outputs: true,
    params: ['location', 'timestamp', 'language'],
  },
  staticmap: {
    permission: PERM.IMAGES,
    outputs: false,
    params: [
      'center',
      'zoom',
      'size',
      'scale',
      'format',
      'maptype',
      'language',
      'region',
      'map_id',
      'markers',
      'path',
      'visible',
      'style',
    ],
  },
  streetview: {
    permission: PERM.IMAGES,
    outputs: false,
    params: [...STREETVIEW, 'return_error_code'],
  },
  'streetview/metadata': { permission: PERM.IMAGES, outputs: false, params: STREETVIEW },
};
const OUTPUTS = ['json', 'xml'];

/** Hosts of the newer APIs, by the first path segment that reaches them. */
const NEW_API_HOSTS: Record<string, string> = {
  places: 'https://places.googleapis.com',
  routes: 'https://routes.googleapis.com',
  addressvalidation: 'https://addressvalidation.googleapis.com',
};

/** Newer API calls: `<method> <path under the API's host>` → permission and query parameters. */
const NEW_API_CALLS: Record<string, { permission: string; params: readonly string[] }> = {
  'POST places/v1/places:searchText': { permission: PERM.PLACES, params: ['fields'] },
  'POST places/v1/places:searchNearby': { permission: PERM.PLACES, params: ['fields'] },
  'POST places/v1/places:autocomplete': { permission: PERM.PLACES, params: ['fields'] },
  'GET places/v1/places/*': {
    permission: PERM.PLACES,
    params: ['fields', 'languageCode', 'regionCode', 'sessionToken'],
  },
  'GET places/v1/places/*/photos/*/media': {
    permission: PERM.PLACES,
    params: ['maxWidthPx', 'maxHeightPx', 'skipHttpRedirect'],
  },
  'POST routes/directions/v2:computeRoutes': { permission: PERM.ROUTES, params: ['fields'] },
  'POST routes/distanceMatrix/v2:computeRouteMatrix': {
    permission: PERM.ROUTES,
    params: ['fields'],
  },
  'POST addressvalidation/v1:validateAddress': { permission: PERM.ADDRESSES, params: [] },
};
/** Path segments that are ids in `NEW_API_CALLS` patterns. */
const ID_PATTERNS: { position: number; under: string }[] = [
  { position: 3, under: 'places' },
  { position: 5, under: 'photos' },
];

function notCovered(request: ToolRequest): Denied {
  return new Denied(
    `${request.method.toUpperCase()} /${request.segments.join('/')} is not covered by any gateway permission`,
  );
}

/** Refuses credentials in the query and any parameter not in `allowed`. */
function checkQuery(search: string, allowed: readonly string[]): URLSearchParams {
  const params = new URLSearchParams(search);
  for (const name of params.keys()) {
    if (CREDENTIAL_PARAMS.has(name)) {
      throw new Denied(`Send the session key in ${API_KEY_HEADER} or as bearer, not ?${name}=`);
    }
    if (!allowed.includes(name)) throw new Denied(`Unsupported query parameter "${name}"`);
  }
  return params;
}

/** Google would download custom marker icons from the internet on the agent's behalf. */
function checkMarkers(params: URLSearchParams): void {
  if (params.getAll('markers').some((markers) => /(^|\|)\s*(icon|anchor):/i.test(markers))) {
    throw new Denied('Custom marker icons are not allowed: Google fetches them from the internet');
  }
}

/** The classic web service a `/maps/api/…` path calls, or null. */
function webService(rest: readonly string[]): WebService | null {
  const last = rest.at(-1) ?? '';
  const withOutput = WEB_SERVICES[rest.slice(0, -1).join('/')];
  if (withOutput?.outputs && OUTPUTS.includes(last)) return withOutput;
  const plain = WEB_SERVICES[rest.join('/')];
  return plain && !plain.outputs ? plain : null;
}

/** A Google image CDN address a photo may redirect to; anything else is not followed. */
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

/** Follows a photo's redirects to Google's image CDN (public URLs: the key never goes there). */
function followPhoto(fetchImpl: typeof fetch, from: string) {
  return async (upstream: Response): Promise<Response> => {
    let response = upstream;
    let base = from;
    for (let hop = 0; hop < MAX_REDIRECTS && isRedirect(response.status); hop += 1) {
      const next = redirectTarget(response.headers.get('location'), base);
      if (!next) return response;
      await response.body?.cancel();
      response = await fetchImpl(next.href, {
        headers: { 'user-agent': 'local-gateway' },
        redirect: 'manual',
      });
      base = next.href;
    }
    return response;
  };
}

/** `GET /maps/api/<service>[/json|/xml]`: the key is added to the query. */
function classic(
  request: ToolRequest,
  grant: Grant,
  secret: string,
  follow: (from: string) => AuthzAllowed['transformResponse'],
): AuthzAllowed {
  const rest = request.segments.slice(2);
  const service = webService(rest);
  if (request.method.toUpperCase() !== 'GET' || !service) throw notCovered(request);
  const params = checkQuery(request.search, service.params);
  requirePermission(grant, service.permission);
  checkMarkers(params);
  params.set('key', secret);
  const photo = rest.join('/') === 'place/photo';
  return {
    allowed: true,
    permission: service.permission,
    detail: rest.join('/'),
    search: `?${params.toString()}`,
    transformResponse: photo ? follow(`${API}/`) : undefined,
  };
}

/** The `NEW_API_CALLS` pattern of a path: id segments become `*`. */
function callPattern(segments: readonly string[]): string {
  return segments
    .map((segment, i) =>
      ID_PATTERNS.some((p) => p.position === i && segments[i - 1] === p.under) ? '*' : segment,
    )
    .join('/');
}

/** `/places/…`, `/routes/…`, `/addressvalidation/…`: sent to that API's own host. */
function newApi(
  request: ToolRequest,
  grant: Grant,
  host: string,
  follow: (from: string) => AuthzAllowed['transformResponse'],
): AuthzAllowed {
  const verb = request.method.toUpperCase();
  const { segments } = request;
  const call = NEW_API_CALLS[`${verb} ${callPattern(segments)}`];
  if (!call || !segments.every((s) => SEGMENT.test(s))) throw notCovered(request);
  const params = checkQuery(request.search, call.params);
  requirePermission(grant, call.permission);
  const path = segments.slice(1).join('/');
  const query = params.toString();
  const url = query ? `${host}/${path}?${query}` : `${host}/${path}`;
  const allowed: AuthzAllowed = {
    allowed: true,
    permission: call.permission,
    detail: path,
    upstreamUrl: url,
  };
  if (verb === 'POST') return { ...allowed, body: canonical(jsonBody(request)) };
  return segments.at(-1) === 'media' ? { ...allowed, transformResponse: follow(url) } : allowed;
}

function authorizeRequest(
  request: ToolRequest,
  grant: Grant,
  secret: string,
  follow: (from: string) => AuthzAllowed['transformResponse'],
): AuthzDecision {
  const [first, second] = request.segments;
  if (first === 'maps' && second === 'api') return classic(request, grant, secret, follow);
  const host = first === undefined ? undefined : NEW_API_HOSTS[first];
  if (host) return newApi(request, grant, host, follow);
  throw notCovered(request);
}

export function createGoogleMapsProvider(fetchImpl: typeof fetch = fetch): ToolProvider {
  const follow = (from: string) => followPhoto(fetchImpl, from);
  return {
    id: 'google-maps',
    name: 'Google Maps',
    sessionKeyHeaders: [API_KEY_HEADER],
    credentialHelp:
      'A Google Maps Platform API key (console.cloud.google.com → Google Maps Platform → Keys & Credentials), with the APIs agents should use enabled. Agents call Maps through the gateway with their session key and never see this key.',
    credentialPlaceholder: 'AIza…',
    resourceHelp: 'Not used: Google Maps grants are limited by permission only. Leave empty.',
    permissions: PERMISSIONS,
    upstreamBaseUrl: API,
    example: {
      method: 'GET',
      path: '/maps/api/geocode/json?address=1600+Amphitheatre+Parkway,+Mountain+View',
      clientHint: `Instead of https://maps.googleapis.com, session key in ${API_KEY_HEADER} or bearer (not ?key=)`,
    },

    validateResource: () => 'Google Maps grants take no resources: leave the list empty',

    async verifyCredential(secret) {
      const res = await fetchImpl(`${PROBE_URL}&key=${encodeURIComponent(secret)}`);
      const json: unknown = await res.json().catch(() => null);
      const denied = isRecord(json) && json.status === 'REQUEST_DENIED';
      if (!res.ok || denied) {
        const reason = denied ? 'REQUEST_DENIED' : `HTTP ${String(res.status)}`;
        throw new Error(`Google rejected the API key (${reason})`);
      }
      return { keyType: 'Maps Platform API key' };
    },

    authorize: (request, grant, { secret }) =>
      decide(() => authorizeRequest(request, grant, secret, follow)),

    upstreamHeaders(secret, incoming) {
      const headers = forwardHeaders(incoming, FORWARDED_HEADERS);
      headers.set(API_KEY_HEADER, secret);
      return headers;
    },
  };
}
