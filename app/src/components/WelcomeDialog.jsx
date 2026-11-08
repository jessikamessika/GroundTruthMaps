import { useEffect, useRef, useState } from 'react';
import { BOOTH, CITY } from '../core/config.js';

// First-visit welcome. localStorage can throw (private mode), so every access is guarded.
const KEY = 'seenWelcome';

export default function WelcomeDialog() {
  const [open, setOpen] = useState(() => {
    let seen = false;
    try { seen = localStorage.getItem(KEY) === '1'; } catch (e) {}
    return !seen && !BOOTH;
  });
  const btn = useRef(null);

  useEffect(() => {
    if (!open) return;
    btn.current?.focus();
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  function close() {
    setOpen(false);
    try { localStorage.setItem(KEY, '1'); } catch (e) {}
  }

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="welcome-title"
         className="absolute inset-0 z-10 flex items-center justify-center bg-black/45 p-4">
      <div className="max-w-[340px] rounded-[14px] bg-white p-5 text-[15px] leading-normal text-ink shadow-sheet">
        <h2 id="welcome-title" className="mb-2 text-lg font-bold">{CITY.name} Cycling Closures Map</h2>
        <p className="mb-4">
          See where streets and paths are closed or restricted right now. Tap
          a <strong className="text-closed">red line</strong> for a closure
          {CITY.network && <> or a <strong className="text-detour">purple dotted line</strong> for its detour</>}.
        </p>
        <button ref={btn} onClick={close}
                className="min-h-11 w-full cursor-pointer rounded-[10px] bg-ink font-semibold text-white">
          Got it
        </button>
      </div>
    </div>
  );
}
