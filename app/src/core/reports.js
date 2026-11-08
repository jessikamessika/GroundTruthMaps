// Reports (prefilled Google Form, no backend).
// Reports are reviewed by hand and never change the map. Only the type and
// closure ID are prefilled: the note is left for the reporter, and the form's
// contact fields are never prefilled. If any constant is empty, no report
// link is shown.
const REPORT_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSebA8CAomkUrwtK0KoebWTmoaM1hjn5HLx578RShMBjqCqnQA/viewform';
const ENTRY_TYPE = 'entry.173245245';         // dropdown: option text must match exactly
const ENTRY_CLOSURE_ID = 'entry.967901427';   // short text
const ENTRY_NOTE = 'entry.1781391591';        // paragraph: never prefilled
export const REPORTS_ON = [REPORT_FORM_URL, ENTRY_TYPE, ENTRY_CLOSURE_ID, ENTRY_NOTE].every(Boolean);

// Option text (must match the form's dropdown) and its analytics enum.
export const REPORT_TYPES = [
  { label: 'Still closed', event: 'still_closed' },
  { label: "It's open now", event: 'open_now' },
  { label: 'Wrong dates', event: 'wrong_dates' },
];

export function reportUrl(type, closureId) {
  const params = [];
  if (type) params.push(ENTRY_TYPE + '=' + encodeURIComponent(type));
  if (closureId) params.push(ENTRY_CLOSURE_ID + '=' + encodeURIComponent(closureId));
  return params.length ? REPORT_FORM_URL + '?usp=pp_url&' + params.join('&') : REPORT_FORM_URL;
}

// The City's GLOBALID, exactly as stored (braces included). Features without
// one (SF, or Calgary data built before calgary_globalid was kept) fall back
// to "NAME | start date", NAME being the part of detour_note before " — ".
export function reportClosureId(props) {
  if (props.calgary_globalid) return String(props.calgary_globalid);
  const note = props.detour_note || '';
  const i = note.indexOf(' — ');
  return `${(i > -1 ? note.slice(0, i) : note) || 'Unnamed closure'} | ${props.start_date || 'unknown'}`;
}
