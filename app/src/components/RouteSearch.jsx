import { useEffect, useRef, useState } from 'react';
import { CITY, IS_CALGARY } from '../core/config.js';
import { createAddressIndex } from '../core/addressSearch.js';

const MY_LOCATION = 'My location';
const DROPPED_PIN = 'Dropped pin';
const NO_MATCH = 'No matching address. Try a house number and street, e.g. 1407 19 St NW.';
const SEARCH_DELAY_MS = 150;
const BANNER_ROOM_PX = 130;     // a route result's banner and alerts pill, below the card
const BOTTOM_PANELS_PX = 200;   // legend, feedback and the credits panel until the map is touched
const FIELDS = [
  { which: 'start', name: 'Start', color: '#188038' },
  { which: 'end', name: 'Destination', color: '#d93025' },
];

const addressIndex = IS_CALGARY ? createAddressIndex(`${CITY.dataDir}/addr`) : null;   // kept for the session

const samePoint = (a, b) => a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

function labelFor(which, endpoints, chosen) {
  const point = endpoints[which];
  if (!point) return '';
  if (chosen[which] && samePoint(chosen[which].point, point)) return chosen[which].label;
  return endpoints.locatedEnd === which ? MY_LOCATION : DROPPED_PIN;
}

function nextLabels(labels, before, after, chosen) {
  const startChanged = !samePoint(before.start, after.start);
  const endChanged = !samePoint(before.end, after.end);
  if ((startChanged || endChanged) && samePoint(after.start, before.end) && samePoint(after.end, before.start)) {
    return { start: labels.end, end: labels.start };
  }
  return {
    start: startChanged ? labelFor('start', after, chosen) : labels.start,
    end: endChanged ? labelFor('end', after, chosen) : labels.end,
  };
}

// Start and destination fields for route mode. The controller owns the
// endpoints; this owns only what they're called and the search around them.
export default function RouteSearch({ controller, endpoints, hidden }) {
  const [labels, setLabels] = useState(() => ({
    start: labelFor('start', endpoints, {}),
    end: labelFor('end', endpoints, {}),
  }));
  const [editing, setEditing] = useState(null);
  const [lastFocused, setLastFocused] = useState(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState({ status: 'idle' });

  const labelsRef = useRef(labels);
  const previous = useRef(endpoints);
  const chosen = useRef({ start: null, end: null });
  const card = useRef(null);
  const inputs = useRef({});

  // A lookup's end always changes the endpoints or the banner, so this re-renders then.
  const lookupRunning = !!controller.current?.isLocating();
  const active = lastFocused ?? (!endpoints.start && (endpoints.end || !lookupRunning) ? 'start' : 'end');

  useEffect(() => { controller.current?.setTapTarget(active); }, [controller, active]);

  useEffect(() => {
    const next = nextLabels(labelsRef.current, previous.current, endpoints, chosen.current);
    previous.current = endpoints;
    chosen.current = { start: null, end: null };
    labelsRef.current = next;
    setLabels(next);
  }, [endpoints]);

  useEffect(() => {
    if (!editing || !addressIndex) return undefined;
    let stale = false;
    const timer = setTimeout(async () => {
      const found = await addressIndex.search(query);
      if (!stale) setResult(found);
    }, SEARCH_DELAY_MS);
    return () => { stale = true; clearTimeout(timer); };
  }, [editing, query]);

  const closeKeyboard = which => inputs.current[which]?.blur();

  const fitEndpoints = () => {
    const c = controller.current;
    if (!c) return;
    const { start, end } = c.getEndpoints();
    const points = [start, end].filter(Boolean);
    if (!points.length) return;
    const lngs = points.map(p => p[0]);
    const lats = points.map(p => p[1]);
    const top = (card.current?.getBoundingClientRect().bottom ?? 60) + BANNER_ROOM_PX;
    c.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: { top, bottom: BOTTOM_PANELS_PX, left: 30, right: 60 }, maxZoom: 16, duration: 300 },
    );
  };

  const focusField = (which) => {
    setEditing(which);
    setLastFocused(which);
    setQuery('');
    setResult({ status: 'idle' });
    addressIndex?.ready();
  };

  const pickAddress = (which, row) => {
    chosen.current[which] = { point: row.point, label: row.label };
    controller.current?.setEndpoint(which, row.point);
    closeKeyboard(which);
    fitEndpoints();
  };

  const useMyLocation = async (which) => {
    closeKeyboard(which);
    const outcome = await controller.current?.locateEndpoint(which);   // the banner reports every failure
    if (outcome === 'success') fitEndpoints();
  };

  const clearField = (which) => {
    if (editing === which && query) setQuery('');
    else controller.current?.clearEndpoint(which);
  };

  const rows = result.status === 'ok' ? result.rows : [];
  const keepFocus = e => e.preventDefault();

  return (
    <div className={`w-full ${hidden ? 'hidden' : ''}`}>
      <div ref={card} className="max-w-[360px] overflow-hidden rounded-xl bg-white text-ink shadow-btn">
        <div className="flex">
          <div className="min-w-0 flex-1">
            {FIELDS.map(({ which, name, color }, i) => (
              <div key={which}
                   className={`flex h-11 items-center pl-3 ${i ? 'border-t border-neutral-200' : ''} ${active === which ? 'bg-neutral-100' : ''}`}>
                <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <input
                  ref={el => { inputs.current[which] = el; }}
                  type="text" aria-label={name} autoComplete="off" autoCorrect="off" spellCheck={false} enterKeyHint="search"
                  placeholder={editing === which && labels[which] ? labels[which] : name}
                  value={editing === which ? query : labels[which]}
                  onFocus={() => focusField(which)}
                  onBlur={() => setEditing(null)}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && rows.length) pickAddress(which, rows[0]);
                    if (e.key === 'Escape') closeKeyboard(which);
                  }}
                  className="h-11 min-w-0 flex-1 truncate bg-transparent px-2 text-base outline-none placeholder:text-neutral-600"
                />
                <button type="button" aria-label={`Clear ${name.toLowerCase()}`}
                        onMouseDown={keepFocus} onClick={() => clearField(which)}
                        className={`h-11 w-11 shrink-0 cursor-pointer text-xl text-neutral-600 ${(editing === which && query) || endpoints[which] ? '' : 'invisible'}`}>
                  ×
                </button>
              </div>
            ))}
          </div>
          <button type="button" aria-label="Swap start and destination"
                  disabled={!endpoints.start && !endpoints.end}
                  onMouseDown={keepFocus} onClick={() => controller.current?.swapEndpoints()}
                  className="w-11 shrink-0 cursor-pointer border-l border-neutral-200 text-xl text-link disabled:cursor-default disabled:text-neutral-400">
            ⇅
          </button>
        </div>

        {editing && (
          <div className="max-h-[40dvh] overflow-y-auto border-t border-neutral-200 text-sm">
            <button type="button" data-suggestion="location"
                    onMouseDown={keepFocus} onClick={() => useMyLocation(editing)}
                    className="flex min-h-11 w-full cursor-pointer items-center px-3 py-2 text-left font-medium text-link">
              {MY_LOCATION}
            </button>
            {rows.map(row => (
              <button key={row.id} type="button" data-suggestion="address"
                      onMouseDown={keepFocus} onClick={() => pickAddress(editing, row)}
                      className="flex min-h-11 w-full cursor-pointer items-center border-t border-neutral-100 px-3 py-2 text-left">
                {row.label}
              </button>
            ))}
            {result.status === 'ok' && !rows.length && (
              <p role="status" className="border-t border-neutral-100 px-3 py-2.5 leading-[1.3] text-neutral-600">{NO_MATCH}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
