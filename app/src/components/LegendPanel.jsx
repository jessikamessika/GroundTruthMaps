import { CITY } from '../core/config.js';
import { REPORTS_ON, reportUrl } from '../core/reports.js';
import { ROUTE_LIMIT } from '../core/signup.js';

function Row({ checked, onChange, disabled, swatch, children }) {
  return (
    <label className="flex min-h-10 cursor-pointer items-center gap-2.5">
      <input type="checkbox" checked={checked} disabled={disabled}
             onChange={e => onChange(e.target.checked)} className="m-0 h-5 w-5 flex-none" />
      {swatch}
      {children}
    </label>
  );
}

const Swatch = ({ className = '', style }) =>
  <span className={'h-1 w-[22px] flex-none rounded-sm ' + className} style={style} />;

function AlertsManager({ signup }) {
  const s = signup.stored;
  if (!s) return null;
  return (
    <section aria-labelledby="alerts-title" className="mt-1.5 border-t border-neutral-200 pt-2">
      <h3 id="alerts-title" className="mb-0.5 text-sm font-bold">Your closure alerts</h3>
      <div className="text-[13px] wrap-anywhere text-neutral-600">
        {s.email} · {s.routes.length}/{ROUTE_LIMIT} routes
      </div>
      <ul className="my-1.5">
        {!s.routes.length && (
          <li className="flex min-h-10 items-center border-b border-neutral-100 text-[13px] text-neutral-600">
            No routes yet. Plan a route to add one.
          </li>
        )}
        {s.routes.map(id => (
          <li key={id} className="flex min-h-10 items-center gap-2 border-b border-neutral-100 text-[13px]">
            <span className="flex-1 wrap-anywhere">{id}</span>
            <button type="button" aria-label={`Remove route ${id}`}
                    disabled={signup.removing.has(id)} onClick={() => signup.removeRoute(id)}
                    className="min-h-9 cursor-pointer rounded-lg border border-neutral-300 bg-white px-3 text-[13px] text-ink disabled:cursor-default disabled:opacity-60">
              Remove
            </button>
          </li>
        ))}
      </ul>
      {signup.alertsMsg && (
        <div role="status" className="mb-1.5 text-xs text-danger-ink">{signup.alertsMsg}</div>
      )}
      <button type="button" onClick={signup.resetEmail}
              className="min-h-9 cursor-pointer rounded-lg border border-neutral-300 bg-white px-3 text-[13px] text-ink">
        Use a different email
      </button>
    </section>
  );
}

// Legend + layer toggles (bottom sheet, collapsible). The Feedback button and
// the credits "i" float in a row just above it, so they follow it as it
// expands and collapses.
export default function LegendPanel({
  layers, setLayer, hasReduced, constr, collapsed, setCollapsed,
  attribOpen, setAttribOpen, attribRef, signup,
}) {
  const floating = 'absolute bottom-[calc(100%+8px)] bg-white/96 text-ink shadow-btn';
  return (
    <div className="absolute right-2 bottom-[calc(30px+env(safe-area-inset-bottom))] left-2 z-2 max-w-[420px] rounded-[11px] bg-white/96 text-sm leading-[1.4] text-ink shadow-panel">
      {REPORTS_ON && (
        <a href={reportUrl()} target="_blank" rel="noopener"
           className={`${floating} left-0 flex min-h-9 items-center rounded-full px-3.5 text-sm leading-none font-semibold`}>
          Feedback
        </a>
      )}
      <button type="button" aria-label="Map data credits" aria-expanded={attribOpen}
              aria-controls="attrib-pop" onClick={() => setAttribOpen(!attribOpen)}
              className={`${floating} right-0 h-9 w-9 cursor-pointer rounded-full font-[Georgia,serif] text-[17px] leading-none font-bold italic`}>
        i
      </button>
      {/* Always mounted: MapLibre's attribution control lives inside it. */}
      <div id="attrib-pop" ref={attribRef} role="region" aria-label="Map data credits" hidden={!attribOpen}
           className="attrib-pop absolute right-0 bottom-[calc(100%+52px)] left-0 max-h-[40vh] overflow-y-auto rounded-[11px] bg-white/98 px-3 py-2.5 text-xs leading-[1.45] text-ink shadow-panel" />

      <button aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}
              className="flex min-h-11 w-full cursor-pointer items-center justify-between px-3.5 text-left font-semibold">
        <span>{signup.stored ? 'Legend, layers and alerts' : 'Legend and layers'}</span>
        <span className={'transition-transform duration-150 ' + (collapsed ? 'rotate-180' : '')}>▾</span>
      </button>

      <div hidden={collapsed} className="px-3.5 pb-2">
        {CITY.network && <>
          <Row checked={layers.network} onChange={v => setLayer('network', v)}
               swatch={<Swatch className="bg-network" />}>Cycling network</Row>
          <Row checked={layers.unconfirmed} onChange={v => setLayer('unconfirmed', v)}
               disabled={!layers.network}   // greyed out when the whole network is hidden
               swatch={<Swatch className="bg-network opacity-50" />}>Unconfirmed paths</Row>
        </>}
        <Row checked={layers.current} onChange={v => setLayer('current', v)}
             swatch={<Swatch className="bg-closed" />}>Closed now</Row>
        <Row checked={layers.future} onChange={v => setLayer('future', v)}
             swatch={<Swatch className="bg-closed opacity-35" />}>Closed (upcoming)</Row>
        {hasReduced && (
          <Row checked={layers.reduced} onChange={v => setLayer('reduced', v)}
               swatch={<Swatch className="bg-reduced" />}>Lanes reduced (may be passable)</Row>
        )}
        {CITY.network && (
          <Row checked={layers.detour} onChange={v => setLayer('detour', v)}
               swatch={<Swatch style={{ background: 'radial-gradient(circle at 2px 2px,#7c3aed 1.8px,transparent 2.2px) 0 0/6px 4px repeat-x' }} />}>
            Detour
          </Row>
        )}
        {CITY.construction && (
          <Row checked={layers.construction} onChange={v => setLayer('construction', v)}
               swatch={<span className="mx-[5px] h-3 w-3 flex-none rounded-full bg-construction shadow-[0_0_0_2px_#fff,0_0_0_3px_#0d9488]" />}>
            <span>
              Construction detours (City)
              <span className={'block text-xs ' + (constr.bad ? 'font-semibold text-danger-ink' : 'text-neutral-600')}>
                {constr.msg}
              </span>
            </span>
          </Row>
        )}
        <AlertsManager signup={signup} />
      </div>
    </div>
  );
}
