// Closure-alert sign-ups from the web app (app/src/core/signup.js) -> "App sign-ups" tab.
// Bound to the "GroundTruth Maps: Closure Alerts (YYC) (Responses)" sheet
// (Extensions > Apps Script). Deploy > New deployment > Web app:
//   Execute as: Me    Who has access: Anyone
// then paste the /exec URL into SIGNUP_URL in app/src/core/config.js.
// After editing this file, Deploy > Manage deployments > edit > New version,
// or the /exec URL keeps serving the old code.

const TAB = 'App sign-ups';
const HEADERS = ['timestamp', 'email', 'mode', 'src', 'route_start', 'route_end', 'trial_start', 'kind',
                 'consent_text_version'];
// `mode` holds how often the person bikes (optional); anything else is stored blank.
const MODES = ['', 'daily', 'weekly', 'monthly', 'rare'];
// delete-request comes from the privacy page (app/src/privacy/PrivacyPage.jsx); those rows are processed by hand.
const KINDS = ['signup', 'add-route', 'remove-route', 'delete-request'];
// Rows that record what the person agreed to. add-route sends the version saved
// on the device at sign-up, so it can be blank for sign-ups made before consent
// versions existed; a new sign-up must carry one.
const CONSENT_KINDS = ['signup', 'add-route'];

// Same rule as emailLooksValid() in app/src/core/signup.js: one @,
// something before it, a dot inside the domain, no spaces or <>()[],;:"\.
function emailLooksValid(email) {
  if (email.length > 254 || /[\s<>()[\],;:"\\]/.test(email)) return false;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  return domain.indexOf('.') > 0 && !domain.endsWith('.');
}

// Public endpoint: everything is clipped, and a leading = + - @ is quoted so a
// value can never run as a sheet formula.
const clip = v => String(v == null ? '' : v).trim().slice(0, 120).replace(/^[=+\-@]/, "'$&");

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: 'bad json' }); }
  const email = String(d.email || '').trim();
  if (!emailLooksValid(email)) return reply({ ok: false, error: 'bad email' });
  if (!KINDS.includes(d.kind)) return reply({ ok: false, error: 'bad kind' });
  if (d.kind === 'signup' && !String(d.consent_text_version || '').trim()) {
    return reply({ ok: false, error: 'no consent' });
  }
  const consent = CONSENT_KINDS.includes(d.kind);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);   // concurrent booth sign-ups must not overwrite each other's row
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(TAB) || ss.insertSheet(TAB);
    if (sh.getLastRow() === 0) { sh.appendRow(HEADERS); sh.setFrozenRows(1); }
    sh.appendRow([
      new Date(), clip(email), MODES.includes(d.mode) ? d.mode : '', clip(d.src),
      clip(d.route_start), clip(d.route_end), clip(d.trial_start),
      d.kind,
      consent ? clip(d.consent_text_version) : '',
    ]);
  } finally {
    lock.releaseLock();
  }
  return reply({ ok: true });
}

function reply(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
