// web/routing.js — plain ORS route + closure crossing check
const PROXY_URL = 'https://ors-proxy.jess-jm-zhang.workers.dev';
const CLOSURE_BUFFER_M = 15;
const BLOCKING = new Set(['closed']);   // 'detour' = passable via posted detour; 'reduced' = passable

function todayCalgary() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' }); // YYYY-MM-DD
}

function closureInfo(p) {
  const note = p.detour_note || '';
  const i = note.indexOf(' \u2014 ');
  const t = p.calgary_temporal_status;
  return {
    name: (i > -1 ? note.slice(0, i) : note) || 'Unnamed closure',
    text: i > -1 ? note.slice(i + 3) : '',
    // conservative: only FUTURE/PAST are excluded; a missing field still warns
    blocking: BLOCKING.has(p.status) && t !== 'FUTURE' && t !== 'PAST',
    pastEndDate: !!p.end_date && p.end_date < todayCalgary(),
  };
}

let _cache = { src: null, items: [] };
function bufferedClosures(closures) {
  if (_cache.src === closures) return _cache.items;
  const items = [];
  for (const feature of closures.features) {
    const info = closureInfo(feature.properties || {});
    if (!info.blocking) continue;
    const buf = turf.buffer(feature, CLOSURE_BUFFER_M / 1000, { units: 'kilometers' });
    if (buf) items.push({ buf, feature, info });
  }
  _cache = { src: closures, items };
  return items;
}

// Returns [{feature, info}] for every blocking closure the route touches.
function routeCrossesClosures(route, closures) {
  return bufferedClosures(closures)
    .filter(c => turf.booleanIntersects(route, c.buf))
    .map(c => ({ feature: c.feature, info: c.info }));
}

async function fetchPlainRoute(start, end) {   // [lng, lat] each
  const r = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coordinates: [start, end] }),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error?.message || ''; } catch (_) {}
    throw new Error(`Route service ${r.status} ${detail}`.trim());
  }
  const fc = await r.json();
  if (!fc.features?.length) throw new Error('No route found');
  return fc.features[0];
}