import { CONTACT_EMAIL, PRIVACY_URL } from '../core/config.js';
import { BIKE_FREQ, signupFallbackUrl } from '../core/signup.js';


function DoneContent({ done }) {
  if (!done) return null;
  if (done.kind === 'fallback') {
    return (
      <p>
        Couldn't save right now.{' '}
        <a href={signupFallbackUrl(done.email, done.mode)} target="_blank" rel="noopener"
           className="text-link underline">Use the sign-up form instead</a>.
      </p>
    );
  }
  return (
    <p>
      {done.withRoute
        ? "Thanks for joining the beta! We'll email you if a closure shows up on this route. " +
          'Keep exploring, nothing is locked.'
        : "Thanks for joining the beta! Plan a route and add it to your alerts, and we'll email you " +
          'if a closure shows up on it. Nothing is locked.'}
    </p>
  );
}

// Closure-alert sign-up sheet (bottom). On phones it takes at most 55% of the
// screen so the route stays visible, and scrolls inside; the × stays put.
export default function SignupSheet({ signup }) {
  const { sheet, form, setForm, emailError, setEmailError, submitting, route, refs } = signup;
  if (!sheet.open) return null;

  const scroller = `max-[600px]:min-h-0 max-[600px]:overflow-y-auto max-[600px]:overscroll-contain`;

  return (
    <div
      ref={refs.sheetEl}
      role="dialog" aria-labelledby="signup-title"
      onKeyDown={e => { if (e.key === 'Escape') signup.skip(); }}
      className={
        'fixed right-2 bottom-[calc(8px+env(safe-area-inset-bottom))] left-2 z-6 mx-auto max-w-[420px] ' +
        'rounded-[14px] bg-white px-4 py-3.5 text-[15px] leading-[1.4] text-ink shadow-sheet ' +
        `max-[600px]:flex max-[600px]:max-h-[55dvh] max-[600px]:flex-col max-[600px]:px-3 max-[600px]:py-2.5 max-[600px]:text-sm`
      }
    >
      <button type="button" aria-label="Not now" onClick={signup.skip}
              className="absolute top-1 right-1 h-10 w-10 cursor-pointer text-[22px] text-neutral-600">×</button>

      {sheet.view === 'form' ? (
        <form ref={refs.formEl} noValidate onSubmit={signup.submit} className={scroller}>
          <p id="signup-title" className={`mr-8 mb-2.5 max-[600px]:mb-1.5`}>
            <strong>Join the beta.</strong> Get an email when a closure shows up
            on {route ? 'this route' : 'a route you save'}.
          </p>

          <input
            ref={refs.emailEl}
            type="email" required placeholder="you@example.com"
            autoComplete="email" inputMode="email" aria-label="Email"
            aria-describedby="signup-email-err" aria-invalid={emailError ? 'true' : undefined}
            value={form.email}
            onChange={e => { setForm(f => ({ ...f, email: e.target.value })); if (emailError) setEmailError(false); }}
            className={
              'min-h-11 w-full rounded-[10px] border border-neutral-300 px-3 text-base ' +
              `aria-invalid:border-field-err max-[600px]:min-h-10`
            }
          />
          <p ref={refs.emailErrEl} id="signup-email-err" role="alert" hidden={!emailError}
             className="mt-1 text-[13px] text-field-err">That email doesn't look right</p>

          <fieldset className={`my-2.5 max-[600px]:my-1.5`}>
            <legend className={`mb-1.5 text-sm text-neutral-700 max-[600px]:mb-1 max-[600px]:text-xs`}>
              How often do you get around by bike?
            </legend>
            {/* Optional. Values go in the sheet's `mode` column; labels must match BIKE_FREQ. */}
            <div className="grid grid-cols-2 gap-1.5">
              {Object.entries(BIKE_FREQ).map(([value, label]) => (
                <label key={value}>
                  <input type="radio" name="mode" value={value} checked={form.mode === value}
                         onChange={() => setForm(f => ({ ...f, mode: value }))}
                         className="peer pointer-events-none absolute opacity-0" />
                  <span className={
                    'flex min-h-10 cursor-pointer items-center justify-center rounded-full border border-neutral-300 ' +
                    'px-2 py-0.5 text-center text-sm leading-[1.2] ' +
                    'peer-checked:border-ink peer-checked:bg-ink peer-checked:text-white ' +
                    'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-link ' +
                    `max-[600px]:min-h-8 max-[600px]:text-[13px]`
                  }>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Consent wording is versioned: change CONSENT_VERSION in core/signup.js whenever this text changes. */}
          <label className="mb-0.5 flex cursor-pointer items-start gap-2 text-[13px] leading-[1.35]">
            <input type="checkbox" required aria-describedby="signup-consent-who"
                   checked={form.consent}
                   onChange={e => setForm(f => ({ ...f, consent: e.target.checked }))}
                   className="m-0 h-[18px] w-[18px] flex-none" />
            <span>
              Email me alerts when a closure hits my saved routes.{' '}
              <a href={PRIVACY_URL} target="_blank" rel="noopener" className="text-link underline">Details</a>
            </span>
          </label>
          <p id="signup-consent-who"
             className={`mb-2.5 ml-[26px] text-[11px] wrap-anywhere text-neutral-500 max-[600px]:mb-1.5`}>
            GroundTruth Studio · {CONTACT_EMAIL} · Unsubscribe any time.
          </p>

          {/* Pinned to the bottom of the scrolling form on phones, so an email error can't push it out of view */}
          <div className={`flex gap-2 max-[600px]:sticky max-[600px]:bottom-0 max-[600px]:bg-white max-[600px]:pt-1`}>
            <button type="submit" disabled={!form.consent || submitting}
                    className={`min-h-11 flex-1 cursor-pointer rounded-[10px] bg-ink font-semibold text-white disabled:opacity-60 max-[600px]:min-h-10`}>
              {submitting ? 'Saving…' : 'Join the beta'}
            </button>
            <button type="button" onClick={signup.skip}
                    className={`min-h-11 cursor-pointer rounded-[10px] border border-neutral-300 bg-white px-3.5 font-semibold text-ink max-[600px]:min-h-10`}>
              Not now
            </button>
          </div>
          <p className={`mt-2 text-xs text-neutral-600 max-[600px]:mt-1 max-[600px]:text-[11px]`}>
            Free while in beta. Nothing on the map is locked.
          </p>
        </form>
      ) : (
        <div role="status" className={`mr-8 ${scroller}`}>
          <DoneContent done={sheet.done} />
        </div>
      )}
    </div>
  );
}
