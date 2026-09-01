/**
 * Insights — what the loads actually made.
 *
 * ---------------------------------------------------------------------------
 * Form choices, made before colour
 * ---------------------------------------------------------------------------
 *
 * **The headline numbers are stat tiles, not a chart.** Four unrelated
 * quantities do not become clearer as a grouped bar; they become a chart nobody
 * reads. A KPI row is the right form for "a handful of headline numbers".
 *
 * **The breakdowns are tables with a magnitude bar, not bar charts.** Each row
 * is the same measure for a different subject — that is sequential magnitude,
 * one hue, and length carries it. There is no identity to encode, so there are
 * no categorical colours and no legend. The table *is* the accessible view.
 *
 * **Above/below cost per mile is polarity**, and it is shown with a colour AND a
 * word. The green/red pair measures ΔE 6.3 under deuteranopia — inside the
 * legal floor band only because a text label carries the same information.
 * Never encode it by colour alone.
 *
 * Note also what is NOT used: `warn` and `bad` from the brand tokens measure ΔE
 * 14.1 in normal vision — below the readability floor. They are fine one at a
 * time on a labelled pill, and must never be the sole difference between two
 * marks on this screen.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { request } from '../lib/api.ts';
import { Card, Empty, ErrorNote, Num } from '../components/ui.tsx';

interface Summary {
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

interface BreakdownRow {
  key: string;
  label: string;
  loadCount: number;
  revenueCents: number;
  totalMiles: number;
  revenuePerTotalMileCents: number | null;
  basis: 'actual' | 'expected' | 'mixed';
}

interface PaymentPerformance {
  paidInvoiceCount: number;
  avgDaysToPayment: number | null;
  lateCount: number;
  exceptionRate: number | null;
  factoringRejectedCount: number;
  periodDays: number;
}

interface DeliveredNotInvoiced {
  loadId: string;
  reference: number;
  brokerName: string | null;
  daysSinceDelivered: number;
}

interface OverdueInvoice {
  invoiceId: string;
  reference: number;
  loadReference: number;
  brokerName: string | null;
  totalCents: number;
  daysOverdue: number;
}

interface ActionQueue {
  deliveredNotInvoiced: DeliveredNotInvoiced[];
  overdueInvoices: OverdueInvoice[];
}

interface InsightsResponse {
  summary: Summary;
  byBroker: BreakdownRow[];
  byLane: BreakdownRow[];
  byTruck: BreakdownRow[];
  payment: PaymentPerformance;
  actionQueue: ActionQueue;
}

const WINDOWS = [30, 90, 180, 365] as const;

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);

const perMile = (cents: number | null) =>
  cents === null ? '—' : `$${(cents / 100).toFixed(2)}`;

/**
 * A headline number. No plot, so no hover layer — there is nothing to reveal
 * that is not already on screen.
 */
function Stat({
  label,
  value,
  sub,
  tone = 'ink',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'ink' | 'ok' | 'bad';
}) {
  const toneClass = tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : 'text-ink';
  return (
    <div className="border border-line bg-white p-4">
      <span className="field-label block text-mute">{label}</span>
      <span className={`num mt-1.5 block text-2xl ${toneClass}`}>{value}</span>
      {sub && <span className="mt-1 block text-xs text-mute">{sub}</span>}
    </div>
  );
}

/**
 * The magnitude bar.
 *
 * One hue, recessive, with a 2px gap from the row below and a small radius on
 * the data end. Length is the encoding; the value is printed beside it, so the
 * bar is reinforcement rather than the only way to read the number.
 */
function MagnitudeBar({ value, max, title }: { value: number; max: number; title: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className="mt-1 block h-1.5 w-full bg-wash" title={title} aria-hidden>
      <span
        className="block h-full rounded-r-sm bg-ink"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

/** Above or below the carrier's own cost per mile. Colour AND a word. */
function AgainstCost({
  perTotalMile,
  costPerMile,
}: {
  perTotalMile: number | null;
  costPerMile: number | null;
}) {
  if (perTotalMile === null) {
    return <span className="text-xs text-mute">no deadhead recorded</span>;
  }
  if (costPerMile === null) return null;

  const over = perTotalMile >= costPerMile;
  const gap = Math.abs(perTotalMile - costPerMile);
  return (
    <span className={`text-xs ${over ? 'text-ok' : 'text-bad'}`}>
      {over ? 'above' : 'below'} cost by ${(gap / 100).toFixed(2)}
    </span>
  );
}

function Breakdown({
  title,
  rows,
  costPerMile,
  emptyNote,
}: {
  title: string;
  rows: BreakdownRow[];
  costPerMile: number | null;
  emptyNote: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.revenueCents));

  return (
    <Card title={title}>
      {rows.length === 0 && <Empty>{emptyNote}</Empty>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="hq-table">
            <thead>
              <tr>
                <th className="field-label">Name</th>
                <th className="field-label">Loads</th>
                <th className="field-label">Revenue</th>
                <th className="field-label">Per total mile</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="min-w-40">
                    <span className="block font-medium break-words">{row.label}</span>
                    <MagnitudeBar
                      value={row.revenueCents}
                      max={max}
                      title={`${row.label}: ${money(row.revenueCents)}`}
                    />
                  </td>
                  <td className="num text-sm"><Num value={row.loadCount} /></td>
                  <td className="num text-sm">{money(row.revenueCents)}</td>
                  <td>
                    <span className="num block text-sm">
                      {perMile(row.revenuePerTotalMileCents)}
                    </span>
                    <AgainstCost
                      perTotalMile={row.revenuePerTotalMileCents}
                      costPerMile={costPerMile}
                    />
                    {row.basis !== 'actual' && (
                      <span className="field-label mt-0.5 block text-mute">
                        {row.basis === 'expected' ? 'estimated' : 'part estimated'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * What needs doing right now, not how things have gone — the rest of this
 * screen answers the second question, this answers the first. Not windowed
 * by the day filter above: a load delivered 45 days ago with no invoice is
 * still actionable even while looking at the 30-day rollup.
 */
/** How many rows show before "Show N more" — enough to matter, not enough to
 *  bury the stat tiles below it on an account with a long history. */
const ACTION_QUEUE_VISIBLE = 5;

interface ActionQueueItem {
  key: string;
  /** Days late, either way — what "worst first" sorts on. */
  urgency: number;
  node: ReactNode;
}

function ActionQueueCard({ queue }: { queue: ActionQueue }) {
  const [expanded, setExpanded] = useState(false);

  const items: ActionQueueItem[] = [
    ...queue.deliveredNotInvoiced.map((row) => ({
      key: `load-${row.loadId}`,
      urgency: row.daysSinceDelivered,
      node: (
        <>
          <span>
            Load {row.reference}
            {row.brokerName ? ` (${row.brokerName})` : ''} delivered {row.daysSinceDelivered}{' '}
            days ago, still not invoiced.
          </span>
          <Link to="/loads" className="hq-btn hq-btn-ghost shrink-0 text-xs">
            Open Loads
          </Link>
        </>
      ),
    })),
    ...queue.overdueInvoices.map((row) => ({
      key: `inv-${row.invoiceId}`,
      urgency: row.daysOverdue,
      node: (
        <>
          <span>
            Invoice {row.reference} for load {row.loadReference}
            {row.brokerName ? ` (${row.brokerName})` : ''} is {money(row.totalCents)},{' '}
            {row.daysOverdue} days past due.
          </span>
          <Link to="/pay" className="hq-btn hq-btn-ghost shrink-0 text-xs">
            Open Pay
          </Link>
        </>
      ),
    })),
  ].sort((a, b) => b.urgency - a.urgency);

  if (items.length === 0) return null;

  const visible = expanded ? items : items.slice(0, ACTION_QUEUE_VISIBLE);
  const hiddenCount = items.length - visible.length;

  return (
    <Card
      title="Needs attention"
      action={<span className="text-sm text-mute">{items.length}</span>}
    >
      <ul className="space-y-2.5">
        {visible.map((item) => (
          <li key={item.key} className="flex items-center justify-between gap-3 text-sm">
            {item.node}
          </li>
        ))}
      </ul>
      {hiddenCount > 0 ? (
        <button
          className="hq-btn hq-btn-ghost mt-3 w-full text-xs"
          onClick={() => setExpanded(true)}
        >
          Show {hiddenCount} more
        </button>
      ) : (
        items.length > ACTION_QUEUE_VISIBLE && (
          <button
            className="hq-btn hq-btn-ghost mt-3 w-full text-xs"
            onClick={() => setExpanded(false)}
          >
            Show fewer
          </button>
        )
      )}
    </Card>
  );
}

/**
 * Payment speed and exceptions — the piece of Insights that was blocked on
 * Pay: there is nothing to measure until an invoice has a paid date.
 *
 * Exception rate is late-paid invoices only. A currently-overdue invoice
 * that has not been paid at all yet is a different question — that is what
 * Pay's own receivables aging answers — and averaging the two together
 * would blur "this always happens eventually, just slowly" with "this
 * might never get paid."
 */
function PaymentPerformanceCard({ payment: p }: { payment: PaymentPerformance }) {
  return (
    <Card title="Payment performance">
      {p.paidInvoiceCount === 0 ? (
        <Empty>Nothing paid in the last {p.periodDays} days yet.</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label="Days to get paid"
            value={p.avgDaysToPayment === null ? '—' : p.avgDaysToPayment.toFixed(1)}
            sub={`averaged over ${p.paidInvoiceCount} paid ${p.paidInvoiceCount === 1 ? 'invoice' : 'invoices'}`}
          />
          <Stat
            label="Paid late"
            value={p.exceptionRate === null ? '—' : `${Math.round(p.exceptionRate * 100)}%`}
            sub={`${p.lateCount} of ${p.paidInvoiceCount}, against the due date on file`}
            tone={p.exceptionRate !== null && p.exceptionRate > 0 ? 'bad' : 'ink'}
          />
          <Stat
            label="Factoring rejected"
            value={String(p.factoringRejectedCount)}
            sub="submissions a factor turned down"
            tone={p.factoringRejectedCount > 0 ? 'bad' : 'ink'}
          />
        </div>
      )}
    </Card>
  );
}

export function InsightsScreen() {
  const [days, setDays] = useState<number>(90);

  const data = useQuery({
    queryKey: ['insights', days],
    queryFn: () => request<InsightsResponse>(`/v1/insights?days=${days}`),
  });

  const s = data.data?.summary;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl">Insights</h1>
          <p className="mt-1 max-w-prose text-slate">
            What your loads actually made, once the empty miles to reach them are
            counted.
          </p>
        </div>
        {/* Filters in one row above the content. */}
        <div className="flex flex-wrap gap-1.5">
          {WINDOWS.map((w) => (
            <button
              key={w}
              className={`field-label border px-3 py-2 ${
                days === w
                  ? 'border-ink bg-wash text-ink'
                  : 'border-line text-mute hover:text-ink'
              }`}
              onClick={() => setDays(w)}
            >
              {w}d
            </button>
          ))}
        </div>
      </div>

      {data.isError && <ErrorNote error={data.error} />}
      {data.isLoading && <p className="text-mute">Working it out…</p>}

      {data.data?.actionQueue && <ActionQueueCard queue={data.data.actionQueue} />}

      {s && s.loadCount === 0 && (
        <Card>
          <Empty>
            Nothing delivered in the last {s.periodDays} days. Import your load
            history and this fills in.
          </Empty>
        </Card>
      )}

      {s && s.loadCount > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Revenue"
              value={money(s.revenueCents)}
              sub={`${s.loadCount} loads in ${s.periodDays} days`}
            />
            <Stat
              label="Per total mile"
              value={perMile(s.revenuePerTotalMileCents)}
              sub={
                s.costPerMileCents !== null
                  ? `your cost is ${perMile(s.costPerMileCents)}`
                  : 'set your cost per mile to compare'
              }
              tone={
                s.costPerMileCents === null || s.revenuePerTotalMileCents === null
                  ? 'ink'
                  : s.revenuePerTotalMileCents >= s.costPerMileCents
                    ? 'ok'
                    : 'bad'
              }
            />
            <Stat
              label="Per loaded mile"
              value={perMile(s.revenuePerLoadedMileCents)}
              sub="the flattering one — ignores empty miles"
            />
            <Stat
              label="Deadhead"
              value={s.deadheadRatio === null ? '—' : `${Math.round(s.deadheadRatio * 100)}%`}
              sub={`${s.deadheadMiles.toLocaleString('en-US')} of ${(s.loadedMiles + s.deadheadMiles).toLocaleString('en-US')} miles empty`}
            />
          </div>

          {s.measurableCount < s.loadCount && (
            <p className="border-l-2 border-line bg-wash px-3 py-2 text-sm text-slate">
              <strong>
                {s.loadCount - s.measurableCount} of {s.loadCount} loads
              </strong>{' '}
              have no deadhead recorded, so they are left out of the per-total-mile
              figures rather than counted as zero empty miles. Counting them as
              zero would make every average look better than it is.
            </p>
          )}

          {s.factsReconciledAt === null && (
            <p className="border-l-2 border-warn bg-warn-50 px-3 py-2 text-sm text-warn">
              Your operating costs have not been reconciled against real loads
              yet, so any comparison against cost per mile is using a figure you
              typed rather than one measured.
            </p>
          )}

          <PaymentPerformanceCard payment={data.data!.payment} />

          <Breakdown
            title="By broker"
            rows={data.data!.byBroker}
            costPerMile={s.costPerMileCents}
            emptyNote="No brokers recorded on these loads."
          />
          <Breakdown
            title="By lane"
            rows={data.data!.byLane}
            costPerMile={s.costPerMileCents}
            emptyNote="No lanes to show."
          />
          <Breakdown
            title="By truck"
            rows={data.data!.byTruck}
            costPerMile={s.costPerMileCents}
            emptyNote="No trucks recorded on these loads."
          />
        </>
      )}
    </div>
  );
}
