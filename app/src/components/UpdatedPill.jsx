import { useEffect, useState } from 'react';

// "Closures updated N min ago" pill, re-rendered every minute; amber when stale (> 6 h).
export default function UpdatedPill({ generated }) {
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  const d = new Date(generated);
  if (!generated || isNaN(d)) return null;   // no valid date, no pill

  let text, stale = false;
  if (!/T\d{2}:\d{2}/.test(generated)) {   // old date-only format: don't fake precision
    text = 'Closures updated ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } else {
    const mins = Math.max(0, Math.round((Date.now() - d) / 60000));
    let ago;
    if (mins < 1) ago = 'just now';
    else if (mins < 60) ago = `${mins} min ago`;
    else if (mins < 48 * 60) {
      const h = Math.round(mins / 60);
      ago = `${h} hour${h === 1 ? '' : 's'} ago`;
    } else ago = `${Math.round(mins / 1440)} days ago`;
    text = `Closures updated ${ago}`;
    stale = mins > 6 * 60;
  }

  return (
    <div className={
      'absolute top-[calc(8px+env(safe-area-inset-top))] left-2 z-2 max-w-[calc(100vw-205px)] ' +
      'rounded-full px-2.5 py-1.5 text-xs leading-[1.2] shadow-pill ' +
      (stale ? 'bg-amber-100 text-amber-900' : 'bg-white/96 text-ink')
    }>{text}</div>
  );
}
