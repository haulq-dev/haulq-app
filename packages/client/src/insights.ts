/**
 * Insights, the carrier profile, usage and the activity feed: what the API
 * returns and the small rules both front ends apply. Copied from
 * `apps/web/src/routes/Insights.tsx`, `Profile.tsx` and `Timeline.tsx` for the
 * mobile port (MOBILE_PARITY_PLAN.md M5). Web still declares its own copy.
 *
 * All of it is office-only on the API (`requireRole` on each read, added with
 * M5), because it is the carrier's money: revenue, rates, cost per mile.
 */

import type { OperatingFacts } from '@haulq/contracts';
import { parseDollars } from './pay.ts';

export interface InsightsSummary {
  loadCount: number;
  measurableCount: number;
  revenueCents: number;
  loadedMiles: number;
  deadheadMiles: number;
  revenuePerTotalMileCents: number | null;
  revenuePerLoadedMileCents: number | null;
  deadheadRatio: number | null;
  costPerMileCents: number | null;
  factsReconciledAt: string | null;
  periodDays: number;
}

export interface BreakdownRow {
  key: string;
  label: string;
  loadCount: number;
  revenueCents: number;
  totalMiles: number;
  revenuePerTotalMileCents: number | null;
  basis: 'actual' | 'expected' | 'mixed';
}

export interface PaymentPerformance {
  paidInvoiceCount: number;
  avgDaysToPayment: number | null;
  lateCount: number;
  exceptionRate: number | null;
  factoringRejectedCount: number;
  periodDays: number;
}

export interface DeliveredNotInvoiced {
  loadId: string;
  reference: number;
  brokerName: string | null;
  daysSinceDelivered: number;
}

export interface OverdueInvoice {
  invoiceId: string;
  reference: number;
  loadReference: number;
  brokerName: string | null;
  totalCents: number;
  daysOverdue: number;
}

export interface ActionQueue {
  deliveredNotInvoiced: DeliveredNotInvoiced[];
  overdueInvoices: OverdueInvoice[];
}

export interface InsightsResponse {
  summary: InsightsSummary;
  byBroker: BreakdownRow[];
  byLane: BreakdownRow[];
  byTruck: BreakdownRow[];
  payment: PaymentPerformance;
  actionQueue: ActionQueue;
}

export const INSIGHT_WINDOWS = [30, 90, 180, 365] as const;

/** Whole dollars for headline figures: `$12,480`. */
export const wholeDollars = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);

/** Per-mile figures keep their cents: `$1.94`, or `—` when there's nothing to divide. */
export const perMile = (cents: number | null) => (cents === null ? '—' : `$${(cents / 100).toFixed(2)}`);

/**
 * Above or below the carrier's own cost per mile, by how much. `null` when
 * either side is missing: no comparison is better than a made-up one.
 */
export function againstCost(perTotalMileCents: number | null, costPerMileCents: number | null): { above: boolean; gapCents: number } | null {
  if (perTotalMileCents === null || costPerMileCents === null) return null;
  return { above: perTotalMileCents >= costPerMileCents, gapCents: Math.abs(perTotalMileCents - costPerMileCents) };
}

export type ActionItem =
  | { kind: 'uninvoiced'; key: string; urgency: number; loadId: string; text: string }
  | { kind: 'overdue'; key: string; urgency: number; invoiceId: string; text: string };

/**
 * "Needs attention": delivered loads with no invoice and invoices past due,
 * as one list, worst first. Not windowed by the day filter: a load delivered
 * 45 days ago with no invoice still needs doing while the 30-day view is up.
 */
export function actionItems(queue: ActionQueue): ActionItem[] {
  const broker = (name: string | null) => (name ? ` (${name})` : '');
  const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;
  return [
    ...queue.deliveredNotInvoiced.map(
      (r): ActionItem => ({
        kind: 'uninvoiced',
        key: `load-${r.loadId}`,
        urgency: r.daysSinceDelivered,
        loadId: r.loadId,
        text: `Load ${r.reference}${broker(r.brokerName)} delivered ${days(r.daysSinceDelivered)} ago, not invoiced.`,
      }),
    ),
    ...queue.overdueInvoices.map(
      (r): ActionItem => ({
        kind: 'overdue',
        key: `inv-${r.invoiceId}`,
        urgency: r.daysOverdue,
        invoiceId: r.invoiceId,
        text: `Invoice ${r.reference} for load ${r.loadReference}${broker(r.brokerName)}, ${wholeDollars(r.totalCents)}, ${days(r.daysOverdue)} past due.`,
      }),
    ),
  ].sort((a, b) => b.urgency - a.urgency);
}

// ---------------------------------------------------------------------------
// Operating costs
// ---------------------------------------------------------------------------

type FactKey = keyof OperatingFacts;

/**
 * The operating-cost fields in form order. The hints are web's. `money`
 * fields are dollars in the form and cents on the wire.
 */
export const OPERATING_FACT_FIELDS: readonly { key: FactKey; label: string; hint: string; money: boolean; suffix?: string }[] = [
  { key: 'costPerMileCents', label: 'Cost per mile ($)', money: true, hint: 'Fuel, maintenance, tyres, tolls. Not driver pay. The most important number here.' },
  { key: 'fixedWeeklyCostCents', label: 'Fixed cost per week ($)', money: true, hint: 'Truck payment, insurance, permits, parking: owed whether or not the truck moves.' },
  { key: 'fuelPricePerGallonCents', label: 'Diesel per gallon ($)', money: true, hint: 'What you actually pay, after discounts.' },
  { key: 'avgMpg', label: 'Average mpg', money: false, hint: 'Loaded. A 26 ft straight truck is usually 8 to 10.' },
  { key: 'driverPayPerMileCents', label: 'Driver pay per mile ($)', money: true, hint: 'Zero if you drive it yourself. Your pay is the margin; counting it twice makes every load look unprofitable.' },
  { key: 'targetMarginPercent', label: 'Target margin (%)', money: false, hint: 'Percent of revenue. Most carriers aim at 15 to 25.' },
];

export function factsToForm(facts: Record<string, number | undefined>): Record<FactKey, string> {
  const out = {} as Record<FactKey, string>;
  for (const f of OPERATING_FACT_FIELDS) {
    const v = facts[f.key];
    out[f.key] = v === undefined ? '' : f.money ? (v / 100).toFixed(2) : String(v);
  }
  return out;
}

/**
 * The form as `PUT /v1/org/operating-facts` wants it. Blank is left out (not
 * set). A value that isn't a number is reported by field rather than
 * silently dropped: web's form drops it, which saves the other fields and
 * quietly loses that one.
 */
export function formToFacts(values: Record<FactKey, string>): { facts: OperatingFacts } | { invalid: FactKey } {
  const facts: Record<string, number> = {};
  for (const f of OPERATING_FACT_FIELDS) {
    const raw = (values[f.key] ?? '').trim();
    if (raw === '') continue;
    if (f.money) {
      const cents = parseDollars(raw);
      if (cents === null) return { invalid: f.key };
      facts[f.key] = cents;
    } else {
      const n = Number(raw.replace(/,/g, ''));
      if (!Number.isFinite(n) || n < 0) return { invalid: f.key };
      facts[f.key] = n;
    }
  }
  return { facts: facts as OperatingFacts };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface MonthlyUsage {
  monthStart: string;
  documentsReceived: number;
  invoicesGenerated: number;
  trackCheckins: number;
  brokerChecks: number;
}

/**
 * Raw counts, never "X of Y". No plan defines a volume limit, so a progress
 * bar against one would be invented (see web's `Usage` note).
 */
export const USAGE_ROWS: readonly { key: Exclude<keyof MonthlyUsage, 'monthStart'>; label: string }[] = [
  { key: 'documentsReceived', label: 'Documents received' },
  { key: 'invoicesGenerated', label: 'Invoices created' },
  { key: 'trackCheckins', label: 'Driver check-ins' },
  { key: 'brokerChecks', label: 'Broker checks you asked for' },
];

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * Who did it. An action HaulQ took must never read like one a person took
 * (guardrail 5), so agent and system actions say HaulQ.
 */
export function actorLabel(actorType: string): string {
  return ({ user: 'A person', agent: 'HaulQ', system: 'HaulQ', integration: 'A connected service' } as Record<string, string>)[actorType] ?? actorType;
}

/** Group key for the activity list: "Today", "Yesterday", or the date. */
export function activityDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  });
}
