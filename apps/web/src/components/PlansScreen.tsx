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
 * Fleet is self-serve too: a flat platform fee plus a per-truck seat, two
 * line items on one subscription (`billing/stripe.ts`'s `lineItemsFor`) —
 * the truck count here is Checkout's `quantity` for the per-truck Price,
 * not a value HaulQ tracks anywhere itself. Multi-truck settlements and
 * roles aren't built yet; this screen sells the subscription ahead of that,
 * same as Core sells Docs/Pay/Insights/Verify Pro ahead of full Dispatch.
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
import { useState } from 'react';
import { ErrorNote, Money } from './ui.tsx';
import { request } from '../lib/api.ts';

const CORE_INCLUDES = [
  'Docs — intake, extraction, packet assembly',
  'Pay — invoicing, factoring handoff, receivables',
  'Insights — load, lane and truck profitability',
  'Verify Pro — broker authority, insurance, credit risk',
];

const FLEET_PLATFORM_CENTS = 19900;
const FLEET_PER_TRUCK_CENTS = 4900;

export function PlansScreen({ pastDue = false }: { pastDue?: boolean }) {
  const [truckCount, setTruckCount] = useState(2);

  const checkoutCore = useMutation({
    mutationFn: () => request<{ url: string }>('/v1/billing/checkout', { body: { plan: 'carrier' } }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const checkoutFleet = useMutation({
    mutationFn: () =>
      request<{ url: string }>('/v1/billing/checkout', { body: { plan: 'fleet', truckCount } }),
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
            disabled={checkoutCore.isPending}
            onClick={() => checkoutCore.mutate()}
          >
            {checkoutCore.isPending ? 'Redirecting…' : 'Subscribe to Core'}
          </button>
          <ErrorNote error={checkoutCore.error} />
        </div>

        <div className="flex flex-col border border-line bg-wash p-6">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h2 className="text-xl">Fleet</h2>
            <span className="field-label text-mute">Multiple trucks</span>
          </div>
          <p className="mb-4 text-3xl">
            <Money cents={FLEET_PLATFORM_CENTS + FLEET_PER_TRUCK_CENTS * truckCount} />
            <span className="text-base text-mute"> / month</span>
          </p>
          <p className="mb-4 flex-1 text-sm text-slate">
            Everything in Core, plus Dispatch, Track, roles, and settlements across
            your fleet. <Money cents={FLEET_PLATFORM_CENTS} className="text-ink" /> platform
            fee plus <Money cents={FLEET_PER_TRUCK_CENTS} className="text-ink" /> per truck.
          </p>

          <label className="mb-4 block">
            <span className="field-label mb-1 block text-mute">Number of trucks</span>
            <input
              type="number"
              min={1}
              className="hq-input"
              value={truckCount}
              onChange={(e) => setTruckCount(Math.max(1, Math.round(Number(e.target.value) || 1)))}
            />
          </label>

          <button
            className="hq-btn hq-btn-primary"
            disabled={checkoutFleet.isPending}
            onClick={() => checkoutFleet.mutate()}
          >
            {checkoutFleet.isPending ? 'Redirecting…' : 'Subscribe to Fleet'}
          </button>
          <ErrorNote error={checkoutFleet.error} />

          <p className="mt-3 text-sm">
            <a className="text-brand underline" href="mailto:hello@haulq.ai?subject=HaulQ Fleet">
              Prefer to talk it through first? Contact us.
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
