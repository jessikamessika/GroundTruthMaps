import { useState } from 'react';
import { CONTACT_EMAIL } from '../core/config.js';
import { PH_STORAGE, phPrivacySignal } from '../core/analytics.js';
import { emailLooksValid, postToSheet } from '../core/signup.js';

const SRC = (new URLSearchParams(location.search).get('src') || 'privacy').slice(0, 40);

const linkCls = 'text-link underline';
const A = ({ href, children, ext }) =>
  <a href={href} className={linkCls} {...(ext ? { target: '_blank', rel: 'noopener' } : {})}>{children}</a>;

function mailtoFor(email) {
  const params = { subject: 'Delete my data' };
  if (emailLooksValid(email)) params.body = `Please delete all data stored for ${email}.`;
  return `mailto:${CONTACT_EMAIL}?` + new URLSearchParams(params).toString().replace(/\+/g, '%20');
}

// Same Apps Script web app as the sign-up sheet (api/apps-script/signup.gs).
// A delete-request only appends a row; requests are processed by hand.
function DeleteForm() {
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState(false);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState(null);   // null | { ok: true } | { ok: false, email }

  const submit = async (e) => {
    e.preventDefault();
    const value = email.trim();
    if (!emailLooksValid(value)) { setEmailError(true); return; }
    setEmailError(false);
    setSending(true);
    setMsg(null);
    try {
      await postToSheet({ email: value, src: SRC, kind: 'delete-request' });
    } catch (err) {
      console.error('[delete] send failed:', err);
      if (err && err.message === 'bad email') { setEmailError(true); return; }   // signup.gs said no
      setMsg({ ok: false, email: value });
      return;
    } finally {
      setSending(false);
    }
    setEmail('');
    setMsg({ ok: true });
  };

  return (
    <>
      <form noValidate onSubmit={submit} className="mt-1 mb-2.5 flex flex-wrap gap-2">
        <input type="email" required placeholder="you@example.com" autoComplete="email"
               inputMode="email" aria-label="Email" aria-describedby="delete-email-err"
               aria-invalid={emailError ? 'true' : undefined}
               value={email} onChange={e => { setEmail(e.target.value); setEmailError(false); }}
               className="min-h-11 flex-[1_1_220px] rounded-[10px] border border-neutral-300 px-3 text-base aria-invalid:border-field-err" />
        <button type="submit" disabled={sending}
                className="min-h-11 cursor-pointer rounded-[10px] bg-ink px-4 font-semibold text-white disabled:opacity-60">
          {sending ? 'Sending…' : 'Delete my data'}
        </button>
      </form>
      <p id="delete-email-err" role="alert" hidden={!emailError}
         className="-mt-1 mb-2.5 text-[13px] text-field-err">That email doesn't look right</p>
      <p role="status" hidden={!msg} className="mb-2.5 rounded-[10px] bg-neutral-100 px-3 py-2.5">
        {msg?.ok && "Got it. I'll delete the data for that email within 10 business days " +
                    'and may email that address to confirm the request.'}
        {msg && !msg.ok && <>Couldn't send that right now. <A href={mailtoFor(msg.email)}>Email the request instead</A>.</>}
      </p>
    </>
  );
}

// Usage statistics switch (analytics opt-out). Off = gtm_ph_optout '1' in this
// browser's local storage, checked before PostHog loads; turning off also
// deletes the random ID and first/last-seen dates. With Do Not Track or Global
// Privacy Control set, or with site storage blocked, nothing is collected, so
// it shows off and is locked.
function UsageToggle() {
  const [signal] = useState(phPrivacySignal);
  const [blocked] = useState(() => {
    try { localStorage.setItem('gtm_ph_probe', '1'); localStorage.removeItem('gtm_ph_probe'); return false; }
    catch (e) { return true; }
  });
  const isOff = () => { try { return localStorage.getItem(PH_STORAGE.optout) === '1'; } catch (e) { return true; } };
  const [off, setOff] = useState(isOff);

  const toggle = () => {
    try {
      if (isOff()) {
        localStorage.removeItem(PH_STORAGE.optout);
      } else {
        localStorage.setItem(PH_STORAGE.optout, '1');
        PH_STORAGE.forget.forEach(k => localStorage.removeItem(k));
        try { sessionStorage.removeItem(PH_STORAGE.session); } catch (e) {}
      }
    } catch (e) { console.error('[usage-stats] toggle failed', e); }
    setOff(isOff());   // shows what is actually stored, even if saving failed
  };

  const on = !signal && !blocked && !off;
  const title = signal ? 'Your browser sends Do Not Track or Global Privacy Control, so none are collected.'
    : blocked ? 'Your browser blocks site storage, so none are collected.' : undefined;

  return (
    <p className="mb-2.5">
      <button type="button" role="switch" aria-checked={on} disabled={signal || blocked} title={title}
              onClick={toggle}
              className={
                'min-h-11 cursor-pointer rounded-[10px] border px-4 font-semibold disabled:cursor-default disabled:opacity-60 ' +
                (on ? 'border-ink bg-ink text-white' : 'border-neutral-300 bg-white text-ink')
              }>
        Usage statistics: {on ? 'on' : 'off'}
      </button>
    </p>
  );
}

export default function PrivacyPage() {
  const P = ({ children }) => <p className="mb-2.5">{children}</p>;
  return (
    <main className="mx-auto max-w-[640px] px-4 pt-6 pb-12">
      <a className={`mb-4 inline-block text-sm ${linkCls}`} href="./">← Back to the map</a>
      <h1 className="mb-1 text-[22px] font-bold">Privacy notice: GroundTruth Maps</h1>
      <p className="mb-5 text-[13px] text-neutral-600">Last updated: November 8, 2026</p>

      <P><strong>Who:</strong> Zixuan Zhang, sole proprietor, operating as GroundTruth Studio,{' '}
        <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A>.</P>
      <P><strong>What I store:</strong> your email, how often you bike, the start and end points of
        routes you save, where you signed up, timestamps and a record of what you agreed to.
        Your browser also keeps your email and routes in local storage. It also keeps a random ID and
        a few settings for usage statistics (see below).</P>
      <P><strong>Why:</strong> to send confirmations and closure alerts.</P>
      <P><strong>Who sees it:</strong> only me, the founder. Google (Sheets, Apps Script) is my service provider,
        so data may be stored outside Canada. PostHog (United States) is my service provider for anonymous usage statistics.</P>
      <P><strong>How long:</strong> 12 months after your last activity, then deleted.</P>
      <P><strong>Device location:</strong> when you plan a route, the app asks your browser for your location to
        fill in your start point. You can say no and tap the map instead. If you allow it, your exact location
        becomes the route's start point and is sent through my routing server (Cloudflare) to OpenRouteService to
        work out the route, the same as a point you tap. I don't save it unless you sign up for alerts on that route
        or add it to your alerts. Then your exact location is saved as that route's start point and handled like
        the other data above.</P>
      <P><strong>Address search:</strong> when you type a Calgary street address, it's matched on your device
        against a public City of Calgary address list. To do that, the app downloads a public file from this site,
        chosen by the street number or the first three letters of the street name. The rest of what you type
        isn't sent. If there's no match on your device, or the list can't load, what you typed is handled as a
        place search (below).</P>
      <P><strong>Place search:</strong> text you type to find places, and all San Francisco searches, is sent to
        my server (Cloudflare) and forwarded to OpenRouteService, run by HeiGIT gGmbH in Heidelberg, Germany, to
        find matches. I don't keep a record of your searches. To save lookups, my server's Cloudflare cache holds
        each search and its results for up to an hour. My server's request logs are off.</P>
      <P><strong>“My location” in a route field:</strong> your position is used to set that route point, the same
        as a point you tap, and goes through my routing server to OpenRouteService to work out the route. While
        the app is open, it also remembers your position on your device to show how far away search results are.
        It isn't stored unless you save that route for alerts, as described under Device location.</P>
      <P><strong>Reports:</strong> problem reports and feedback are sent through a Google Form. They
        may include a note and, only if you choose to give it, a contact email. I review them by
        hand; they never change the map automatically. Kept up to 12 months; to delete one, use
        the form below or email me.</P>
      <P><strong>Usage statistics:</strong> to see how the app is used and improve it, I collect anonymous usage events,
        such as “route planned”, “sign-up sheet shown”, which route result was shown (for example, clear or rerouted)
        and how you arrived (for example, a QR code). They don't include your email, your route start or end points,
        closure names, anything you type, or session recordings. If the app crashes, it may send an error report with
        the type of error and where in the code it happened, never what you typed, your email or your route. To tell
        a returning visit from a new one, the app keeps a random ID in your browser's storage. It isn't linked to
        your email or saved routes. PostHog processes these events on servers in the United States. IP addresses
        are not stored with usage events. Kept up to 12 months. You can turn this off with the switch at the bottom
        of this page, which also deletes the random ID. The app also doesn't collect usage statistics if your browser
        sends Do Not Track or Global Privacy Control. The setting is saved in your browser, so clearing site data resets it.</P>
      <P>Usage statistics also include three events about route points: geolocate_used, address_searched and
        endpoint_edited. They record things like whether a location lookup worked, whether a suggestion was picked
        and roughly how many results appeared. No addresses, search text or locations are included.</P>
      <P><strong>Your rights:</strong> unsubscribe via any email's link; see, correct or delete your
        data with the form below or by email (within 10 business days); complain to the{' '}
        <A href="https://oipc.ab.ca/" ext>Information and Privacy Commissioner of Alberta</A>. I ask that you
        please talk to me directly to resolve any problems in an easier way before submitting external complaints.</P>

      <h2 id="delete" className="mt-7 mb-2 text-[17px] font-bold">Delete my data</h2>
      <DeleteForm />
      <P>Or email <A href={`mailto:${CONTACT_EMAIL}?subject=Delete%20my%20data`}>{CONTACT_EMAIL}</A>.</P>

      {/* The "Usage statistics" paragraph above refers to this switch as being
          at the bottom of the page, so keep it here. */}
      <UsageToggle />
    </main>
  );
}
