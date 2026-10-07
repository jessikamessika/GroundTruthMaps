// web/routing.js — plain ORS route + closure crossing check
const ORS_URL = 'https://api.openrouteservice.org/v2/directions/cycling-regular/geojson';
const ORS_KEY = 'PASTE_DOMAIN_RESTRICTED_KEY';   // see note below
const CLOSURE_BUFFER_M = 15;

function isActive(p) {
  const temporal = p.calgary_temporal_status || 'CURRENT';
  return p.status === 'closed' && temporal === 'CURRENT';
}

let _bufferedCache = { src: null, feats: [] };
function bufferedClosures(closures) {
  if (_bufferedCache.src === closures) return _bufferedCache.feats;
  const feats = [];
  for (const f of closures.features) {
    if (!isActive(f.properties || {})) continue;
    const b = turf.buffer(f, CLOSURE_BUFFER_M / 1000, { units: 'kilometers' });
    if (b) { b.properties = f.properties; feats.push(b); }
  }
  _bufferedCache = { src: closures, feats };
  return feats;
}

// Shared by the UI; the Python batch script mirrors this logic (UTM 11N, 15 m buffer).
// Returns the ORIGINAL closure features (not buffers) that the route touches.
function routeCrossesClosures(route, closures) {
  const hits = [];
  for (const b of bufferedClosures(closures)) {
    if (turf.booleanIntersects(route, b)) hits.push(b);
  }
  // map back to original geometry for highlighting
  return hits.map(h => closures.features.find(f => f.properties === h.properties));
}

async function fetchPlainRoute(start, end) {   // [lng, lat] each
  const r = await fetch(ORS_URL, {
    method: 'POST',
    headers: { 'Authorization': ORS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ coordinates: [start, end], radiuses: [500, 500] }),
  });
  if (!r.ok) throw new Error(`ORS ${r.status}`);
  const fc = await r.json();
  if (!fc.features?.length) throw new Error('No route found');
  return fc.features[0];
}