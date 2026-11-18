const SRC = 'https://data.calgary.ca/resource/w8zq-79bq.json';
const ALLOWED_ORIGINS = new Set([
  'https://jessikamessika.github.io',
  'http://127.0.0.1:8000',
  'http://localhost:8000',
]);
// Optional extra origin for phone testing on the LAN, e.g. http://192.168.x.y:8000.
// Set with `npx wrangler secret put DEV_ORIGIN`; delete the secret when done.
const originAllowed = (origin, env) =>
  ALLOWED_ORIGINS.has(origin) || (!!env.DEV_ORIGIN && origin === env.DEV_ORIGIN);
const CACHE_SECONDS = 900;

// Since 2026-11-17 the City's `point` column is WKT text ("POINT (lon lat)"), not
// GeoJSON. Build the Point from the numeric `longitude`/`latitude` columns; null
// (row dropped) when they don't parse, so no invalid geometry reaches the map.
const toPoint = r => {
  const lng = parseFloat(r.longitude), lat = parseFloat(r.latitude);
  if (Number.isFinite(lng) && Number.isFinite(lat)) return { type: 'Point', coordinates: [lng, lat] };
  if (r.point && typeof r.point === 'object' && r.point.type === 'Point') return r.point;   // old GeoJSON format
  return null;
};

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    if (!originAllowed(origin, env)) {
      return new Response(JSON.stringify({ error: { message: 'Origin not allowed' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
    };
    const cache = caches.default;
    const key = new Request('https://closures-cache/active');
    let res = await cache.match(key);
    if (!res) {
      const now = new Date().toLocaleString('sv-SE', { timeZone: 'America/Edmonton' }).replace(' ', 'T');
      const q = `$where=start_dt <= '${now}' AND end_dt >= '${now}'&$limit=2000`;
      const up = await fetch(`${SRC}?${q}`);
      if (!up.ok) return new Response(JSON.stringify({ error: 'upstream', status: up.status }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
      const rows = await up.json();
      const geojson = {
        type: 'FeatureCollection',
        fetched_at: new Date().toISOString(),
        features: rows.map(r => ({ r, geometry: toPoint(r) })).filter(x => x.geometry).map(({ r, geometry }) => ({
          type: 'Feature', geometry,
          properties: { info: r.construction_info, description: r.description || '', start: r.start_dt, end: r.end_dt }
        }))
      };
      res = new Response(JSON.stringify(geojson),
        { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` } });
      await cache.put(key, res.clone());
    }
    return new Response(res.body, { headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};