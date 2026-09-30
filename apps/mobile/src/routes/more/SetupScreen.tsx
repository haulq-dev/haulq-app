/**
 * Setting up a carrier: web's `Onboarding.tsx` on a phone.
 *
 * Not a progress bar. For every step the API says what finishing it
 * unlocks and, while it's undone, what the gap is costing. That second part
 * is shown prominently, because the step most likely to be skipped (what a
 * truck can do) is the one that fails most silently: it hides loads without
 * saying so.
 *
 * Each step opens the screen that does it. The one exception is checking
 * costs against past loads, which needs a CSV import, and importing stays on
 * the web (MOBILE_PARITY_PLAN.md section 6, decision 6).
 *
 * Owners and dispatchers. `SetupCard` is the nudge on Loads while an
 * essential step is left.
 */

import { canDispatch, useOnboarding, type OnboardingStep } from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { useSession } from '../../components/AuthGate.tsx';
import { ErrorNote, Note, Pill } from '../../components/ui.tsx';

/** Where each step is done in the app. Null: only on the web. */
const DESTINATION: Record<string, '/carrier' | '/trucks/new' | '/trucks' | '/drivers/new' | null> = {
  identity: '/carrier',
  truck: '/trucks/new',
  capabilities: '/trucks',
  driver: '/drivers/new',
  operating_facts: '/carrier',
  reconcile: null,
};

export function SetupScreen() {
  const allowed = canDispatch(useSession()?.role);
  const status = useOnboarding({ enabled: allowed });
  const data = status.data;

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/account" className="text-sm text-brand">
        ‹ More
      </Link>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl">Setting up</h1>
        {data && (
          <Pill tone={data.ready ? 'ok' : 'warn'} onPage>
            {data.completedRequired} of {data.totalRequired} essentials
          </Pill>
        )}
      </div>

      {!allowed && <Note>Setting up the carrier is for the owner and dispatchers.</Note>}
      <ErrorNote error={status.error} />
      {status.isLoading && <p className="text-sm text-mute">Loading…</p>}

      {data && (
        <>
          <p className="text-sm text-slate">
            {data.ready
              ? 'The essentials are in place. What’s left improves how well HaulQ can match and price loads for you.'
              : 'Each of these changes what HaulQ can do for you. The notes say how.'}
          </p>
          {data.factsReconciled && <p className="text-sm text-ok">Your costs are checked against real loads.</p>}
          <ol className="space-y-3">
            {data.steps.map((step) => (
              <li key={step.id}>
                <Step step={step} />
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function Step({ step }: { step: OnboardingStep }) {
  const to = DESTINATION[step.id];
  return (
    <div className="hq-card space-y-2 p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm ${
            step.done ? 'bg-ok text-white' : 'bg-wash text-mute shadow-[inset_0_0_0_1px_var(--color-line)]'
          }`}
        >
          {step.done ? '✓' : ''}
        </span>
        <div className="min-w-0 flex-1">
          <p className={`font-semibold ${step.done ? 'text-mute' : ''}`}>
            {step.title}
            <span className="sr-only">{step.done ? ' (done)' : ' (not done)'}</span>
          </p>
          {!step.required && <span className="text-xs text-mute">Optional</span>}
        </div>
      </div>
      <p className="text-sm text-slate">{step.unlocks}</p>
      {/* The part that matters: a gap here is invisible in the product itself. */}
      {step.consequence && <p className="rounded-[var(--radius-sm)] bg-warn-50 px-3 py-2 text-sm text-warn">{step.consequence}</p>}
      {!step.done &&
        (to ? (
          <Link to={to} className="hq-btn hq-btn-primary w-full active:scale-100">
            Set up
          </Link>
        ) : (
          <p className="text-sm text-mute">Importing past loads is done from HaulQ on the web, at app.haulq.ai.</p>
        ))}
    </div>
  );
}

/** On Loads, while an essential step is undone. Nothing once they're all in. */
export function SetupCard() {
  const allowed = canDispatch(useSession()?.role);
  const status = useOnboarding({ enabled: allowed });
  const data = status.data;
  if (!allowed || !data || data.ready) return null;

  const next = data.steps.find((s) => s.required && !s.done);
  return (
    <Link to="/setup" className="hq-card block space-y-1 bg-warn-50 px-4 py-3 shadow-none">
      <span className="flex items-center justify-between gap-3">
        <span className="font-semibold text-warn">
          Setting up: {data.completedRequired} of {data.totalRequired} essentials done
        </span>
        <span className="shrink-0 font-semibold text-brand">Finish ›</span>
      </span>
      {next && <span className="block text-sm text-slate">Next: {next.title.toLowerCase()}.</span>}
    </Link>
  );
}
