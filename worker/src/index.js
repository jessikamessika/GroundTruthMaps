const ALLOWED_ORIGINS = new Set([
  'https://jessikamessika.github.io',
  'http://127.0.0.1:8000',
  'http://localhost:8000',
]);
const ORS = 'https://api.openrouteservice.org/v2/directions/cycling-regular/geojson';
const BBOXES = [
  { minLng: -114.5,  maxLng: -113.7,  minLat: 50.8,  maxLat: 51.3  },  // Calgary
  { minLng: -122.55, maxLng: -122.35, minLat: 37.70, maxLat: 37.84 },  // San Francisco (checked GMaps.)
];
const inAnyBox = p => BBOXES.some(b => p[0] >= b.minLng && p[0] <= b.maxLng && p[1] >= b.minLat && p[1] <= b.maxLat);

const err = (status, message, headers = {}) =>
  new Response(JSON.stringify({ error: { message } }),
    { status, headers: { 'Content-Type': 'application/json', ...headers } });

function validCoords(c) {
  return Array.isArray(c) && c.length === 2 && c.every(p =>
    Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) &&
    inAnyBox(p));
}

const MAX_AVOID_POLYGONS = 40;
const MAX_AVOID_VERTICES = 4000;

// Optional field. If present it must be a MultiPolygon, inside a supported city, within size caps.
function validAvoid(a) {
  if (a === undefined || a === null) return true;
  if (a.type !== 'MultiPolygon' || !Array.isArray(a.coordinates)) return false;
  if (a.coordinates.length === 0 || a.coordinates.length > MAX_AVOID_POLYGONS) return false;
  let vertices = 0;
  for (const poly of a.coordinates) {
    if (!Array.isArray(poly) || poly.length === 0) return false;
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 4) return false;
      for (const p of ring) {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || !inAnyBox(p)) return false;
        vertices++;
      }
      if (vertices > MAX_AVOID_VERTICES) return false;
    }
  }
  return true;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.has(origin)) return err(403, 'Origin not allowed');

    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return err(405, 'POST only', cors);

    let body;
    try { body = await request.json(); } catch { return err(400, 'Invalid JSON', cors); }
    if (!validCoords(body.coordinates)) return err(400, 'Coordinates must be two [lng, lat] points in a supported city', cors);
    if (!validAvoid(body.avoid_polygons)) return err(400, 'avoid_polygons must be a MultiPolygon in a supported city, within size limits', cors);
    
    // Rate limit: one shared bucket protects the ORS allowance
    const { success } = await env.ROUTE_LIMITER.limit({ key: 'route' });
    if (!success) return err(429, 'Route service is busy. Please try again in a minute.', cors);

    const avoid = body.avoid_polygons || null;
    const orsBody = { coordinates: body.coordinates, radiuses: [500, 500] };
    if (avoid) orsBody.options = { avoid_polygons: avoid };

    let upstream;
    try {
      upstream = await fetch(ORS, {
        method: 'POST',
        headers: { 'Authorization': env.ORS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(orsBody),
      });
    } catch (e) {
      console.error('Upstream fetch threw:', String(e));
      return err(502, 'Upstream fetch failed: ' + String(e), cors);
    }

    const text = await upstream.text();
    if (!upstream.ok) console.error('ORS responded', upstream.status, text.slice(0, 300));

    // On success, tell the client whether avoidance was actually sent. Errors pass through untouched.
    let out = text;
    if (upstream.ok) {
      try { out = JSON.stringify({ ...JSON.parse(text), avoid_applied: Boolean(avoid) }); } catch (_) {}
    }
    return new Response(out, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};