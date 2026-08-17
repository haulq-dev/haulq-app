/**
 * Setup.
 *
 * Not a progress bar. The API returns, for every step, what completing it
 * `unlocks` and — while it is undone — what that gap is currently costing the
 * carrier. This screen's only real job is to render the second one prominently,
 * because the step most likely to be skipped (truck capabilities) is the one
 * that fails most silently: it hides loads without saying so.
 *
 * Build plan section 8 calls VirtualDispatch's onboarding the parity bar and
 * names its weakness — everything self-reported, nothing explained. A checklist
 * of ticks would match their surface and miss the point.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { request, type HistorySummary, type OnboardingStatus } from '../lib/api.ts';
import { Card, ErrorNote, Money, Num, Pill } from '../components/ui.tsx';

const DESTINATION: Record<string, string> = {
  identity: '/profile',
  truck: '/trucks',
  capabilities: '/trucks',
  driver: '/trucks',
  operating_facts: '/profile',
  reconcile: '/import',
};

export function OnboardingScreen() {
  const status = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => request<OnboardingStatus>('/v1/onboarding'),
  });

  const history = useQuery({
    queryKey: ['history-summary'],
    queryFn: () => request<HistorySummary>('/v1/imports/history-summary'),
  });

  if (status.isError) return <ErrorNote error={status.error} />;
  if (!status.data) return <p className="text-mute">Loading…</p>;

  const { steps, completedRequired, totalRequired, ready, factsReconciled } = status.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl">Setting up</h1>
          <p className="mt-1 max-w-prose text-slate">
            {ready
              ? 'The essentials are in place. What is left improves how well HaulQ can match and price loads for you.'
              : 'Each of these changes what HaulQ can do for you. The notes say how.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={ready ? 'ok' : 'warn'}>
            {completedRequired} of {totalRequired} essentials
          </Pill>
          {factsReconciled && <Pill tone="ok">Costs verified</Pill>}
        </div>
      </div>

      <ol className="space-y-3">
        {steps.map((step) => (
          <li key={step.id} className="border border-line bg-white">
            <div className="flex items-start gap-4 p-5">
              <span
                aria-hidden
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center border text-sm ${
                  step.done
                    ? 'border-ok bg-ok text-white'
                    : 'border-line bg-white text-mute'
                }`}
              >
                {step.done ? '✓' : ''}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg">{step.title}</h2>
                  {!step.required && <Pill>optional</Pill>}
                </div>

                <p className="mt-1 max-w-prose text-sm text-slate">{step.unlocks}</p>

                {/* The part that matters. A gap here is invisible in the
                    product itself, so it has to be loud in the checklist. */}
                {step.consequence && (
                  <p className="mt-2 max-w-prose border-l-2 border-warn bg-warn-50 px-3 py-2 text-sm text-warn">
                    {step.consequence}
                  </p>
                )}
              </div>

              {!step.done && (
                <Link
                  to={DESTINATION[step.id] ?? '/'}
                  className="hq-btn hq-btn-primary shrink-0"
                >
                  Set up
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>

      {history.data && history.data.loadCount > 0 && (
        <Card title="What your imported history says">
          <dl className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <div>
              <dt className="field-label text-mute">Loads</dt>
              <dd className="mt-1 text-2xl">
                <Num value={history.data.loadCount} />
              </dd>
            </div>
            <div>
              <dt className="field-label text-mute">Days covered</dt>
              <dd className="mt-1 text-2xl">
                <Num value={history.data.periodDays} />
              </dd>
            </div>
            <div>
              <dt className="field-label text-mute">Revenue</dt>
              <dd className="mt-1 text-2xl">
                <Money cents={history.data.totalRevenueCents} />
              </dd>
            </div>
            <div>
              <dt className="field-label text-mute">Revenue / mile</dt>
              <dd className="mt-1 text-2xl">
                {history.data.revenuePerMileCents !== null ? (
                  <Money cents={history.data.revenuePerMileCents} />
                ) : (
                  <span className="text-mute">—</span>
                )}
              </dd>
            </div>
          </dl>
        </Card>
      )}
    </div>
  );
}
