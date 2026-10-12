import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/http/app.js';
import { createHarness, MAPS_PHOTO_BYTES, type Harness } from './helpers.js';

const TOOL = 'google-maps';
const BASE = `/proxy/${TOOL}`;
const MAPS = 'https://maps.googleapis.com';
const SECRET = 'real-maps-secret';
const ALL = [
  'geocoding:read',
  'places:read',
  'routes:read',
  'elevation:read',
  'timezone:read',
  'maps:images',
  'addresses:validate',
];
const PLACE = 'ChIJj61dQgK6j4AR4GeTYWZsKWw';

let h: Harness;
let app: ReturnType<typeof createApp>;
let admin: string;
let templates = 0;

const adminPost = (path: string, body: object) =>
  request(app).post(`/api/admin${path}`).set('authorization', `Bearer ${admin}`).send(body);

async function keyFor(permissions: string[] = ALL): Promise<string> {
  const tpl = await adminPost('/templates', {
    name: `maps ${String((templates += 1))}`,
    grants: [{ tool: TOOL, permissions, resources: [] }],
    defaultTtlSeconds: 600,
    maxTtlSeconds: 3600,
  }).expect(201);
  const res = await adminPost('/sessions', { templateId: tpl.body.id }).expect(201);
  return res.body.key as string;
}

const get = (key: string, path: string) =>
  request(app).get(`${BASE}${path}`).set('x-goog-api-key', key);
const post = (key: string, path: string, body: object = {}) =>
  request(app).post(`${BASE}${path}`).set('authorization', `Bearer ${key}`).send(body);

const lastCall = () => {
  const call = h.upstreamCalls.at(-1);
  if (!call) throw new Error('no upstream call');
  return { url: call.url, method: call.init.method, headers: new Headers(call.init.headers) };
};

beforeEach(async () => {
  h = await createHarness();
  app = createApp(h.gateway, h.config, { fetch: h.fetch });
  admin = await h.gateway.rotateAdminToken();
  await adminPost('/accounts', { tool: TOOL, label: 'maps', secret: SECRET }).expect(201);
});

describe('Google Maps', () => {
  it('is offered as a tool, verifies the API key and takes no resources', async () => {
    const tools = await request(app)
      .get('/api/admin/tools')
      .set('authorization', `Bearer ${admin}`)
      .expect(200);
    expect((tools.body as { id: string }[]).some((t) => t.id === TOOL)).toBe(true);
    await adminPost('/accounts', { tool: TOOL, label: 'bad', secret: 'bad-key' }).expect(422);
    await adminPost('/templates', {
      name: 'maps with resources',
      grants: [{ tool: TOOL, permissions: ['geocoding:read'], resources: ['anything'] }],
      defaultTtlSeconds: 600,
      maxTtlSeconds: 3600,
    }).expect(400);
  });

  it('calls the classic web services with the real key in the query', async () => {
    const key = await keyFor(['geocoding:read']);
    await get(key, '/maps/api/geocode/json?address=10+Downing+St,+London&region=uk').expect(200);
    expect(lastCall().url).toBe(
      `${MAPS}/maps/api/geocode/json?address=10+Downing+St%2C+London&region=uk&key=${SECRET}`,
    );
    await request(app)
      .get(`${BASE}/maps/api/geocode/xml?latlng=51.5,-0.12`)
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    const activity = h.gateway.activity.recent(5);
    expect(JSON.stringify(activity)).not.toContain(SECRET);
  });

  it('checks each service against its permission', async () => {
    const key = await keyFor(['routes:read', 'timezone:read']);
    await get(key, '/maps/api/directions/json?origin=Paris&destination=Lyon&mode=driving').expect(
      200,
    );
    await get(key, '/maps/api/distancematrix/json?origins=Paris&destinations=Lyon').expect(200);
    await get(key, '/maps/api/timezone/json?location=48.85,2.35&timestamp=0').expect(200);
    const geocode = await get(key, '/maps/api/geocode/json?address=Paris');
    expect(geocode.status).toBe(403);
    expect(geocode.body.message).toContain('geocoding:read');
    await get(key, '/maps/api/elevation/json?locations=48.85,2.35').expect(403);
    await get(key, '/maps/api/place/textsearch/json?query=cafe').expect(403);
    await get(key, '/maps/api/staticmap?center=Paris&size=400x400').expect(403);
  });

  it('refuses keys, signatures, unknown parameters, services and methods', async () => {
    const key = await keyFor();
    const before = h.upstreamCalls.length;
    const leaked = await get(key, '/maps/api/geocode/json?address=Paris&key=AIzaOther');
    expect(leaked.status).toBe(403);
    expect(leaked.body.message).toContain('x-goog-api-key');
    await get(key, '/maps/api/geocode/json?address=Paris&signature=abc').expect(403);
    await get(key, '/maps/api/geocode/json?address=Paris&callback=x').expect(403);
    await get(key, '/maps/api/geocode/csv?address=Paris').expect(403);
    await get(key, '/maps/api/geocode').expect(403);
    await get(key, '/maps/api/staticmap/json?center=Paris').expect(403);
    await get(key, '/maps/api/js?libraries=places').expect(403);
    await post(key, '/maps/api/geocode/json', {}).expect(403);
    await get(key, '/v1/other').expect(403);
    expect(h.upstreamCalls.length).toBe(before);
  });

  it('serves map images but no custom marker icons', async () => {
    const key = await keyFor(['maps:images']);
    await get(
      key,
      '/maps/api/staticmap?center=Paris&size=400x400&markers=color:red|48.85,2.35',
    ).expect(200);
    await get(key, '/maps/api/streetview/metadata?location=48.85,2.35').expect(200);
    await get(key, '/maps/api/streetview?location=48.85,2.35&size=600x300').expect(200);
    const icon = await get(
      key,
      `/maps/api/staticmap?center=Paris&size=400x400&markers=${encodeURIComponent('icon:https://attacker.example/i.png|48.85,2.35')}`,
    );
    expect(icon.status).toBe(403);
    expect(icon.body.message).toContain('marker icons');
  });

  it('calls Places (New), Routes and Address Validation on their own hosts', async () => {
    const key = await keyFor(['places:read', 'routes:read', 'addresses:validate']);
    await post(key, '/places/v1/places:searchText', { textQuery: 'pizza in Rome' })
      .set('x-goog-fieldmask', 'places.displayName')
      .set('x-goog-user-project', 'someone-else')
      .expect(200);
    expect(lastCall().url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(lastCall().headers.get('x-goog-api-key')).toBe(SECRET);
    expect(lastCall().headers.get('x-goog-fieldmask')).toBe('places.displayName');
    expect(lastCall().headers.get('x-goog-user-project')).toBeNull();
    await get(key, `/places/v1/places/${PLACE}?fields=displayName&languageCode=fr`).expect(200);
    expect(lastCall().url).toBe(
      `https://places.googleapis.com/v1/places/${PLACE}?fields=displayName&languageCode=fr`,
    );
    await post(key, '/routes/directions/v2:computeRoutes', { origin: {}, destination: {} }).expect(
      200,
    );
    expect(lastCall().url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    await post(key, '/routes/distanceMatrix/v2:computeRouteMatrix', { origins: [] }).expect(200);
    await post(key, '/addressvalidation/v1:validateAddress', { address: {} }).expect(200);
    expect(lastCall().url).toBe('https://addressvalidation.googleapis.com/v1:validateAddress');

    await get(key, '/places/v1/places:searchText').expect(403);
    await post(key, '/places/v1/places/abc', {}).expect(403);
    await post(key, '/places/v1/places:searchText?key=x', {}).expect(403);
    await post(key, '/routes/directions/v2:computeRoutes?alt=x', {}).expect(403);
    await post(key, '/addressvalidation/v1:provideValidationFeedback', {}).expect(403);
    await request(app)
      .delete(`${BASE}/places/v1/places/${PLACE}`)
      .set('authorization', `Bearer ${key}`)
      .expect(403);

    const geocodeOnly = await keyFor(['geocoding:read']);
    await post(geocodeOnly, '/places/v1/places:searchText', { textQuery: 'x' }).expect(403);
    await post(geocodeOnly, '/addressvalidation/v1:validateAddress', { address: {} }).expect(403);
  });

  it("downloads photos from Google's image CDN only, without the key", async () => {
    const key = await keyFor(['places:read']);
    const legacy = await get(key, '/maps/api/place/photo?photo_reference=abc&maxwidth=400');
    expect(legacy.status).toBe(200);
    expect(legacy.text).toBe(MAPS_PHOTO_BYTES);
    expect(lastCall().url).toMatch(/^https:\/\/lh3\.googleusercontent\.com\//);
    expect(lastCall().headers.get('x-goog-api-key')).toBeNull();
    expect(lastCall().url).not.toContain(SECRET);

    const media = await get(key, `/places/v1/places/${PLACE}/photos/AXCi2Q/media?maxWidthPx=400`);
    expect(media.text).toBe(MAPS_PHOTO_BYTES);

    const elsewhere = await get(key, '/maps/api/place/photo?photo_reference=elsewhere');
    expect(elsewhere.status).toBe(302);
    expect(h.upstreamCalls.some((c) => c.url.startsWith('https://attacker.example'))).toBe(false);
  });
});
