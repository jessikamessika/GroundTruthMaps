// Map popups. All closure/construction text comes from external feeds (City
// ArcGIS `CLOSURE_DETOUR`, SFMTA, the construction Worker); React renders it
// as text, so it is never interpreted as markup.
import { CITY } from '../core/config.js';
import { REPORTS_ON, REPORT_TYPES, reportClosureId, reportUrl } from '../core/reports.js';
import { CONSTR_NOTE, constrFmtFetched, constrFmtLocal } from '../core/construction.js';
import { phTrack } from '../core/analytics.js';

const fmt = iso => new Date(iso).toLocaleString('en-US', { timeZone: CITY.timezone,
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function closureWhen(props) {
  const future = props.calgary_temporal_status === 'FUTURE';
  if (props.window_start_utc && props.window_end_utc) {
    return future ? `Starts ${fmt(props.window_start_utc)} — until ${fmt(props.window_end_utc)}`
                  : `Now — until ${fmt(props.window_end_utc)}`;
  }
  return future
    ? `Starts ${props.start_date || 'date TBD'}`
    : `Since ${props.start_date || 'unknown'}${props.end_date ? ' — expected until ' + props.end_date : ''}`;
}

function ReportLinks({ props }) {
  if (!REPORTS_ON) return null;
  let id;
  try { id = reportClosureId(props); }   // a report-link bug must not break the popup
  catch (e) { console.error('[report] links failed', e); return null; }
  return (
    <span className="mt-1.5 block text-xs text-neutral-600">
      Report:{' '}
      {REPORT_TYPES.map((t, n) => (
        <span key={t.event}>
          {n > 0 && ' · '}
          <a
            href={reportUrl(t.label, id)} target="_blank" rel="noopener"
            className="whitespace-nowrap text-link underline"
            // analytics: report type only, never the closure
            onClick={() => { try { phTrack('report_link_clicked', { report_type: t.event }); } catch (e) {} }}
          >{t.label}</a>
        </span>
      ))}
    </span>
  );
}

export function ClosurePopup({ props }) {
  const heading = props.status === 'detour' ? 'Detour'
    : props.status === 'reduced' ? 'Lane restriction (street may still be passable)' : 'Closed';
  return (
    <div>
      <strong>{heading}</strong><br />
      {props.detour_note && <>{props.detour_note}<br /></>}
      <em>{closureWhen(props)}</em>
      <ReportLinks props={props} />
    </div>
  );
}

export function ConstructionPopup({ props, fetchedAt }) {
  const fetched = constrFmtFetched(fetchedAt);
  return (
    <div>
      <strong>{props.info || 'Construction'}</strong>
      <div className="my-1 max-h-40 overflow-y-auto whitespace-pre-wrap">
        {props.description || ''}{/* raw City text, unchanged */}
      </div>
      <em>{`${constrFmtLocal(props.start)} — ${constrFmtLocal(props.end)}`}</em>
      <span className="mt-1 block text-xs text-neutral-600">{CONSTR_NOTE}</span>
      <span className="mt-1 block text-xs text-neutral-600">
        City of Calgary Construction Detours{fetched ? ` · fetched ${fetched}` : ''}
      </span>
    </div>
  );
}
