// web/routing.js — plain ORS route + closure crossing check
const PROXY_URL = 'https://ors-proxy.jess-jm-zhang.workers.dev';
const CLOSURE_BUFFER_M = 15;
const BLOCKING = new Set(['closed']);   // 'detour' = passable via posted detour
const POSSIBLE = new Set(['reduced']);  // lanes reduced: street may still be passable -> softer warning

// Live CURRENT/FUTURE/PAST from the closure's UTC window and the viewer's clock.
// Closures without window fields (Calgary) keep their baked-in status.
function temporalStatus(p, now = Date.now()) {
  if (p.window_start_utc && p.window_end_utc) {
    const s = Date.parse(p.window_start_utc), e = Date.parse(p.window_end_utc);
    if (!isNaN(s) && !isNaN(e)) return now < s ? 'FUTURE' : now >= e ? 'PAST' : 'CURRENT';
  }
  return p.calgary_temporal_status;
}

// Re-stamps windowed features in place. Returns true if any status changed
// (caller should then map.getSource('closures').setData(closures)).
function refreshTemporal(closures, now = Date.now()) {
  let changed = false;
  for (const f of closures.features) {
    const p = f.properties || {};
    if (!p.window_start_utc) continue;
    const t = temporalStatus(p, now);
    if (p.calgary_temporal_status !== t) {
      p.calgary_temporal_status = t;
      p.temporal_status = t;
      changed = true;
    }
  }
  return changed;
}

function todayLocal() {
  return new Date().toLocaleDateString('en-CA', { timeZone: CITY.timezone });
}

function closureInfo(p) {
  const note = p.detour_note || '';
  const i = note.indexOf(' \u2014 ');
  const t = temporalStatus(p);
  const active = t !== 'FUTURE' && t !== 'PAST';   // conservative: a missing field still warns
  return {
    kind: BLOCKING.has(p.status) ? 'closed' : POSSIBLE.has(p.status) ? 'reduced' : null,
    name: (i > -1 ? note.slice(0, i) : note) || 'Unnamed closure',
    text: i > -1 ? note.slice(i + 3) : '',
    blocking: BLOCKING.has(p.status) && active,   // full closure right now
    possible: POSSIBLE.has(p.status) && active,   // lane restriction right now
    pastEndDate: !!p.end_date && p.end_date < todayLocal(),
  };
}

// Buffer every closed/reduced feature once. Whether it counts is decided per
// call from the live clock, so the cache never goes stale as time passes.
let _cache = { src: null, items: [] };
function bufferedClosures(closures) {
  if (_cache.src === closures) return _cache.items;
  const items = [];
  for (const feature of closures.features) {
    const st = (feature.properties || {}).status;
    if (!BLOCKING.has(st) && !POSSIBLE.has(st)) continue;
    const buf = turf.buffer(feature, CLOSURE_BUFFER_M / 1000, { units: 'kilometers' });
    if (buf) items.push({ buf, feature });
  }
  _cache = { src: closures, items };
  return items;
}

const DETOUR_NEAR_M = 12;    // a detour belongs to a closure if it comes this close
const MIN_HIT_M = 20;        // metres of route genuinely on a closure before it counts
const ON_DETOUR_MAX_M = 8;   // beyond this from a detour line, a point isn't "following the detour"
const SAMPLE_M = 5;

function distToFeatureM(pt, f) {
  let min = Infinity;
  turf.flattenEach(f, part => {
    min = Math.min(min, turf.pointToLineDistance(pt, part, { units: 'meters' }));
  });
  return min;
}

const _detourCand = new WeakMap();   // closure feature -> detour features within DETOUR_NEAR_M
function detoursNear(feature, closures) {
  if (_detourCand.has(feature)) return _detourCand.get(feature);
  const near = turf.buffer(feature, DETOUR_NEAR_M / 1000, { units: 'kilometers', steps: 4 });
  const list = near ? closures.features.filter(d =>
    (d.properties || {}).status === 'detour' && turf.booleanIntersects(d, near)) : [];
  _detourCand.set(feature, list);
  return list;
}

// Metres of the route inside this closure's buffer that are NOT on one of its posted detours.
function metresOnClosure(route, c, closures) {
  const dets = detoursNear(c.feature, closures).filter(d => {
    const t = temporalStatus(d.properties || {});
    return t !== 'PAST' && t !== 'FUTURE';
  });
  const L = turf.length(route, { units: 'kilometers' });
  let m = 0;
  for (let d = 0; d <= L; d += SAMPLE_M / 1000) {
    const p = turf.along(route, d, { units: 'kilometers' });
    if (!turf.booleanPointInPolygon(p, c.buf)) continue;
    const dC = distToFeatureM(p, c.feature);
    let dD = Infinity;
    for (const f of dets) dD = Math.min(dD, distToFeatureM(p, f));
    if (!(dD < dC && dD <= ON_DETOUR_MAX_M)) m += SAMPLE_M;
  }
  return m;
}

// Returns [{feature, info}] for every closure or lane restriction the route
// touches right now. info.kind is 'closed' or 'reduced'.
function routeCrossesClosures(route, closures) {
  const hits = [];
  for (const c of bufferedClosures(closures)) {
    const info = closureInfo(c.feature.properties || {});
    if (!info.blocking && !info.possible) continue;
    if (!turf.booleanIntersects(route, c.buf)) continue;
    const m = metresOnClosure(route, c, closures);
    // a route that actually crosses the closure line always counts, even for a short stretch
    if (m >= MIN_HIT_M || (m > 0 && turf.booleanIntersects(route, c.feature))) hits.push({ feature: c.feature, info });
  }
  return hits;
}

async function fetchRoutes(start, end, avoidPolygons = null) {   // [lng, lat] each
  const payload = { coordinates: [start, end] };
  if (avoidPolygons) payload.avoid_polygons = avoidPolygons;
  const r = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error?.message || ''; } catch (_) {}
    const e = new Error(`Route service ${r.status} ${detail}`.trim());
    e.status = r.status;
    throw e;
  }
  const fc = await r.json();
  if (!fc.features?.length) { const e = new Error('Route service 404 No route found'); e.status = 404; throw e; }
  return fc.features.slice(0, 3);
}
const fetchPlainRoute = async (start, end) => (await fetchRoutes(start, end))[0];

// ---------- Avoidance routing ----------
const AVOID_BUFFER_M = 20;                    // > CLOSURE_BUFFER_M (15)
const AVOID_PAD = { lng: 0.03, lat: 0.02 };   // ~2 km search margin around start/end
const MAX_AVOID_POLYGONS = 40;                // keep equal to the Worker
const MAX_AVOID_VERTICES = 4000;

const blockingHits = (route, closures) =>
  routeCrossesClosures(route, closures).filter(h => h.info.blocking);

function buildAvoidPolygons(closures, start, end, { skipLapsed = false } = {}) {
  const box = turf.bboxPolygon([
    Math.min(start[0], end[0]) - AVOID_PAD.lng, Math.min(start[1], end[1]) - AVOID_PAD.lat,
    Math.max(start[0], end[0]) + AVOID_PAD.lng, Math.max(start[1], end[1]) + AVOID_PAD.lat,
  ]);
  const mid = turf.point([(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]);
  const found = [];
  for (const feature of closures.features) {
    const info = closureInfo(feature.properties || {});
    if (!info.blocking) continue;
    if (skipLapsed && info.pastEndDate) continue;
    if (!turf.booleanIntersects(feature, box)) continue;
    let buf = turf.buffer(feature, AVOID_BUFFER_M / 1000, { units: 'kilometers', steps: 4 });
    if (!buf) continue;
    try { buf = turf.simplify(buf, { tolerance: 0.00003, highQuality: false }); } catch (_) {}
    found.push({ buf, d: turf.distance(turf.center(feature), mid) });
  }
  found.sort((a, b) => a.d - b.d);   // nearest the trip first, so truncation drops the far ones

  const polys = [];
  let vertices = 0, truncated = false;
  for (const { buf } of found) {
    const g = buf.geometry;
    const parts = g.type === 'Polygon' ? [g.coordinates]
      : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const part of parts) {
      const n = part.reduce((s, ring) => s + ring.length, 0);
      if (polys.length >= MAX_AVOID_POLYGONS || vertices + n > MAX_AVOID_VERTICES) { truncated = true; continue; }
      polys.push(part);
      vertices += n;
    }
  }
  return { polygons: polys.length ? { type: 'MultiPolygon', coordinates: polys } : null, truncated };
}

const routeKey = r => `${Math.round(r.properties?.summary?.distance || 0)}:${r.geometry?.coordinates?.length}`;
function uniqueRoutes(list) {
  const seen = new Set();
  return list.filter(r => !seen.has(routeKey(r)) && seen.add(routeKey(r)));
}
const shortestRoute = list =>
  list.slice().sort((a, b) => (a.properties?.summary?.distance ?? Infinity) - (b.properties?.summary?.distance ?? Infinity))[0];

// status: 'clear' | 'avoided' | 'lapsed-only' | 'blocked' | 'unverified'
// Fails closed: on 'blocked' / 'unverified' the route is the plain one and is never described as safe.
async function planSafeRoutes(start, end, closures) {
  const plain = await fetchRoutes(start, end);   // throws -> caller shows its normal error
  if (blockingHits(plain[0], closures).length === 0) return { status: 'clear', route: plain[0], plain };

  const cleanAlternatives = plain.filter(r => blockingHits(r, closures).length === 0);
  const attempts = [{ skipLapsed: false, tolerateLapsed: false }, { skipLapsed: true, tolerateLapsed: true }];
  let lastError = null;
  for (const a of attempts) {
    const { polygons, truncated } = buildAvoidPolygons(closures, start, end, { skipLapsed: a.skipLapsed });
    if (!polygons) continue;
    let avoiding;
    try {
      avoiding = await fetchRoutes(start, end, polygons);
    } catch (e) {
      lastError = e;
      if (e.status === 404) continue;   // no route with this avoid set: try the looser one
      break;                            // Worker/network problem: don't hammer it
    }
    const ok = uniqueRoutes([...cleanAlternatives, ...avoiding]).filter(r =>
      blockingHits(r, closures).every(h => a.tolerateLapsed && h.info.pastEndDate));
    if (ok.length) {
      return { status: a.tolerateLapsed ? 'lapsed-only' : 'avoided', route: shortestRoute(ok), plain, truncated };
    }
  }
  return lastError && lastError.status !== 404
    ? { status: 'unverified', route: plain[0], plain, error: lastError }
    : { status: 'blocked', route: plain[0], plain };
}

function safeRouteMessage(result) {
  const km = r => ((r.properties?.summary?.distance || 0) / 1000).toFixed(1);
  switch (result.status) {
    case 'avoided':
      return `Rerouted around current closures: ${km(result.route)} km vs ${km(result.plain[0])} km direct.`
        + (result.truncated ? ' Some distant closures were not avoided.' : '');
    case 'lapsed-only':
      return 'Avoids active closures. Remaining ⚑ closures are past their listed end date and may already be cleared.';
    case 'blocked':
      return 'No route found that avoids all current closures. Showing the direct route; red sections are closed.';
    case 'unverified':
      return "Couldn't check for a closure-free route. This route may cross closures.";
    default:
      return '';
  }
}
