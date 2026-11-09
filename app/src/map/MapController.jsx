// Imperative MapLibre side of the app: map, layers, popups and route planning.
// React owns everything around the map and talks to this class through
// `getCallbacks()` (always the latest handlers) and a few public methods.
import * as maplibregl from 'maplibre-gl';   // v6 is ESM with named exports only
// v6 derives its worker URL from its own import.meta.url at runtime, which a
// bundler can't see. Import the (self-contained) worker as an asset instead.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
maplibregl.setWorkerUrl(maplibreWorkerUrl);
import * as turf from '@turf/turf';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

import {
  BOOTH, CITY, CLOSURES_URL, NETWORK_URL, ORS_ATTRIBUTION, OSM_ATTRIBUTION, PITCH, VENUE,
} from '../core/config.js';
import {
  closureInfo, fetchPlainRoute, planSafeRoutes, refreshTemporal, routeCrossesClosures,
  safeRouteMessage, temporalStatus,
} from '../core/routing.js';
import { constrRouteHits, constrRouteNote, fetchConstruction, constrFmtFetched } from '../core/construction.js';
import { bowNoteText, phBowTrigger } from '../core/bowNote.js';
import { phIsOn, phTrack } from '../core/analytics.js';
import { ClosurePopup, ConstructionPopup } from './Popups.jsx';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

const CLOSURE_LAYERS = ['closures-current', 'closures-future', 'closures-detour',
                        'closures-reduced-current', 'closures-reduced-future'];
const BUILDING_LAYER = 'building-3d';

// 3D barrier walls over full closures
const WALL_SOURCE = 'closure-walls';
const WALL_LAYER = 'closure-walls-3d';
const WALL_BUFFER_M = 6;           // narrower than the routing buffer (15) so it reads as a wall, not a slab
const WALL_HEIGHT_CURRENT = 100;   // metres
const WALL_HEIGHT_FUTURE = 10;

const CONSTR_SOURCE = 'construction';
const CONSTR_LAYER = 'constr-points';

// Legend checkbox -> map layers it controls (network is handled separately).
const LAYER_GROUPS = {
  current: ['closures-current'],
  future: ['closures-future'],
  detour: ['closures-detour'],
  reduced: ['closures-reduced-current', 'closures-reduced-future'],
  construction: [CONSTR_LAYER],
};

const HIT = 10;   // fat-finger tolerance (px) around a tap on thin closure lines

// Where routing works. Keep in step with BBOXES in api/workers/ors-proxy/src/index.js.
const SERVICE_BOXES = [
  { minLng: -114.5,  maxLng: -113.7,  minLat: 50.8,  maxLat: 51.3  },  // Calgary
  { minLng: -122.55, maxLng: -122.35, minLat: 37.70, maxLat: 37.84 },  // San Francisco
];
const inServiceArea = ([lng, lat]) => SERVICE_BOXES.some(b =>
  lng >= b.minLng && lng <= b.maxLng && lat >= b.minLat && lat <= b.maxLat);

const emptyFC = () => ({ type: 'FeatureCollection', features: [] });

const TAP_PROMPT = { start: 'Search or tap your start point', end: 'Search or tap your destination' };
const FINDING_LOCATION = BOOTH ? 'Is your route closed? Finding your location…' : 'Finding your location…';
const MAX_LOCATION_ACCURACY_M = 100;  // a reported accuracy worse than this is not used
const SAME_PLACE_M = 20;              // endpoints this close aren't routed

const metresBetween = (a, b) =>
  Math.hypot((a[0] - b[0]) * Math.cos(a[1] * Math.PI / 180), a[1] - b[1]) * 111320;

const endSentence = text => (/[.:!?]$/.test(text) ? text : `${text}.`);

function checkWhich(which) {
  if (which !== 'start' && which !== 'end') throw new TypeError("which must be 'start' or 'end'");
}

// Distance in screen pixels from point p to segment a-b
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Full closures only (status 'closed'), current or future. PAST, detour and reduced are skipped.
function buildWallData(closures) {
  const out = [];
  for (const f of closures.features) {
    try {                                     // one bad geometry must not drop every wall
      const p = f.properties || {};
      const info = closureInfo(p);
      if (info.kind !== 'closed') continue;
      const t = temporalStatus(p);
      if (t === 'PAST') continue;
      const poly = turf.buffer(f, WALL_BUFFER_M / 1000, { units: 'kilometers' });
      if (!poly || !poly.geometry) continue;
      const future = t === 'FUTURE';
      out.push({
        type: 'Feature',
        geometry: poly.geometry,
        properties: {
          ...p,                       // status, detour_note, start/end dates, window fields: what the popup reads
          name: info.name,
          future,
          lapsed: !future && info.pastEndDate,
          h: future ? WALL_HEIGHT_FUTURE : WALL_HEIGHT_CURRENT,
        },
      });
    } catch (e) { console.warn('wall skipped', e); }
  }
  return { type: 'FeatureCollection', features: out };
}

export class MapController {
  constructor({ container, attribEl, getCallbacks, layers }) {
    this.cb = getCallbacks;
    this.layers = layers;
    this.planMode = false;
    this.ends = { start: null, end: null };       // [lng, lat] or null
    this.endMarkers = { start: null, end: null }; // maplibregl.Marker or null
    this.routeSeq = 0;   // bumped on every endpoint change/reset; stale route replies are dropped
    this.routeDrawn = false;   // a route line for the current endpoints is on the map
    this.locating = { start: null, end: null };   // the location lookup in progress for each end, or null
    this.routeBanner = '';   // the last message about the current pair of endpoints
    this.tapTarget = 'end';   // the end a map tap fills
    this.locatedEnd = null;   // the end being set from the device location, while it's set
    this.knownLocation = null;   // latest usable device location this session; in memory only
    this.closuresData = null;
    this.generatedAt = null;
    this.constrData = null;
    this.is3D = false;
    this.timers = [];

    const map = this.map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: BOOTH ? VENUE.center : CITY.center,
      zoom: BOOTH ? VENUE.zoom : CITY.zoom,
      maxPitch: 80,
      attributionControl: false,   // mounted in the legend's credits popover instead
    });

    // Map credits behind the "i" button. MapLibre's own control still builds the
    // text (and keeps it current as sources are added); it's just mounted in the
    // React popover instead of the map corner.
    try {
      this.attrib = new maplibregl.AttributionControl({
        compact: false,
        customAttribution: [OSM_ATTRIBUTION, ORS_ATTRIBUTION, CITY.attribution].join(' · '),
      });
      attribEl.appendChild(this.attrib.onAdd(map));
      ['mousedown', 'touchstart', 'wheel'].forEach(ev =>
        map.on(ev, () => this.cb().onMapTouched?.()));
    } catch (e) {
      console.error('[attribution] init failed', e);
    }

    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right');
    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserLocation: true,
    });
    geolocate.on('geolocate', ({ coords }) => {
      const here = [coords.longitude, coords.latitude];
      if (inServiceArea(here) && coords.accuracy <= MAX_LOCATION_ACCURACY_M) this.knownLocation = here;
    });
    map.addControl(geolocate, 'top-right');
    map.addControl(this._toggle3DControl(), 'top-right');

    map.on('load', () => this._onLoad());
    if (CITY.construction) map.on('load', () => this._loadConstruction());
  }

  destroy() {
    this.routeSeq++;   // a route reply arriving after this must not touch the removed map
    this.locating = { start: null, end: null };   // nor a location result
    this.timers.forEach(clearInterval);
    try { this.attrib?.onRemove(); } catch (e) {}
    this.map.remove();
  }

  // ----- Public API used by React -----

  // layers: { network, unconfirmed, current, future, detour, reduced, construction }
  setLayers(layers) {
    this.layers = layers;
    this._applyLayers();
  }

  setPlanMode(on) {
    this.planMode = on;
    if (this.routingReady) this._resetRoute();
    if (on) this._locateStart();
  }

  // ----- Route endpoints (programmatic; taps go through these too) -----
  // which: 'start' | 'end'; lngLat: [lng, lat]. Work in or out of plan mode,
  // once routing is ready (returns false before that).

  setEndpoint(which, lngLat) {
    checkWhich(which);
    if (!Array.isArray(lngLat) || lngLat.length !== 2 || !lngLat.every(Number.isFinite))
      throw new TypeError('lngLat must be [lng, lat]');
    if (!this.routingReady) return false;
    this._endpointsChanging();
    this._placeEndpoint(which, lngLat);
    this._endpointsChanged();
    return true;
  }

  clearEndpoint(which) {
    checkWhich(which);
    if (!this.routingReady) return false;
    if (!this.ends[which]) return true;   // nothing to clear; a location lookup for it keeps running
    this._endpointsChanging();
    this._placeEndpoint(which, null);
    this._endpointsChanged();
    return true;
  }

  swapEndpoints() {
    if (!this.routingReady) return false;
    const { start, end } = this.ends;
    this._endpointsChanging();
    this._placeEndpoint('start', end);
    this._placeEndpoint('end', start);
    this._endpointsChanged();
    return true;
  }

  getEndpoints() {
    const copy = p => (p ? [p[0], p[1]] : null);
    return { start: copy(this.ends.start), end: copy(this.ends.end) };
  }

  // Which end a map tap fills.
  setTapTarget(which) {
    checkWhich(which);
    this.tapTarget = which;
  }

  isLocating() {
    return !!(this.locating.start || this.locating.end);
  }

  // Set one end from the device location, in route mode. Replaces a point
  // already there. Always asks the browser afresh, so it can succeed after an
  // earlier attempt failed. The banner reports progress and failures. Resolves
  // to 'success' | 'denied' | 'timeout' | 'out_of_area' | 'low_accuracy' |
  // 'error', or 'cancelled' if this end changed (or route mode ended) while waiting.
  locateEndpoint(which) {
    checkWhich(which);
    if (!this.routingReady || !this.planMode) {
      console.warn('[locate] failed:', 'not-in-route-mode');
      this.cb().onBanner?.('Turn on route mode to use your location.');
      return Promise.resolve('error');
    }
    return this._locate(which, { explainOutOfArea: true, trigger: 'manual' });
  }

  // What a search suggestion's distance is measured from while `which` is being
  // edited: { point, name }. Never asks the browser for a location.
  distanceOrigin(which) {
    checkWhich(which);
    const other = which === 'start' ? 'end' : 'start';
    if (this.ends[other]) return { point: this.ends[other], name: other === 'start' ? 'start' : 'destination' };
    if (this.knownLocation) return { point: this.knownLocation, name: 'your location' };
    const { lng, lat } = this.map.getCenter();
    return { point: [lng, lat], name: 'map centre' };
  }

  fitBounds(bounds, options) {
    this.map.fitBounds(bounds, options);
  }

  // ----- Layer visibility -----

  _setVis(ids, on) {   // ignores layers that haven't loaded yet
    ids.forEach(id => {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    });
  }

  _applyLayers() {
    const l = this.layers;
    for (const [key, ids] of Object.entries(LAYER_GROUPS)) this._setVis(ids, l[key]);
    this._setVis(['network-confirmed'], l.network);
    this._setVis(['network-unconfirmed'], l.network && l.unconfirmed);
  }

  // ----- 3D / satellite -----

  _toggle3DControl() {
    const ctrl = this;
    return {
      onAdd() {
        this.el = document.createElement('div');
        this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
        const mk = (label, fn) => {
          const b = document.createElement('button');
          b.type = 'button'; b.textContent = label; b.onclick = fn;
          this.el.appendChild(b);
        };
        mk('3D', () => ctrl._set3D(!ctrl.is3D));
        let sat = false;
        mk('Sat', () => {
          sat = !sat;
          ctrl.map.setLayoutProperty('satellite', 'visibility', sat ? 'visible' : 'none');
        });
        return this.el;
      },
      onRemove() { this.el.remove(); },
    };
  }

  _set3D(on) {
    const map = this.map;
    try {
      map.setTerrain(on ? { source: 'dem', exaggeration: 1.5 } : null);
      map.once('idle', () => map.easeTo({ pitch: on ? 65 : 0, duration: 800 }));
      this.is3D = on;
    } catch (e) { console.error('3D toggle failed', e); }

    // Buildings and walls: separate try/catch so one failure can't undo the terrain toggle
    for (const id of [BUILDING_LAYER, WALL_LAYER]) {
      try {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      } catch (e) { console.error(`${id} toggle failed`, e); }
    }
  }

  _init3D() {
    const map = this.map;
    try {
      map.addSource('dem', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15,
        attribution: 'Terrain: Mapzen / AWS Terrain Tiles',
      });
      map.addSource('satellite', {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      });
      map.addLayer({ id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } });
    } catch (e) { console.error('3D init failed', e); }

    // Buildings: hidden until 3D mode, and moved above the satellite layer
    try {
      if (map.getLayer(BUILDING_LAYER)) {
        map.moveLayer(BUILDING_LAYER);   // no beforeId = top of the stack so far
        map.setLayoutProperty(BUILDING_LAYER, 'visibility', 'none');
      } else {
        console.warn('building-3d layer not found; skipping 3D buildings');
      }
    } catch (e) { console.error('3D buildings init failed', e); }
  }

  _initWalls() {
    try {
      this.map.addSource(WALL_SOURCE, { type: 'geojson', data: buildWallData(this.closuresData) });
      this.map.addLayer({
        id: WALL_LAYER, type: 'fill-extrusion', source: WALL_SOURCE,
        layout: { visibility: this.is3D ? 'visible' : 'none' },
        paint: {
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.55,
          'fill-extrusion-color': ['case',
            ['get', 'lapsed'], '#f59e0b',      // past listed end date: amber
            ['get', 'future'], '#f4a4b4',      // upcoming: muted pink
            '#e11d48'],                        // closed now: red
        },
      });
    } catch (e) { console.error('Closure walls init failed', e); }
  }

  _updateWalls() {
    try {
      const src = this.map.getSource(WALL_SOURCE);
      if (src && this.closuresData) src.setData(buildWallData(this.closuresData));
    } catch (e) { console.error('Wall update failed', e); }
  }

  // ----- Popups (React components rendered into the MapLibre popup) -----

  _showPopup(lngLat, element) {
    const node = document.createElement('div');
    const root = createRoot(node);
    flushSync(() => root.render(element));   // content must exist before MapLibre measures it
    const popup = new maplibregl.Popup({ maxWidth: '240px' })
      .setLngLat(lngLat)
      .setDOMContent(node)
      .addTo(this.map);
    popup.on('close', () => setTimeout(() => root.unmount()));
  }

  // ----- Hit testing -----

  _closuresNear(point) {
    // Only query the wall layer if it exists; querying a missing layer makes the whole call fail
    const layers = this.map.getLayer(WALL_LAYER) ? [...CLOSURE_LAYERS, WALL_LAYER] : CLOSURE_LAYERS;
    return this.map.queryRenderedFeatures(
      [[point.x - HIT, point.y - HIT], [point.x + HIT, point.y + HIT]],
      { layers });
  }

  // Of the features in the hit box, return the one whose line is nearest the tap
  _nearestFeature(point, feats) {
    let best = feats[0], bestD = Infinity;
    for (const f of feats) {
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates]
                  : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const line of lines) {
        for (let i = 0; i < line.length - 1; i++) {
          const d = segDist(point, this.map.project(line[i]), this.map.project(line[i + 1]));
          if (d < bestD) { bestD = d; best = f; }
        }
      }
    }
    return best;
  }

  // True if a construction dot is under the pointer. Same exact-point test as the
  // layer click handler, so the pointer only shows where a click opens a popup.
  _constrUnder(point) {
    try {
      return !!this.map.getLayer(CONSTR_LAYER) &&
        this.map.queryRenderedFeatures(point, { layers: [CONSTR_LAYER] }).length > 0;
    } catch (e) { return false; }
  }

  // ----- Load sequence -----

  async _onLoad() {
    const map = this.map;
    const cb = () => this.cb();
    this._init3D();   // DEM + satellite source/layer first

    // 1. Closures first: small, and the point of the app
    try {
      const r = await fetch(CLOSURES_URL);
      if (!r.ok) throw new Error('closures HTTP ' + r.status);
      const closures = await r.json();
      refreshTemporal(closures);   // live CURRENT/FUTURE/PAST from the UTC window
      this.closuresData = closures;
      this.generatedAt = closures.generated;
      map.addSource('closures', { type: 'geojson', data: closures });
      cb().onClosuresLoaded?.({
        generated: closures.generated,
        scopeNote: closures.scope_note || '',
        hasReduced: closures.features.some(f => f.properties.status === 'reduced'),
      });
    } catch (err) {
      console.error(err);
      cb().onError?.('Could not load closure data. Check your connection and reload.');
      return;
    }

    map.addLayer({ id: 'closures-current', type: 'line', source: 'closures',
      filter: ['all', ['==', ['get', 'status'], 'closed'], ['==', ['get', 'calgary_temporal_status'], 'CURRENT']],
      paint: { 'line-color': '#e11d48', 'line-width': 4 } });
    map.addLayer({ id: 'closures-future', type: 'line', source: 'closures',
      filter: ['all', ['==', ['get', 'status'], 'closed'], ['==', ['get', 'calgary_temporal_status'], 'FUTURE']],
      paint: { 'line-color': '#e11d48', 'line-width': 4, 'line-opacity': 0.4, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'closures-detour', type: 'line', source: 'closures',
      filter: ['==', ['get', 'status'], 'detour'],
      paint: { 'line-color': '#7c3aed', 'line-width': 3, 'line-dasharray': [2, 1] } });
    // Lane restrictions: amber, drawn under the red full closures
    map.addLayer({ id: 'closures-reduced-current', type: 'line', source: 'closures',
      filter: ['all', ['==', ['get', 'status'], 'reduced'], ['==', ['get', 'calgary_temporal_status'], 'CURRENT']],
      paint: { 'line-color': '#f59e0b', 'line-width': 3 } }, 'closures-current');
    map.addLayer({ id: 'closures-reduced-future', type: 'line', source: 'closures',
      filter: ['all', ['==', ['get', 'status'], 'reduced'], ['==', ['get', 'calgary_temporal_status'], 'FUTURE']],
      paint: { 'line-color': '#f59e0b', 'line-width': 3, 'line-opacity': 0.5, 'line-dasharray': [2, 2] } }, 'closures-current');
    this._applyLayers();   // honor checkboxes toggled while loading

    // Re-evaluate current/upcoming against the clock every minute
    this.timers.push(setInterval(() => {
      if (refreshTemporal(this.closuresData)) {
        map.getSource('closures').setData(this.closuresData);
        this._updateWalls();
      }
    }, 60000));

    this._initWalls();

    map.on('click', (e) => {
      if (this.planMode) return;
      const hits = this._closuresNear(e.point);
      if (!hits.length) return;
      // A wall under the tap wins, so tapping a wall doesn't open the detour behind it.
      // Walls are polygons, so nearestFeature (which measures line segments) only applies to line hits.
      const wallHit = hits.find(f => f.layer && f.layer.id === WALL_LAYER);
      const pick = wallHit || this._nearestFeature(e.point, hits);
      this._showPopup(e.lngLat, <ClosurePopup props={pick.properties} />);
    });

    // Pointer cursor on desktop (no-op on touch)
    map.on('mousemove', (e) => {
      map.getCanvas().style.cursor =
        (this._closuresNear(e.point).length || this._constrUnder(e.point)) ? 'pointer' : '';
    });

    // 2. Network in the background, inserted beneath the closure layers
    if (CITY.network) {
      cb().onLoading?.(true);
      try {
        const r = await fetch(NETWORK_URL);
        if (!r.ok) throw new Error('network HTTP ' + r.status);
        const network = await r.json();
        map.addSource('network', { type: 'geojson', data: network });
        map.addLayer({ id: 'network-confirmed', type: 'line', source: 'network',
          filter: ['==', ['get', 'bicycle_access'], 'designated'],
          paint: { 'line-color': '#7a8ca5', 'line-width': 1.5, 'line-opacity': 0.7 } }, 'closures-current');
        map.addLayer({ id: 'network-unconfirmed', type: 'line', source: 'network',
          filter: ['!=', ['get', 'bicycle_access'], 'designated'],
          paint: { 'line-color': '#7a8ca5', 'line-width': 1, 'line-opacity': 0.2 } }, 'closures-current');
        this._applyLayers();   // honor checkboxes toggled while loading
      } catch (err) {
        console.error(err);
        cb().onError?.('Closures loaded, but the cycling network could not be loaded.');
      } finally {
        cb().onLoading?.(false);
      }
    }

    this._initRouting();
  }

  // ----- Route planning -----

  _initRouting() {
    const map = this.map;
    map.addSource('route', { type: 'geojson', data: emptyFC() });
    map.addSource('route-hits', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route',
      paint: { 'line-color': '#1a73e8', 'line-width': 5.7, 'line-opacity': 1 } });
    map.addLayer({ id: 'route-hits', type: 'line', source: 'route-hits',
      filter: ['!', ['get', 'possible']],
      paint: { 'line-color': ['case', ['get', 'lapsed'], '#f29900', '#d93025'],
               'line-width': 9, 'line-opacity': 0.9 } });
    // Lane restrictions: dashed amber, so they read as "maybe", not "blocked"
    map.addLayer({ id: 'route-hits-possible', type: 'line', source: 'route-hits',
      filter: ['get', 'possible'],
      paint: { 'line-color': '#f59e0b', 'line-width': 9, 'line-opacity': 0.9,
               'line-dasharray': [1.5, 1.5] } });

    this.routingReady = true;
    if (BOOTH) {   // land in route planning with the pitch still showing
      this.planMode = true;
      this.cb().onBanner?.(`${PITCH} ${TAP_PROMPT.start}`);
      this._locateStart();
    }
    this.cb().onRoutingReady?.({ planMode: this.planMode });

    map.on('click', (e) => this._onRouteClick(e));
  }

  _resetRoute() {
    this.routeSeq++;
    this.routeDrawn = false;
    this._placeEndpoint('start', null);
    this._placeEndpoint('end', null);
    this._clearDrawnRoute();
    this.cb().onBanner?.(this.planMode ? TAP_PROMPT.start : '');
    this.cb().onRouteCleared?.();
    this._emitEndpoints();
  }

  // Fill an empty route start from the device location.
  _locateStart() {
    if (!this.ends.start) this._locate('start');
  }

  // Run one location lookup for an end and resolve to its outcome (see
  // locateEndpoint). Any change to this end, a reset, or a newer lookup for it
  // replaces this.locating[which], so a late result is dropped and can't
  // overwrite the newer state or banner. A change to the other end leaves the
  // lookup running. Warnings carry the error code only, never coordinates.
  _locate(which, { explainOutOfArea = false, trigger = 'auto' } = {}) {
    const banner = text => this.cb().onBanner?.(text);
    const tap = TAP_PROMPT[which];
    const other = which === 'start' ? 'end' : 'start';
    const UNAVAILABLE = "Couldn't find your location.";
    const lookup = {};

    return new Promise((resolve) => {
      const finish = (outcome) => {
        if (this.locating[which] === lookup) this.locating[which] = null;
        phTrack('geolocate_used', { end: which, trigger, outcome });   // a cancelled lookup never gets here
        resolve(outcome);
      };
      // If this end already has a point it stays, so keep what's still true
      // on screen instead of asking for a tap.
      const failed = (outcome, code, reason, emptyText = `${reason} ${tap}.`) => {
        console.warn('[locate] failed:', code);
        const after = this.ends[other] ? this.routeBanner : `${TAP_PROMPT[other]}.`;
        banner(this.ends[which] ? `${reason} ${after}` : emptyText);
        finish(outcome);
      };
      if (!window.isSecureContext) return failed('error', 'insecure-context', UNAVAILABLE);
      if (!navigator.geolocation) return failed('error', 'no-geolocation', UNAVAILABLE);

      const stillWanted = () => this.planMode && this.locating[which] === lookup;
      this.locating[which] = lookup;

      banner(FINDING_LOCATION);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (!stillWanted()) return resolve('cancelled');
          const here = [pos.coords.longitude, pos.coords.latitude];
          if (!inServiceArea(here)) {
            return failed('out_of_area', 'outside-service-area', "You're outside the map area.",
              explainOutOfArea ? undefined : tap);
          }
          if (pos.coords.accuracy > MAX_LOCATION_ACCURACY_M) {
            return failed('low_accuracy', 'low-accuracy', "Your location isn't precise enough.");
          }
          this.knownLocation = here;
          this.locatedEnd = which;
          if (this.setEndpoint(which, here)) phTrack('endpoint_edited', { end: which, action: 'set', source: 'location' });
          this.locatedEnd = null;
          finish('success');
        },
        (err) => {
          if (!stillWanted()) return resolve('cancelled');
          const outcome = err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'error';
          if (err.code !== 1) return failed(outcome, err.code, UNAVAILABLE);
          failed(outcome, err.code, 'Location is off.', BOOTH ? `Find out if your route is closed! ${tap}` : undefined);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
      );
    });
  }

  // Set (or with null, remove) one endpoint and its marker, and cancel any
  // location lookup for that end. Touches nothing else.
  _placeEndpoint(which, lngLat) {
    this.locating[which] = null;
    const old = this.endMarkers[which];
    if (old) old.remove();
    this.endMarkers[which] = null;
    this.ends[which] = lngLat ? [lngLat[0], lngLat[1]] : null;
    if (lngLat) {
      this.endMarkers[which] = new maplibregl.Marker({ color: which === 'start' ? '#188038' : '#d93025' })
        .setLngLat(this.ends[which]).addTo(this.map);
    }
  }

  _clearDrawnRoute() {
    this.map.getSource('route').setData(emptyFC());
    this.map.getSource('route-hits').setData(emptyFC());
  }

  // Before an endpoint change: invalidate any in-flight request; if a route was
  // drawn it no longer matches, so take it (and the sign-up offer) down.
  _endpointsChanging() {
    this.routeSeq++;
    this.routeBanner = '';
    if (this.routeDrawn) {
      this.routeDrawn = false;
      this._clearDrawnRoute();
      this.cb().onRouteCleared?.();
    }
  }

  // After an endpoint change: report it, then plan or prompt for the missing point.
  _endpointsChanged() {
    this._emitEndpoints();
    const { start, end } = this.ends;
    if (start && end) {
      if (metresBetween(start, end) > SAME_PLACE_M) return this._planCurrentRoute();
      this.routeBanner = 'Your start and destination are too close together. Please check your points.';
      this.cb().onBanner?.(this.routeBanner);
      return;
    }
    const missing = start ? 'end' : 'start';
    this.cb().onBanner?.(!this.planMode ? '' : this.locating[missing] ? FINDING_LOCATION : TAP_PROMPT[missing]);
  }

  _emitEndpoints() {
    this.cb().onEndpointsChanged?.({ ...this.getEndpoints(), locatedEnd: this.locatedEnd });
  }

  _onRouteClick(e) {
    if (!this.planMode) return;
    if (this.setEndpoint(this.tapTarget, [e.lngLat.lng, e.lngLat.lat])) {
      phTrack('endpoint_edited', { end: this.tapTarget, action: 'set', source: 'tap' });
    }
  }

  async _planCurrentRoute() {
    const map = this.map;
    const banner = text => { this.routeBanner = text; this.cb().onBanner?.(text); };
    const pts = [this.ends.start, this.ends.end];
    const seq = this.routeSeq;

    banner('Routing…');
    const closuresData = this.closuresData;
    try {
      let route, result = null;
      if (closuresData) {
        result = await planSafeRoutes(pts[0], pts[1], closuresData);
        route = result.route;
      } else {
        route = await fetchPlainRoute(pts[0], pts[1]);
      }
      if (seq !== this.routeSeq) return;   // endpoints changed or route reset while waiting
      map.getSource('route').setData(route);
      this.routeDrawn = true;

      if (!closuresData) {                      // fail closed
        const constrHitsNoClosures = constrRouteHits(route, this.constrData);
        banner('Route shown, but closure data is unavailable. Can\'t check for closures.' +
          constrRouteNote(constrHitsNoClosures));
        this._phRouteShown('unverified', null, constrHitsNoClosures, null);
        return;
      }

      const hits = routeCrossesClosures(route, closuresData);
      const constrHits = constrRouteHits(route, this.constrData);   // alert only; null = construction not checked

      map.getSource('route-hits').setData({
        type: 'FeatureCollection',
        features: hits.map(h => ({
          ...h.feature,
          properties: { ...h.feature.properties, lapsed: h.info.pastEndDate, possible: h.info.kind === 'reduced' },
        })),
      });

      // one closure can span several features, so group by name
      const closedByName = new Map(), possibleNames = new Set();
      for (const h of hits) {
        if (h.info.kind === 'closed') {
          closedByName.set(h.info.name, (closedByName.get(h.info.name) || false) || h.info.pastEndDate);
        } else {
          possibleNames.add(h.info.name);
        }
      }
      for (const n of closedByName.keys()) possibleNames.delete(n);   // already warned as a closure
      const parts = [...closedByName].map(([name, lapsed]) =>
        lapsed ? `${name} ⚑ past listed end date, may be cleared` : name);
      const maybe = [...possibleNames];

      const stale = (Date.now() - new Date(this.generatedAt)) > 6 * 3600e3;
      const km = (route.properties.summary.distance / 1000).toFixed(1);
      const maybeText = `${maybe.length} lane restriction${maybe.length > 1 ? 's' : ''} ` +
        `(${maybe.join('; ')}) — the street may still be passable`;

      let text;
      if (parts.length) {
        text = `⚠ ${km} km route crosses ${parts.length} closure${parts.length > 1 ? 's' : ''}: ${parts.join('; ')}` +
          (maybe.length ? `. It also passes ${maybeText}` : '');
      } else if (maybe.length) {
        text = `Heads up: your ${km} km route may be affected by ${maybeText}.`;
      } else if (constrHits && constrHits.length) {
        text = `Your ${km} km route:`;   // construction note appended below
      } else {
        text = `No known closures on this ${km} km route` + (stale ? ' (closure data may be stale)' : '');
      }
      const prefix = safeRouteMessage(result);
      if (prefix) text = prefix + ' ' + text;
      const constrNote = constrRouteNote(constrHits);
      if (constrNote) text = endSentence(text) + constrNote;
      const bowNote = bowNoteText(result, hits, closuresData);   // '' unless it applies
      if (bowNote) text = endSentence(text) + bowNote;
      banner(text);

      this._phRouteShown(result.status, closedByName.size, constrHits,
        bowNote ? () => phBowTrigger(result, hits, closuresData) : null);
      this.cb().onRouteShown?.(pts[0], pts[1]);   // email ask only once the result is on screen
    } catch (err) {
      console.error('Routing error:', err);
      if (seq !== this.routeSeq) return;   // a newer request owns the banner now
      banner(`Couldn't get a route (${err.message}). Try again.`);
      try { phTrack('route_failed', {}); } catch (e) {}   // no error text is sent
    }
  }

  // route_planned (+ construction_alert_shown, bow_river_notice_shown) once the
  // banner is on screen. Counts and enums only. Never throws, so it can't stop
  // the sign-up offer that follows it.
  _phRouteShown(status, closuresHit, constrHits, bowTrigger) {
    try {
      if (!phIsOn()) return;   // analytics off: skip the extra Bow River geometry work
      const p = { status };
      if (Number.isInteger(closuresHit)) p.closures_hit = closuresHit;
      phTrack('route_planned', p);
      if (CITY.construction && constrHits && constrHits.length)
        phTrack('construction_alert_shown', { sites_count: Math.min(5, constrHits.length) });
      const trigger = bowTrigger && bowTrigger();
      if (trigger) phTrack('bow_river_notice_shown', { trigger });
    } catch (e) {}
  }

  // ----- Construction detours (display only) -----

  async _loadConstruction() {
    const status = (msg, bad) => this.cb().onConstrStatus?.(msg, bad);
    let data;
    try {
      data = await fetchConstruction();
    } catch (err) {
      console.error('[construction] load failed:', err);
      status('Construction data unavailable', true);
      return;
    }

    const map = this.map;
    try {
      this.constrData = data;
      map.addSource(CONSTR_SOURCE, { type: 'geojson', data });
      map.addLayer({ id: CONSTR_LAYER, type: 'circle', source: CONSTR_SOURCE,
        paint: {
          'circle-color': '#0d9488',
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 13, 5, 16, 8, 18, 11],
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        } });
      this._applyLayers();   // honor the checkbox if it was toggled while loading

      map.on('click', CONSTR_LAYER, (e) => {
        try {
          if (this.planMode || !e.features || !e.features.length) return;
          this._showPopup(e.features[0].geometry.coordinates,
            <ConstructionPopup props={e.features[0].properties} fetchedAt={data.fetched_at} />);
        } catch (err) { console.error('[construction] popup failed', err); }
      });

      // Pointer cursor on desktop. When closures load, their mousemove handler sets
      // the cursor (and checks construction); this covers the closures-failed case.
      map.on('mousemove', (e) => {
        if (this.closuresData) return;
        map.getCanvas().style.cursor = this._constrUnder(e.point) ? 'pointer' : '';
      });

      const fetched = constrFmtFetched(data.fetched_at);
      const n = data.features.length;
      status(n
        ? `${n} active · fetched ${fetched || 'time unknown'}`
        : 'No active construction closures reported' + (fetched ? ` · fetched ${fetched}` : ''), false);
    } catch (err) {
      console.error('[construction] layer init failed:', err);
      status('Construction data unavailable', true);
    }
  }
}
