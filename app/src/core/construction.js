// Construction detours (display only).
// City "Construction Detours" (w8zq-79bq) via the construction-proxy Worker, which
// already filters to closures active now. Points only, free-text description.
// Never fed into closure data or routing.
import { CITY, CONSTR_URL, IS_CALGARY } from './config.js';
import { distToFeatureM } from './routing.js';

export const CONSTR_NOTE =
  'Closure type not specified by the City (single-lane, full road, sidewalks etc.). Check before riding.';

// Fail closed: anything other than a valid FeatureCollection with a
// `features` array is "unavailable", never "no construction".
export async function fetchConstruction() {
  const r = await fetch(CONSTR_URL);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  if (!data || !Array.isArray(data.features)) throw new Error('response has no features array');
  return data;
}

// `start`/`end` are Calgary wall-clock strings with no timezone. Format the
// digits as given rather than letting Date shift them to the viewer's zone.
export function constrFmtLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s || '');
  if (!m) return s || 'unknown';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)));
  return d.toLocaleString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short',
    day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function constrFmtFetched(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return null;
  return d.toLocaleString('en-US', { timeZone: CITY.timezone,
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Route alerts (no avoidance). Points have no street extent, so a route counts
// as passing a site when it comes within this distance of the point. A route
// along the street passes ~1 m away; parallel streets are 100 m+.
const CONSTR_ROUTE_NEAR_M = 30;

// Construction points near the route, one per `info`. Returns null when the
// check can't be done (data unavailable or an error), so callers fail closed.
export function constrRouteHits(route, constrData) {
  if (!constrData) return null;
  try {
    const seen = new Map();
    for (const f of constrData.features) {
      if (!f || !f.geometry || f.geometry.type !== 'Point') continue;
      const name = (f.properties && f.properties.info) || 'Construction';
      if (!seen.has(name) && distToFeatureM(f, route) <= CONSTR_ROUTE_NEAR_M) seen.set(name, f);
    }
    return [...seen.values()];
  } catch (err) {
    console.error('[construction] route check failed:', err);
    return null;
  }
}

// Text appended to the route banner. Never claims a route is clear of construction.
export function constrRouteNote(hits) {
  if (!IS_CALGARY) return '';   // no construction dataset for this city
  if (hits === null) return ' Construction data unavailable, so construction sites weren\'t checked.';
  if (!hits.length) return '';
  const names = hits.map(f => (f.properties && f.properties.info) || 'Construction').join('; ');
  return ` ⚠ Passes ${hits.length} construction site${hits.length > 1 ? 's' : ''}: ${names}. ` + CONSTR_NOTE;
}
