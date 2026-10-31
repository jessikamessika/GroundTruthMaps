const SRC = 'https://data.calgary.ca/resource/w8zq-79bq.json';
const ALLOWED_ORIGINS = new Set([
  'https://jessikamessika.github.io',
  'http://127.0.0.1:8000',
  'http://localhost:8000',
]);
const CACHE_SECONDS = 900;

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : 'null',
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
        features: rows.filter(r => r.point).map(r => ({
          type: 'Feature', geometry: r.point,
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