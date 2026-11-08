// Closure-alert sign-up state: the bottom sheet, the 🔔 pill, the beta button
// and "Your closure alerts" in the legend. Offered after a route result
// renders; skipping never locks anything.
import { useCallback, useEffect, useRef, useState } from 'react';
import { SMALL_SCREEN } from '../core/config.js';
import { phSignupReason, phTrack } from '../core/analytics.js';
import {
  CONSENT_VERSION, ROUTE_LIMIT, bikeFreq, emailLooksValid, isoDay, routeId,
  signupLoad, signupSend, signupStore,
} from '../core/signup.js';

const SIGNUP_DELAY_MS = 3000;   // let the route result sink in before asking
const DONE_HIDE_MS = 5000;

const track = (event, props) => { try { phTrack(event, props); } catch (e) {} };
const EMPTY_FORM = { email: '', mode: '', consent: false };

export function useSignup(controllerRef) {
  const [stored, setStored] = useState(signupLoad);
  const [route, setRouteState] = useState(null);       // { start, end } of the route on screen
  const [sheet, setSheetState] = useState({ open: false, view: 'form', done: null });
  const [form, setForm] = useState(EMPTY_FORM);
  const [emailError, setEmailError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pillBusy, setPillBusy] = useState(false);
  const [alertsMsg, setAlertsMsg] = useState('');
  const [removing, setRemoving] = useState(() => new Set());
  const [openTick, setOpenTick] = useState(0);         // bumps on every open(), for focus/fit
  const [emailErrTick, setEmailErrTick] = useState(0); // bumps on every shown email error

  // Timers read the latest values through refs, never stale closures.
  const routeRef = useRef(null);
  const sheetRef = useRef(sheet);
  const skippedRef = useRef(false);   // "Not now" this visit: don't pop the sheet again, keep the pill
  const offerTimer = useRef(null);
  const hideTimer = useRef(null);
  const sheetEl = useRef(null);
  const formEl = useRef(null);
  const emailEl = useRef(null);
  const emailErrEl = useRef(null);

  const setRoute = r => { routeRef.current = r; setRouteState(r); };
  const setSheet = s => { sheetRef.current = s; setSheetState(s); };

  const save = s => { signupStore(s); setStored(s ? { ...s, routes: [...s.routes] } : null); };

  const showEmailError = useCallback(() => {
    setEmailError(true);
    setEmailErrTick(t => t + 1);
  }, []);

  // Fit the route's endpoints into the part of the map the sheet (and the
  // on-screen keyboard, via visualViewport) leaves visible. Camera only.
  const fitRoute = useCallback(() => {
    try {
      const r = routeRef.current;
      const s = sheetRef.current;
      if (!r || !s.open || s.view !== 'form' || !sheetEl.current || !controllerRef.current) return;
      const vv = window.visualViewport;
      const visTop = vv ? vv.offsetTop : 0;
      const visBottom = Math.min(vv ? vv.offsetTop + vv.height : innerHeight,
                                 sheetEl.current.getBoundingClientRect().top);
      const top = visTop + 60;                      // clears the top row of buttons
      const bottom = innerHeight - visBottom + 20;
      if (innerHeight - top - bottom < 80) return;  // no useful room left
      const { start, end } = r;
      controllerRef.current.fitBounds(
        [[Math.min(start[0], end[0]), Math.min(start[1], end[1])],
         [Math.max(start[0], end[0]), Math.max(start[1], end[1])]],
        { padding: { top, bottom, left: 30, right: 60 }, maxZoom: 16, duration: 300 });
    } catch (e) { console.error('[signup] fit failed', e); }
  }, [controllerRef]);

  const open = useCallback(() => {
    setSheet({ open: true, view: 'form', done: null });
    setEmailError(false);
    setOpenTick(t => t + 1);
  }, []);

  const close = useCallback(() => {
    setSheet({ ...sheetRef.current, open: false });
    clearTimeout(hideTimer.current);
  }, []);

  const showDone = (done, autoHide) => {
    setSheet({ open: true, view: 'done', done });
    clearTimeout(hideTimer.current);
    if (autoHide) hideTimer.current = setTimeout(close, DONE_HIDE_MS);
  };

  const skip = () => { skippedRef.current = true; close(); };

  // After open(): on phones, don't pop the keyboard unasked; move the route
  // above the form instead. Elsewhere, focus the email field.
  useEffect(() => {
    if (!openTick) return;
    if (formEl.current) formEl.current.scrollTop = 0;
    if (SMALL_SCREEN.matches) requestAnimationFrame(fitRoute);
    else emailEl.current?.focus({ preventScroll: true });
  }, [openTick, fitRoute]);

  // Inline "That email doesn't look right" under the field. The browser's own
  // validity bubble isn't shown reliably on phones, so it's never relied on.
  useEffect(() => {
    if (!emailErrTick) return;
    try {
      emailErrEl.current?.scrollIntoView({ block: 'nearest' });
      if (SMALL_SCREEN.matches) requestAnimationFrame(fitRoute);   // the sheet grew
    } catch (e) { console.error('[signup] email error display failed', e); }
  }, [emailErrTick, fitRoute]);

  // Keyboard opened or closed on a phone: re-fit the route.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let t = null;
    const onResize = () => {
      if (!SMALL_SCREEN.matches) return;
      clearTimeout(t);
      t = setTimeout(fitRoute, 150);
    };
    vv.addEventListener('resize', onResize);
    return () => { vv.removeEventListener('resize', onResize); clearTimeout(t); };
  }, [fitRoute]);

  useEffect(() => () => { clearTimeout(offerTimer.current); clearTimeout(hideTimer.current); }, []);

  // ----- Called by the map -----

  const offer = useCallback((start, end) => {
    const r = { start, end };
    setRoute(r);
    clearTimeout(offerTimer.current);
    if (signupLoad() || skippedRef.current || sheetRef.current.open) return;
    offerTimer.current = setTimeout(() => {
      // Only if the same route is still on screen and nothing changed meanwhile.
      if (routeRef.current === r && !sheetRef.current.open && !skippedRef.current && !signupLoad()) {
        open();
        track('signup_sheet_shown', { trigger: 'auto' });
      }
    }, SIGNUP_DELAY_MS);
  }, [open]);

  const clearRoute = useCallback(() => {
    clearTimeout(offerTimer.current);
    setRoute(null);
  }, []);

  // ----- Sheet form -----

  const submit = async (e) => {
    e.preventDefault();
    const email = form.email.trim();
    if (!emailLooksValid(email)) {   // keeps the text, sheet stays open
      showEmailError();
      track('signup_failed', { reason: 'invalid_email' });
      return;
    }
    if (!form.consent) return;   // submit is disabled until the box is ticked
    const mode = bikeFreq(form.mode);   // optional
    const trialStart = isoDay(new Date());
    const r = routeRef.current;
    const consent = { version: CONSENT_VERSION };

    setSubmitting(true);
    try {
      await signupSend(email, mode, trialStart, r && routeId(r), 'signup', consent);
    } catch (err) {
      console.error('[signup] send failed:', err);
      track('signup_failed', { reason: phSignupReason(err) });
      if (err && err.message === 'bad email') showEmailError();   // signup.gs said no
      else showDone({ kind: 'fallback', email, mode }, false);
      return;
    } finally {
      setSubmitting(false);
    }
    // The sheet row is confirmed saved (signup.gs replied ok). Frequency only.
    track('signup_submitted', { bike_freq: mode || 'none' });
    save({ email, mode, trialStart, routes: r ? [routeId(r)] : [], consentVersion: consent.version });
    showDone({ kind: 'thanks', withRoute: !!r }, true);
  };

  // ----- 🔔 pill: attach the route on screen to an existing sign-up -----

  const pillClick = async () => {
    const s = signupLoad();
    if (!s) {
      skippedRef.current = false;
      open();
      track('signup_sheet_shown', { trigger: 'bell' });
      return;
    }
    const r = routeRef.current;
    if (!r || s.routes.length >= ROUTE_LIMIT) return;
    if (!emailLooksValid(s.email)) {   // saved before emails were checked: ask for it again
      open();
      setForm(f => ({ ...f, email: s.email || '' }));
      showEmailError();
      track('signup_sheet_shown', { trigger: 'bell' });
      return;
    }
    setPillBusy(true);
    try {
      // Re-records what was agreed at sign-up; blank for sign-ups saved before CONSENT_VERSION existed.
      await signupSend(s.email, s.mode, s.trialStart, routeId(r), 'add-route', { version: s.consentVersion });
    } catch (err) {
      console.error('[signup] send failed:', err);
      showDone({ kind: 'fallback', email: s.email, mode: s.mode }, false);
      return;
    } finally {
      setPillBusy(false);
    }
    s.routes.push(routeId(r));
    save(s);
    track('route_added', { routes_saved: s.routes.length });   // count only
  };

  // Shown when the sheet is closed and a route is on screen.
  let pill = null;
  if (route && !sheet.open) {
    const id = routeId(route);
    if (!stored) pill = { text: '🔔 Get alerts for this route', disabled: false };
    else if (stored.routes.includes(id)) pill = { text: '🔔 This route is on your alerts ✓', disabled: true };
    else if (stored.routes.length >= ROUTE_LIMIT)
      pill = { text: `🔔 Route alerts full (${stored.routes.length}/${ROUTE_LIMIT})`, disabled: true };
    else pill = { text: `🔔 Add this route to alerts (${stored.routes.length}/${ROUTE_LIMIT})`, disabled: false };
    if (pillBusy) pill.disabled = true;
  }

  // "Sign up for the beta": only with no route, the sheet closed and no sign-up on this device.
  const showBetaButton = !route && !sheet.open && !stored;
  const betaOpen = () => {
    skippedRef.current = false;
    open();
    track('signup_sheet_shown', { trigger: 'beta_button' });
  };

  // ----- Manage alerts (legend panel) -----
  // Removing a route is sent to the sheet so alerts stop. "Use a different email"
  // only forgets this device's sign-up; that email's rows stay in the sheet.

  const removeRoute = async (id) => {
    const s = signupLoad();
    if (!s) return;
    setAlertsMsg('');
    if (!emailLooksValid(s.email)) {   // saved before emails were checked
      setAlertsMsg("That email doesn't look right. Tap “Use a different email” to fix it.");
      return;
    }
    setRemoving(prev => new Set(prev).add(id));
    try {
      await signupSend(s.email, s.mode, s.trialStart, id, 'remove-route');
    } catch (err) {
      console.error('[signup] remove failed:', err);
      setAlertsMsg("Couldn't remove that route right now. Try again.");
      return;
    } finally {
      setRemoving(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
    s.routes = s.routes.filter(x => x !== id);
    save(s);
    track('route_removed', { routes_saved: s.routes.length });   // count only
  };

  const resetEmail = () => {
    if (!confirm('Forget this email on this device? You can sign up again with a different one. ' +
                 'Alerts already set up for it are not cancelled.')) return;
    save(null);
    setAlertsMsg('');
    skippedRef.current = false;
    setForm(EMPTY_FORM);
    if (routeRef.current) {
      open();
      track('signup_sheet_shown', { trigger: 'change_email' });
    }
  };

  return {
    stored, route, sheet, form, setForm, emailError, setEmailError, submitting,
    pill, pillClick, showBetaButton, betaOpen,
    submit, skip, alertsMsg, removing, removeRoute, resetEmail,
    offer, clearRoute,
    refs: { sheetEl, formEl, emailEl, emailErrEl },
  };
}
