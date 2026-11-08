import { useEffect, useRef, useState } from 'react';
import { BOOTH, PITCH, SMALL_SCREEN } from '../core/config.js';
import { MapController } from './MapController.jsx';
import { useSignup } from './useSignup.js';
import UpdatedPill from '../components/UpdatedPill.jsx';
import WelcomeDialog from '../components/WelcomeDialog.jsx';
import LegendPanel from '../components/LegendPanel.jsx';
import SignupSheet from '../components/SignupSheet.jsx';
import RouteSearch from '../components/RouteSearch.jsx';

const INITIAL_LAYERS = {
  network: true, unconfirmed: true, current: true, future: true,
  reduced: true, detour: true, construction: true,
};

const pill = 'rounded-full px-2.5 py-1.5 text-xs leading-[1.2]';
const whiteBtn = 'cursor-pointer rounded-lg bg-white px-3 py-2 text-sm text-ink shadow-btn';

export default function App() {
  const mapEl = useRef(null);
  const attribEl = useRef(null);
  const controller = useRef(null);

  const [layers, setLayers] = useState(INITIAL_LAYERS);
  const [hasReduced, setHasReduced] = useState(true);   // hidden once loaded data has none (e.g. Calgary)
  const [collapsed, setCollapsed] = useState(SMALL_SCREEN.matches);   // collapsed on phones so the map shows
  const [attribOpen, setAttribOpen] = useState(true);   // shown on load; any touch on the map closes it
  const [generated, setGenerated] = useState(null);
  const [scopeNote, setScopeNote] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [constr, setConstr] = useState({ msg: 'Loading…', bad: false });
  const [banner, setBanner] = useState(BOOTH ? PITCH : '');
  const [routingReady, setRoutingReady] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [endpoints, setEndpoints] = useState({ start: null, end: null });

  const signup = useSignup(controller);

  // The controller is created once; it reads handlers through this ref so they
  // are never stale.
  const callbacks = useRef(null);
  callbacks.current = {
    onMapTouched: () => setAttribOpen(false),
    onLoading: setLoading,
    onError: setError,
    onClosuresLoaded: ({ generated, scopeNote, hasReduced }) => {
      setGenerated(generated);
      setScopeNote(scopeNote);
      setHasReduced(hasReduced);
    },
    onConstrStatus: (msg, bad) => setConstr({ msg, bad: !!bad }),
    onRoutingReady: ({ planMode }) => { setRoutingReady(true); setPlanMode(planMode); },
    onBanner: setBanner,
    onRouteShown: signup.offer,
    onRouteCleared: signup.clearRoute,
    onEndpointsChanged: setEndpoints,
  };

  useEffect(() => {
    const c = new MapController({
      container: mapEl.current,
      attribEl: attribEl.current,
      getCallbacks: () => callbacks.current,
      layers: INITIAL_LAYERS,
    });
    controller.current = c;
    if (import.meta.env.DEV) window.__gtm = c;   // dev server only: console testing
    return () => {
      if (import.meta.env.DEV && window.__gtm === c) delete window.__gtm;
      controller.current = null;
      c.destroy();
    };
  }, []);

  useEffect(() => { controller.current?.setLayers(layers); }, [layers]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') setAttribOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const togglePlan = () => {
    if (!routingReady) return;   // routing is set up once closures have loaded
    const next = !planMode;
    setPlanMode(next);
    controller.current.setPlanMode(next);
  };

  return (
    <>
      {/* Positioned wrapper: MapLibre's unlayered `.maplibregl-map { position: relative }`
          would override Tailwind utilities placed on the map element itself. */}
      <div className="absolute inset-0">
        <div ref={mapEl} className="h-full w-full" />
      </div>

      <UpdatedPill generated={generated} />

      {scopeNote && (
        <div role="note" className="absolute right-2 bottom-[calc(24px+env(safe-area-inset-bottom))] left-2 z-2 rounded-[10px] bg-white/96 px-2.5 py-1.5 text-xs leading-[1.3] text-ink shadow-pill">
          {scopeNote}
        </div>
      )}

      {error && (
        <div role="alert" className="absolute top-[calc(44px+env(safe-area-inset-top))] right-2 left-2 z-3 rounded-lg border border-danger-line bg-danger-bg px-3 py-2.5 text-sm leading-[1.4] text-danger-ink">
          {error}
        </div>
      )}

      {/* Left column below the top row; stops short of the map controls on the right.
          The map stays tappable between the items. */}
      <div className="pointer-events-none fixed top-[calc(env(safe-area-inset-top,0px)+52px)] right-[49px] left-2 z-5 flex flex-col items-start gap-1.5 *:pointer-events-auto *:max-w-full">
        {/* Hidden, not removed, under the sign-up sheet: the sheet's route fit assumes a clear top. */}
        {planMode && <RouteSearch controller={controller} endpoints={endpoints} hidden={signup.sheet.open} />}
        {loading && <div className={`${pill} bg-white/96 text-ink shadow-pill`}>Loading cycling network…</div>}
        {constr.bad && (
          <div role="status" className={`${pill} border border-danger-line bg-danger-bg text-danger-ink`}>{constr.msg}</div>
        )}
        {banner && (
          <div className="rounded-2xl bg-white px-3 py-1.5 text-sm whitespace-normal text-ink shadow-btn">{banner}</div>
        )}
        {signup.pill && (
          <button type="button" disabled={signup.pill.disabled} onClick={signup.pillClick}
                  className={`${whiteBtn} disabled:cursor-default disabled:text-neutral-600`}>
            {signup.pill.text}
          </button>
        )}
        {signup.showBetaButton && (
          <button type="button" onClick={signup.betaOpen} className={whiteBtn}>⚙️ Sign up for the beta</button>
        )}
      </div>

      <WelcomeDialog />

      <LegendPanel
        layers={layers}
        setLayer={(k, v) => setLayers(l => ({ ...l, [k]: v }))}
        hasReduced={hasReduced}
        constr={constr}
        collapsed={collapsed} setCollapsed={setCollapsed}
        attribOpen={attribOpen} setAttribOpen={setAttribOpen} attribRef={attribEl}
        signup={signup}
      />

      {/* Top row, left of the map controls (10px margin + 29px control + 2px ring + 8px gap) */}
      <button type="button" onClick={togglePlan}
              className="fixed top-[calc(env(safe-area-inset-top,0px)+10px)] right-[49px] z-5 cursor-pointer rounded-lg bg-link px-3 py-2 text-sm text-white">
        {planMode ? 'Exit route mode' : 'Plan route'}
      </button>

      <SignupSheet signup={signup} />
    </>
  );
}
