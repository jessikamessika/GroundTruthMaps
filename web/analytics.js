// web/analytics.js: anonymous usage statistics (PostHog, US cloud).
//
// Analytics must never break the app: every entry point is wrapped in try/catch,
// and nothing loads unless ALL of these hold:
//   - PH_KEY is set
//   - the browser sends no Do Not Track / Global Privacy Control signal
//   - the visitor hasn't turned usage statistics off on privacy.html (gtm_ph_optout)
//   - localStorage can be read and written (otherwise the opt-out couldn't be honoured)
//
// Only the 11 events in PH_EVENTS (plus scrubbed $exception) are ever sent, with
// enum / capped-int / boolean properties only. The same allowlist runs twice:
// in phTrack() and in PostHog's before_send hook (phBeforeSend), which also sees
// every SDK-generated event and drops anything not listed.
//
// SDK: vendor/posthog-js-1.438.21.full.no-external.js, the unmodified
// dist/array.full.no-external.js from posthog-js@1.438.21 on npm (MIT). The
// "full, no-external" build has exception capture built in and never fetches
// other scripts.
//
// Browser storage used (all gtm_ prefixed; privacy.html deletes them on opt-out):
//   localStorage   gtm_ph_optout      '1' when usage statistics are turned off
//   localStorage   gtm_ph_id          random ID, sent as the distinct ID
//   localStorage   gtm_ph_first_seen  YYYY-MM-DD (UTC) of the first visit
//   localStorage   gtm_ph_last_seen   YYYY-MM-DD (UTC) of the latest visit
//   sessionStorage gtm_ph_session     {open, exc}: app_open sent this tab? exceptions sent?

// Paste the PUBLIC project key (starts with phc_) from PostHog > Settings >
// Project > General > Project API key. Empty = analytics off, nothing loads.
const PH_KEY = '';
const PH_HOST = 'https://us.i.posthog.com';
const PH_SDK_SRC = 'vendor/posthog-js-1.438.21.full.no-external.js';

const PH_LS_OPTOUT = 'gtm_ph_optout';
const PH_LS_ID = 'gtm_ph_id';
const PH_LS_FIRST = 'gtm_ph_first_seen';
const PH_LS_LAST = 'gtm_ph_last_seen';
const PH_SS_SESSION = 'gtm_ph_session';

const PH_MAX_EXCEPTIONS = 5;       // per browser tab
const PH_MAX_FRAMES = 10;          // stack frames kept per exception
const PH_MAX_QUEUE = 50;           // events held while the SDK loads

// ----- Allowlist -----
// Property spec: an array = enum of allowed strings; 'bool' = boolean;
// {min, max} = integer, clamped into the range.
const PH_SRC_VALUES = ['booth-qr', 'booth-nfc', 'booth-form', 'none'];
const PH_CITY_VALUES = ['calgary', 'sf'];
const PH_EVENTS = {
  app_open: { device: ['phone', 'desktop'], city: PH_CITY_VALUES, returning: 'bool',
              days_since_first: { min: 0, max: 3650 } },
  route_planned: { status: ['clear', 'avoided', 'lapsed-only', 'blocked', 'unverified'],
                   closures_hit: { min: 0, max: 50 }, city: PH_CITY_VALUES },
  route_failed: { city: PH_CITY_VALUES },
  signup_sheet_shown: { trigger: ['auto', 'bell', 'beta_button', 'change_email'] },
  signup_submitted: { bike_freq: ['daily', 'weekly', 'monthly', 'rare', 'none'] },
  signup_failed: { reason: ['invalid_email', 'network', 'server'] },
  route_added: { routes_saved: { min: 0, max: 10 } },
  route_removed: { routes_saved: { min: 0, max: 10 } },
  report_link_clicked: { report_type: ['still_closed', 'open_now', 'wrong_dates'] },
  construction_alert_shown: { sites_count: { min: 0, max: 5 } },
  bow_river_notice_shown: { trigger: ['plain_route', 'near_final', 'both'] },
};
// Every custom event also carries src (PH_SRC_VALUES).

// ----- State -----
let phOn = false;          // passed every check in phInit
let phSdk = null;          // window.posthog once loaded and initialised
let phQueue = [];          // [{event, properties}] captured before the SDK was ready
let phCtx = { city: 'calgary', src: 'none' };
let phId = null;
const phSessionMem = { open: false, exc: 0 };   // fallback when sessionStorage throws (iOS private mode)

// ----- Small helpers (none throw) -----
function phLsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function phLsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function phLsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

function phSessionGet() {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem(PH_SS_SESSION)); } catch (e) {}
  const open = !!((s && s.open === true) || phSessionMem.open);
  const exc = Math.max(s && Number.isInteger(s.exc) ? s.exc : 0, phSessionMem.exc);
  return { open, exc };
}
function phSessionSet(s) {
  phSessionMem.open = !!s.open;
  phSessionMem.exc = s.exc;
  try { sessionStorage.setItem(PH_SS_SESSION, JSON.stringify({ open: !!s.open, exc: s.exc })); } catch (e) {}
}

// Do Not Track or Global Privacy Control: either one means load nothing.
function phPrivacySignal() {
  try {
    const n = navigator || {};
    const dnt = n.doNotTrack || window.doNotTrack || n.msDoNotTrack;
    return dnt === '1' || dnt === 'yes' || n.globalPrivacyControl === true;
  } catch (e) { return false; }
}

// Fails closed: if localStorage can't be read, the opt-out can't be checked, so
// treat the visitor as opted out.
function phOptedOut() {
  try { return localStorage.getItem(PH_LS_OPTOUT) === '1'; } catch (e) { return true; }
}

// Opt-out deletes the identifier and visit dates (privacy.html does the same).
function phForget() {
  phLsDel(PH_LS_ID); phLsDel(PH_LS_FIRST); phLsDel(PH_LS_LAST);
  try { sessionStorage.removeItem(PH_SS_SESSION); } catch (e) {}
}

function phRandomId() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  try {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  } catch (e) {}
  return null;   // no secure randomness: don't invent a weak ID, stay off
}

const phToday = () => new Date().toISOString().slice(0, 10);   // UTC date
function phDaysBetween(a, b) {
  const d = (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5;
  return Number.isFinite(d) ? Math.round(d) : null;
}

// ----- Allowlist enforcement (shared by phTrack and phBeforeSend) -----
function phCleanValue(spec, v) {
  if (Array.isArray(spec)) return typeof v === 'string' && spec.includes(v) ? v : undefined;
  if (spec === 'bool') return typeof v === 'boolean' ? v : undefined;
  if (spec && typeof spec === 'object') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    return Math.min(spec.max, Math.max(spec.min, Math.trunc(v)));
  }
  return undefined;
}

// Custom event properties: only listed keys with valid values, plus src.
function phCleanCustom(event, props) {
  const schema = PH_EVENTS[event];
  if (!schema) return null;
  const p = props || {};
  const out = {};
  for (const k of Object.keys(schema)) {
    const v = phCleanValue(schema[k], p[k]);
    if (v !== undefined) out[k] = v;
  }
  out.src = PH_SRC_VALUES.includes(p.src) ? p.src : 'none';
  return out;
}

// File basename only: no origin, path, query or hash.
function phBasename(u) {
  try {
    let s = String(u == null ? '' : u).split('#')[0].split('?')[0];
    s = s.slice(s.lastIndexOf('/') + 1);
    if (!s) return '(page)';   // the page itself, e.g. .../web/
    return /^[A-Za-z0-9._-]{1,80}$/.test(s) ? s : '?';
  } catch (e) { return '?'; }
}
function phFuncName(f) {
  const s = typeof f === 'string' ? f : '';
  return /^[A-Za-z0-9_$.<>[\] -]{1,80}$/.test(s) ? s : '?';
}
function phErrType(t) {
  return typeof t === 'string' && /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/.test(t) ? t : 'Error';
}
function phInt(v) { return Number.isInteger(v) && v >= 0 && v < 1e7 ? v : undefined; }

// $exception: keep only the type and, per frame, basename / line / column /
// function (last PH_MAX_FRAMES frames, nearest the throw). Message, values,
// URLs, mechanism, steps and every other property are dropped. `platform` and
// `stacktrace.type` are fixed constants PostHog needs to read the frames.
function phCleanException(props) {
  const list = props && Array.isArray(props.$exception_list) ? props.$exception_list : [];
  const out = list.slice(0, 3).map(ex => {
    const frames = ex && ex.stacktrace && Array.isArray(ex.stacktrace.frames) ? ex.stacktrace.frames : [];
    return {
      type: phErrType(ex && ex.type),
      stacktrace: {
        type: 'raw',
        frames: frames.slice(-PH_MAX_FRAMES).map(f => {
          const o = { platform: 'web:javascript', filename: phBasename(f && f.filename),
                      function: phFuncName(f && f.function) };
          const l = phInt(f && f.lineno), c = phInt(f && f.colno);
          if (l !== undefined) o.lineno = l;
          if (c !== undefined) o.colno = c;
          return o;
        }),
      },
    };
  });
  return out.length ? { $exception_list: out } : null;
}

// Allowlisted properties for an event name, or null to drop the event.
function phClean(event, props) {
  if (event === '$exception') return phCleanException(props);
  return phCleanCustom(event, props);
}

// Second filter: PostHog's before_send. Sees every event the SDK would send,
// including SDK-generated ones ($pageview, $autocapture, $snapshot, $$heatmap,
// $web_vitals ...), which are all dropped. Rebuilds the event from scratch so
// no SDK default property ($current_url, $os, $device_id, $session_id, $set ...)
// gets through. Throwing here makes the SDK drop the event (fails closed).
function phBeforeSend(ev) {
  if (!phOn || !ev || typeof ev.event !== 'string' || phOptedOut()) return null;
  const props = ev.properties || {};
  const clean = phClean(ev.event, props);
  if (!clean || typeof props.token !== 'string' || !phId) return null;
  if (ev.event === '$exception') {
    const s = phSessionGet();
    if (s.exc >= PH_MAX_EXCEPTIONS) return null;
    phSessionSet({ open: s.open, exc: s.exc + 1 });
  }
  const out = {
    event: ev.event,
    properties: Object.assign(clean, {
      token: props.token,                // required by PostHog ingestion
      distinct_id: phId,                 // our gtm_ph_id, never the SDK's own
      $process_person_profile: false,    // no person profiles
    }),
  };
  if (typeof ev.uuid === 'string') out.uuid = ev.uuid;
  if (ev.timestamp) out.timestamp = ev.timestamp;
  return out;
}

// ----- Public API (all wrapped; safe to call before or without the SDK) -----

// First filter. Unknown event names and properties are dropped here too.
// city and src are filled in from phInit's context when the schema lists them.
function phTrack(event, props) {
  try {
    if (!phOn) return;
    let p = props || {};
    if (event !== '$exception') {
      p = Object.assign({}, p, { src: phCtx.src });
      if (PH_EVENTS[event] && PH_EVENTS[event].city && p.city === undefined) p.city = phCtx.city;
    }
    const clean = phClean(event, p);
    if (!clean) return;
    if (phSdk) phSdk.capture(event, clean);
    else if (phQueue.length < PH_MAX_QUEUE) phQueue.push({ event, properties: clean });
  } catch (e) {}
}

// Maps a signupSend() failure to signup_failed's reason.
function phSignupReason(err) {
  try {
    if (err && err.message === 'bad email') return 'invalid_email';   // apps-script said no
    if (err && err.name === 'TypeError') return 'network';             // fetch() couldn't connect
  } catch (e) {}
  return 'server';   // HTTP error, non-JSON reply, or {ok:false}
}

// Called once from index.html. ctx = { city: 'calgary'|'sf', src: <SRC string> }.
function phInit(ctx) {
  try {
    if (phOn || !PH_KEY) return;
    if (phOptedOut()) { phForget(); return; }
    if (phPrivacySignal()) return;

    phCtx = {
      city: PH_CITY_VALUES.includes(ctx && ctx.city) ? ctx.city : 'calgary',
      src: PH_SRC_VALUES.includes(ctx && ctx.src) && ctx.src !== 'none' ? ctx.src : 'none',
    };

    // Identity: our own random ID; first/last-seen dates for "returning".
    phId = phLsGet(PH_LS_ID);
    if (!phId || !/^[A-Za-z0-9-]{16,64}$/.test(phId)) {
      phId = phRandomId();
      // Storage must be writable, or the opt-out couldn't be saved either: stay off.
      if (!phId || !phLsSet(PH_LS_ID, phId)) { phId = null; return; }
    }
    const today = phToday();
    const first = phLsGet(PH_LS_FIRST);
    const validFirst = /^\d{4}-\d{2}-\d{2}$/.test(first || '') ? first : null;
    if (!validFirst) phLsSet(PH_LS_FIRST, today);
    if (!phLsSet(PH_LS_LAST, today)) { phId = null; return; }   // storage blocked: stay off

    phOn = true;

    // app_open: once per browser tab.
    const s = phSessionGet();
    if (!s.open) {
      phSessionSet({ open: true, exc: s.exc });
      let phone = false;
      try { phone = window.matchMedia('(max-width: 600px)').matches; } catch (e) {}
      phTrack('app_open', {
        device: phone ? 'phone' : 'desktop',
        returning: !!validFirst,
        days_since_first: validFirst ? Math.max(0, phDaysBetween(validFirst, today) || 0) : 0,
      });
    }

    phLoadSdk();
  } catch (e) {
    phOn = false;
  }
}

function phLoadSdk() {
  try {
    const el = document.createElement('script');
    el.src = PH_SDK_SRC;
    el.async = true;
    el.onload = phStartSdk;
    el.onerror = () => { phOn = false; phQueue = []; };
    document.head.appendChild(el);
  } catch (e) { phOn = false; phQueue = []; }
}

function phStartSdk() {
  try {
    const ph = window.posthog;
    if (!phOn || !ph || typeof ph.init !== 'function' || phOptedOut()) { phOn = false; phQueue = []; return; }
    ph.init(PH_KEY, {
      api_host: PH_HOST,
      bootstrap: { distinctID: phId },
      persistence: 'memory',                 // no cookies, no SDK localStorage
      person_profiles: 'never',
      // No remote config or /flags: project settings can't switch anything on here.
      advanced_disable_flags: true,
      advanced_disable_feature_flags: true,
      advanced_disable_toolbar_metrics: true,
      disable_external_dependency_loading: true,
      // Off: autocapture, pageviews, replay, surveys, heatmaps, rage/dead clicks, etc.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      rageclick: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_performance: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_surveys_automatic_display: true,
      disable_conversations: true,
      disable_product_tours: true,
      disable_web_experiments: true,
      save_referrer: false,
      save_campaign_params: false,
      mask_personal_data_properties: true,
      disableDeviceModel: true,
      respect_dnt: true,
      // On: uncaught errors and unhandled promise rejections only (not console.error).
      capture_exceptions: { capture_unhandled_errors: true, capture_unhandled_rejections: true,
                            capture_console_errors: false },
      error_tracking: { exception_steps: { enabled: false } },
      before_send: phBeforeSend,
      loaded: (inst) => {
        try {
          phSdk = inst;
          const q = phQueue; phQueue = [];
          q.forEach(e => inst.capture(e.event, e.properties));
        } catch (e) {}
      },
    });
  } catch (e) { phOn = false; phQueue = []; }
}
