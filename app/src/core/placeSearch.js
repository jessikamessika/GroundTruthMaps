// Place suggestions from OpenRouteService, through our ors-proxy Worker.
// The ORS free plan allows 1,000 lookups a day, so RouteSearch debounces and
// this module caches. Never log or store the query, a label or a coordinate.
import * as turf from '@turf/turf';
import { CITY, IS_CALGARY, ORS_PROXY_URL } from './config.js';

export const MIN_CHARS = 3;
const MAX_CHARS = 100;          // the Worker refuses anything longer
const SAME_AS_CITY_M = 30;
const SAME_LABEL_M = 150;       // one intersection can come back as several nodes
const MAX_ROWS = 6;
const LABEL_TAILS = {
  calgary: /, Calgary, AB, Canada$/i,
  sf: /, San Francisco, CA, USA$/i,
};
const UNAVAILABLE = { status: 'unavailable' };

const cache = new Map();        // "city|query" -> rows, for the session; only successes

const metresApart = (a, b) => turf.distance(a, b, { units: 'meters' });

// Whether a query is worth an ORS lookup, given what the City index returned for it.
export function shouldSearchPlaces(text, cityResult) {
  const query = text.trim();
  if (query.length < MIN_CHARS || query.length > MAX_CHARS) return false;
  if (!IS_CALGARY || !/^\d/.test(query)) return true;
  if (cityResult.status === 'off') return true;
  if (cityResult.status === 'idle') return !/^\d+[a-z]?$/i.test(query);   // "17th Ave", not a bare house number
  return cityResult.status === 'ok' && !cityResult.rows.length;
}

// Worker results as addressSearch-shaped rows, without SF ferry routes ("A => B")
// or a second row for the same name in the same place.
function toRows(results) {
  const rows = [];
  results.forEach(({ label, lng, lat }, i) => {
    if (CITY.key === 'sf' && label.includes('=>')) return;
    const row = { id: `ors|${i}|${label}`, label: label.replace(LABEL_TAILS[CITY.key], ''), point: [lng, lat], source: 'ors' };
    if (!rows.some(kept => kept.label === row.label && metresApart(kept.point, row.point) <= SAME_LABEL_M)) rows.push(row);
  });
  return rows;
}

// Resolves to { status: 'ok', rows } or { status: 'unavailable' }. An aborted
// request also resolves as unavailable; the caller checks its signal first.
export async function searchPlaces(text, signal) {
  const query = text.trim();
  const key = `${CITY.key}|${query.toLowerCase()}`;
  if (cache.has(key)) return { status: 'ok', rows: cache.get(key) };
  try {
    const params = new URLSearchParams({ text: query, city: CITY.key });
    const r = await fetch(`${ORS_PROXY_URL}/geocode?${params}`, { signal });
    if (!r.ok) return UNAVAILABLE;
    const rows = toRows((await r.json()).results);
    cache.set(key, rows);
    return { status: 'ok', rows };
  } catch {
    return UNAVAILABLE;
  }
}

// City rows first, then ORS rows that aren't the same place as a City row.
export function mergeRows(cityRows, placeRows) {
  const distinct = placeRows.filter(place => !cityRows.some(row => metresApart(row.point, place.point) <= SAME_AS_CITY_M));
  return [...cityRows, ...distinct].slice(0, MAX_ROWS);
}

// Under 1 km in 100 m steps, otherwise to 0.1 km.
function distanceText(metres) {
  const steps = Math.round(metres / 100);
  return steps < 10 ? `${Math.max(steps, 1) * 100} m` : `${(steps / 10).toFixed(1)} km`;
}

// Gives rows that would otherwise read the same a hint: "2.3 km from start".
// origin is { point, name }.
export function addDistanceHints(rows, origin) {
  if (!origin) return rows;
  const family = row => row.baseLabel ?? row.label;
  const counts = new Map();
  rows.forEach(row => counts.set(family(row), (counts.get(family(row)) || 0) + 1));
  return rows.map(row => (counts.get(family(row)) > 1
    ? { ...row, hint: `${distanceText(metresApart(origin.point, row.point))} from ${origin.name}` }
    : row));
}
