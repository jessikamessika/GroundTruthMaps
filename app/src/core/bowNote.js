// Bow River known-issue notice (banner text only).
// Avoidance can pick a longer reroute than needed near these posted detours.
// Matched on closureInfo().name, trimmed and case-insensitive.
import * as turf from '@turf/turf';
import { IS_CALGARY } from './config.js';
import { closureInfo, routeCrossesClosures, temporalStatus } from './routing.js';

const BOWNOTE_NAMES = new Set([
  'BOW RIVER PATHWAY & DOUGLAS FIR TRAIL',
  'BOW RIVER PATHWAY - SHAGANAPPI PUMP STATION PH. 3',
  'BOW RIVER PATHWAY - MONTGOMERY VW NW',
  'PARKDALE BV NW - 30 ST TO 31 ST NW',
].map(n => n.trim().toLowerCase()));
const BOWNOTE_NEAR_M = 20;   // displayed route this close to a listed closure/detour counts
const BOWNOTE_TEXT = 'Known issue: routes on Bow River pathways near posted detours may show a ' +
  'longer reroute than needed. Visually check the map and closure popups.';

const bowNoteListed = p => BOWNOTE_NAMES.has(closureInfo(p).name.trim().toLowerCase());

// (a) the plain ORS route hits a listed closure
function plainRouteHitsListed(result, hits, closures) {
  const plain = result.plain && result.plain[0];
  const plainHits = !plain ? [] : plain === result.route ? hits : routeCrossesClosures(plain, closures);
  return plainHits.some(h => bowNoteListed(h.feature.properties || {}));
}

// (b) the displayed route passes within BOWNOTE_NEAR_M of an active listed
// closure (the closure itself, not its posted detour)
function routeNearListed(result, closures) {
  for (const f of closures.features) {
    const p = f.properties || {};
    const t = temporalStatus(p);
    if (p.status === 'detour' || t === 'FUTURE' || t === 'PAST' || !bowNoteListed(p)) continue;
    const near = turf.buffer(f, BOWNOTE_NEAR_M / 1000, { units: 'kilometers' });
    if (near && turf.booleanIntersects(result.route, near)) return true;
  }
  return false;
}

// Text appended to the route banner, or '' when it doesn't apply. Never throws.
export function bowNoteText(result, hits, closures) {
  try {
    if (!IS_CALGARY || !result || !closures) return '';
    if (plainRouteHitsListed(result, hits, closures)) return ' ' + BOWNOTE_TEXT;
    if (routeNearListed(result, closures)) return ' ' + BOWNOTE_TEXT;
    return '';
  } catch (err) {
    console.error('[bow-note] check failed:', err);
    return '';
  }
}

// Usage statistics: only called after bowNoteText() returned the notice.
// Re-checks both conditions (bowNoteText stops at the first) to say which fired.
export function phBowTrigger(result, hits, closures) {
  try {
    const a = plainRouteHitsListed(result, hits, closures);
    const b = routeNearListed(result, closures);
    return a && b ? 'both' : a ? 'plain_route' : b ? 'near_final' : null;
  } catch (e) { return null; }
}
