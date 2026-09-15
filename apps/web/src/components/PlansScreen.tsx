/**
 * The paywall.
 *
 * Shown by `Shell.tsx` in place of the app for any org whose `status` is not
 * `'active'` — a brand-new signup (still `trialing`, HaulQ's build plan
 * for `createOrg` never gave anyone a free trial past this screen) and a
 * lapsed subscription land here the same way, on purpose: "pick a plan" and
 * "your payment needs attention" are the same screen with a different
 * headline, not two features.
 *
 * Only Core is self-serve. Fleet is a real bundle in the product portfolio
 * (`HAULQ_BUILD_PLAN.md` section 3) but has no Stripe Price yet —
 * multi-truck settlements and per-truck pricing aren't built, so its card is
 * a contact link, not a Checkout button.
 *
 * Core's price and contents follow the CFO pricing model's launch
 * recommendation (`HaulQ_CFO_Model`, Pricing/Dashboard sheets), not the
 * broader Dispatch+Track bundle this screen shipped with initially —
 * Dispatch and Track stay out of what's sold until the model's Operations
 * and Complete release gates are actually met. The `plan` value this still
 * writes is `'carrier'` (the single-truck bundle family in
 * `packages/db/src/schema/enums.ts`'s `orgPlanEnum`); "Core" is this
 * family's current entry price point, not a separate plan.
 */

import { useMutation } from '@tanstack/react-query';
import { ErrorNote, Money } from './ui.tsx';
import { request } from '../lib/api.ts';

const CORE_INCLUDES = [
  'Docs — intake, extraction, packet assembly',
  'Pay — invoicing, factoring handoff, receivables',
  'Insights — load, lane and truck profitability',
  'Verify Pro — broker authority, insurance, credit risk',
];

export function PlansScreen({ pastDue = false }: { pastDue?: boolean }) {
  const checkout = useMutation({
    mutationFn: () => request<{ url: string }>('/v1/billing/checkout', { method: 'POST' }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <h1 className="mb-2 text-3xl">
        {pastDue ? 'Your subscription needs attention' : 'Choose a plan'}
      </h1>
      <p className="mb-10 max-w-prose text-slate">
        {pastDue
          ? 'The last payment on this account did not go through. Update it to get back in.'
          : 'The back-office essentials for a single truck. More products unlock here as they launch.'}
      </p>

      <div className="grid gap-6 sm:grid-cols-2">
        <div className="flex flex-col border-2 border-ink bg-white p-6">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h2 className="text-xl">Core</h2>
            <span className="field-label text-mute">Single truck</span>
          </div>
          <p className="mb-4 text-3xl">
            <Money cents={4900} />
            <span className="text-base text-mute"> / month</span>
          </p>
          <ul className="mb-6 flex-1 space-y-2 text-sm text-slate">
            {CORE_INCLUDES.map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden className="text-ok">✓</span>
                {line}
              </li>
            ))}
          </ul>
          <button
            className="hq-btn hq-btn-brand"
            disabled={checkout.isPending}
            onClick={() => checkout.mutate()}
          >
            {checkout.isPending ? 'Redirecting…' : 'Subscribe to Core'}
          </button>
          <ErrorNote error={checkout.error} />
        </div>

        <div className="flex flex-col border border-line bg-wash p-6">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h2 className="text-xl">Fleet</h2>
            <span className="field-label text-mute">Multiple trucks</span>
          </div>
          <p className="mb-4 text-3xl text-mute">
            Per truck
          </p>
          <p className="mb-6 flex-1 text-sm text-slate">
            Everything in Core, plus Dispatch, Track, roles, settlements across your
            fleet, and per-truck pricing. Not self-serve yet — talk to us and we will
            set your account up directly.
          </p>
          <a className="hq-btn hq-btn-ghost text-center" href="mailto:hello@haulq.ai?subject=HaulQ Fleet">
            Contact us
          </a>
        </div>
      </div>
    </div>
  );
}
