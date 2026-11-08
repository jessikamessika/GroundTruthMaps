// Closure-alert sign-up: storage, validation and the Apps Script call.
// Sign-ups go to an Apps Script web app (api/apps-script/signup.gs) that appends a
// row to the "App sign-ups" tab of the closure-alerts sheet. Any failure,
// including an unset URL, falls back to a pre-filled link to the Google Form.
import { CITY, SIGNUP_URL, SRC } from './config.js';

export const FORM_VIEW = 'https://docs.google.com/forms/d/e/1FAIpQLSfuigbPPrxlahZllvMG2QisBJ9FC0eUNDpogHytI4XwgHCV1Q/viewform';
const FORM_ENTRY = { email: 'entry.1045781291', mode: 'entry.134698288', src: 'entry.1872653624' };
export const ROUTE_LIMIT = 4;              // saved routes per sign-up
// trialStart / trial_start is the sign-up ("joined at") date; the name matches the sheet column.
const SIGNUP_KEY = 'gtmSignup';            // { email, mode, trialStart, routes: [key], consentVersion }
// `mode` holds how often the person bikes (optional, '' if skipped). Labels
// are the button text and the Google Form's option text for the fallback link.
export const BIKE_FREQ = { daily: 'Most days', weekly: 'A few times a week',
                           monthly: 'A few times a month', rare: 'Rarely or never' };
export const bikeFreq = v => Object.prototype.hasOwnProperty.call(BIKE_FREQ, v) ? v : '';   // old walk/bike/drive/transit -> ''
export const CONSENT_VERSION = '2026-11-booth-v3';  // bump whenever the consent checkbox wording changes

export function signupLoad() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SIGNUP_KEY)) || null; } catch (e) { return null; }
  if (s && typeof s === 'object') s.mode = bikeFreq(s.mode);   // sign-ups saved before the bike question
  return s;
}
export function signupStore(s) {
  try {
    if (s) localStorage.setItem(SIGNUP_KEY, JSON.stringify(s));
    else localStorage.removeItem(SIGNUP_KEY);
  } catch (e) {}
}

// Pragmatic email check for every email field; api/apps-script/signup.gs applies the same rule.
// One @, something before it, a dot inside the domain, no spaces or <>()[],;:"\.
// Takes the trimmed value.
export function emailLooksValid(email) {
  try {
    if (typeof email !== 'string' || email.length > 254 || /[\s<>()[\],;:"\\]/.test(email)) return false;
    const at = email.indexOf('@');
    if (at < 1 || at !== email.lastIndexOf('@')) return false;
    const domain = email.slice(at + 1);
    return domain.indexOf('.') > 0 && !domain.endsWith('.');
  } catch (e) { return false; }
}

const fmtPt = p => `${p[1].toFixed(5)},${p[0].toFixed(5)}`;   // lat,lng: pastes into any map
export const routeId = r => `${fmtPt(r.start)} to ${fmtPt(r.end)}`;
export const isoDay = d => d.toLocaleDateString('en-CA', { timeZone: CITY.timezone });

// Posts one JSON body to the Apps Script web app.
// text/plain keeps this a "simple" request: Apps Script can't answer a CORS preflight.
export async function postToSheet(body) {
  if (!SIGNUP_URL) throw new Error('SIGNUP_URL not set');
  const r = await fetch(SIGNUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const res = await r.json();   // a script error comes back as an HTML page: json() throws
  if (!res.ok) throw new Error(res.error || 'rejected');
}

// `id` is a routeId() string or null; kind is 'signup' | 'add-route' | 'remove-route'.
// `consent` is { version }: the consent wording the person ticked at sign-up.
export async function signupSend(email, mode, trialStart, id, kind, consent) {
  const [routeStart, routeEnd] = id ? id.split(' to ') : ['', ''];
  await postToSheet({
    email, mode, src: SRC, trial_start: trialStart, kind,
    route_start: routeStart, route_end: routeEnd,
    consent_text_version: (consent && consent.version) || '',
  });
}

// Pre-filled Google Form link shown when saving fails.
export function signupFallbackUrl(email, mode) {
  const prefill = { [FORM_ENTRY.src]: SRC };
  if (emailLooksValid(email)) prefill[FORM_ENTRY.email] = email;   // never carry a bad email into the form
  if (bikeFreq(mode)) prefill[FORM_ENTRY.mode] = BIKE_FREQ[mode];   // form options are the button labels
  return FORM_VIEW + '?usp=pp_url&' + new URLSearchParams(prefill);
}
