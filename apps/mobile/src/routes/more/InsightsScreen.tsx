/**
 * Insights: what the loads actually made, once the empty miles to reach them
 * are counted. Web's `Insights.tsx` as stacked cards (MOBILE_PARITY_PLAN.md M5).
 *
 * Form, as on web:
 * - **Headline numbers are stat tiles**, not a chart. Four unrelated
 *   quantities don't get clearer as a grouped bar.
 * - **Breakdowns are lists with a magnitude bar.** Each row is the same measure
 *   for a different subject, so one hue and length carry it, and the value is
 *   printed beside the bar, so the bar is never the only way to read it.
 *   On a phone the three breakdowns share one card with a switch, instead of
 *   three tall tables.
 * - **Above/below cost per mile is colour and a word**, never colour alone.
 *
 * "Needs attention" leads, and each row goes straight to the fix: the new
 * invoice for that load, or the overdue invoice. Web can only link to the list.
 */

import {
  actionItems,
  againstCost,
  canWritePay,
  INSIGHT_WINDOWS,
  perMile,
  useHistorySummary,
  useInsights,
  wholeDollars,
  type ActionQueue,
  type BreakdownRow,
  type InsightsSummary,
  type PaymentPerformance,
} from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Note } from '../../components/ui.tsx';

export function InsightsScreen() {
  const [days, setDays] = useState<number>(90);
  const insights = useInsights(days);
  const data = insights.data;
  const s = data?.summary;

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/account" className="text-sm text-brand">
        ‹ More
      </Link>
      <h1 className="text-2xl">Insights</h1>

      <div className="grid grid-cols-4 rounded-[var(--radius-sm)] bg-line/60 p-0.5" role="tablist" aria-label="Period">
        {INSIGHT_WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            role="tab"
            aria-selected={days === w}
            onClick={() => setDays(w)}
            className={`num rounded-[8px] py-1.5 text-sm font-semibold ${days === w ? 'bg-card text-ink shadow-sm' : 'text-slate'}`}
          >
            {w === 365 ? '1 yr' : `${w} days`}
          </button>
        ))}
      </div>

      {insights.isError && <ErrorNote error={insights.error} />}
      {insights.isLoading && <p className="text-sm text-mute">Working it out…</p>}

      {data && <NeedsAttention queue={data.actionQueue} />}

      {s && s.loadCount === 0 && (
        <div className="hq-card px-4">
          <Empty>Nothing delivered in the last {s.periodDays} days.</Empty>
        </div>
      )}

      {data && s && s.loadCount > 0 && (
        <>
          <Headline summary={s} />
          <Payment payment={data.payment} />
          <Breakdowns
            costPerMile={s.costPerMileCents}
            tabs={[
              { id: 'broker', label: 'Broker', rows: data.byBroker, empty: 'No brokers on these loads.' },
              { id: 'lane', label: 'Lane', rows: data.byLane, empty: 'No lanes to show.' },
              { id: 'truck', label: 'Truck', rows: data.byTruck, empty: 'No trucks on these loads.' },
            ]}
          />
        </>
      )}

      <ImportedHistory />
    </div>
  );
}

/** How many rows show before "Show N more": enough to matter, not enough to bury the numbers. */
const VISIBLE = 4;

function NeedsAttention({ queue }: { queue: ActionQueue }) {
  const canBill = canWritePay(useSession()?.role);
  const [expanded, setExpanded] = useState(false);
  const items = actionItems(queue);
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, VISIBLE);

  return (
    <Card title={`Needs attention · ${items.length}`}>
      <ul className="divide-y divide-line">
        {shown.map((item) => (
          <li key={item.key} className="py-2.5">
            {item.kind === 'overdue' ? (
              <Link to="/pay/$invoiceId" params={{ invoiceId: item.invoiceId }} className="flex items-start justify-between gap-3 text-sm">
                <span>{item.text}</span>
                <span className="shrink-0 text-brand">Open ›</span>
              </Link>
            ) : canBill ? (
              <Link to="/pay/new" search={{ loadId: item.loadId }} className="flex items-start justify-between gap-3 text-sm">
                <span>{item.text}</span>
                <span className="shrink-0 text-brand">Invoice ›</span>
              </Link>
            ) : (
              <Link to="/loads/$loadId" params={{ loadId: item.loadId }} className="flex items-start justify-between gap-3 text-sm">
                <span>{item.text}</span>
                <span className="shrink-0 text-brand">Open ›</span>
              </Link>
            )}
          </li>
        ))}
      </ul>
      {items.length > VISIBLE && (
        <button type="button" className="hq-btn hq-btn-ghost mt-2 w-full text-sm" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show fewer' : `Show ${items.length - VISIBLE} more`}
        </button>
      )}
    </Card>
  );
}

/** A headline number. No plot, so nothing to hover. */
function Stat({ label, value, sub, tone = 'ink' }: { label: string; value: string; sub?: string; tone?: 'ink' | 'ok' | 'bad' }) {
  const color = tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : 'text-ink';
  return (
    <div className="hq-card p-3.5">
      <p className="field-label">{label}</p>
      <p className={`num mt-1 text-xl font-semibold ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-mute">{sub}</p>}
    </div>
  );
}

function Headline({ summary: s }: { summary: InsightsSummary }) {
  const vsCost = againstCost(s.revenuePerTotalMileCents, s.costPerMileCents);
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Revenue" value={wholeDollars(s.revenueCents)} sub={`${s.loadCount} ${s.loadCount === 1 ? 'load' : 'loads'}`} />
        <Stat
          label="Per total mile"
          value={perMile(s.revenuePerTotalMileCents)}
          sub={
            s.costPerMileCents === null
              ? 'set your cost per mile to compare'
              : vsCost
                ? `${vsCost.above ? 'above' : 'below'} your ${perMile(s.costPerMileCents)} cost`
                : `your cost is ${perMile(s.costPerMileCents)}`
          }
          tone={vsCost ? (vsCost.above ? 'ok' : 'bad') : 'ink'}
        />
        <Stat label="Per loaded mile" value={perMile(s.revenuePerLoadedMileCents)} sub="ignores empty miles" />
        <Stat
          label="Deadhead"
          value={s.deadheadRatio === null ? '—' : `${Math.round(s.deadheadRatio * 100)}%`}
          sub={`${s.deadheadMiles.toLocaleString('en-US')} of ${(s.loadedMiles + s.deadheadMiles).toLocaleString('en-US')} mi empty`}
        />
      </div>

      {s.measurableCount < s.loadCount && (
        <Note>
          {s.loadCount - s.measurableCount} of {s.loadCount} loads have no deadhead recorded, so they're left out of the
          per-total-mile figures rather than counted as zero empty miles.
        </Note>
      )}
      {s.factsReconciledAt === null && s.costPerMileCents !== null && (
        <p className="hq-card bg-warn-50 px-3 py-2.5 text-sm text-warn shadow-none">
          Your cost per mile is the figure you typed. It hasn't been checked against real loads yet.
        </p>
      )}
    </>
  );
}

function Payment({ payment: p }: { payment: PaymentPerformance }) {
  return (
    <Card title="Getting paid">
      {p.paidInvoiceCount === 0 ? (
        <Empty>Nothing paid in the last {p.periodDays} days yet.</Empty>
      ) : (
        <dl className="space-y-2.5">
          <Row
            label="Days to get paid"
            value={p.avgDaysToPayment === null ? '—' : p.avgDaysToPayment.toFixed(1)}
            sub={`average of ${p.paidInvoiceCount} paid`}
          />
          <Row
            label="Paid late"
            value={p.exceptionRate === null ? '—' : `${Math.round(p.exceptionRate * 100)}%`}
            sub={`${p.lateCount} of ${p.paidInvoiceCount}`}
            bad={p.exceptionRate !== null && p.exceptionRate > 0}
          />
          <Row label="Rejected by a factor" value={String(p.factoringRejectedCount)} bad={p.factoringRejectedCount > 0} />
        </dl>
      )}
    </Card>
  );
}

function Row({ label, value, sub, bad = false }: { label: string; value: string; sub?: string; bad?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm">
        {label}
        {sub && <span className="block text-xs text-mute">{sub}</span>}
      </dt>
      <dd className={`num text-lg font-semibold ${bad ? 'text-bad' : ''}`}>{value}</dd>
    </div>
  );
}

function Breakdowns({
  tabs,
  costPerMile,
}: {
  tabs: { id: string; label: string; rows: BreakdownRow[]; empty: string }[];
  costPerMile: number | null;
}) {
  const [active, setActive] = useState(tabs[0]!.id);
  const tab = tabs.find((t) => t.id === active) ?? tabs[0]!;
  const max = Math.max(0, ...tab.rows.map((r) => r.revenueCents));

  return (
    <section className="hq-card overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-4 pt-4">
        <h2 className="text-base text-mute">By</h2>
        <div className="grid flex-1 grid-cols-3 rounded-[var(--radius-sm)] bg-line/60 p-0.5" role="tablist" aria-label="Break down by">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === active}
              onClick={() => setActive(t.id)}
              className={`rounded-[8px] py-1 text-sm font-semibold ${t.id === active ? 'bg-card text-ink shadow-sm' : 'text-slate'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <div className="p-4">
        {tab.rows.length === 0 && <Empty>{tab.empty}</Empty>}
        <ul className="space-y-3.5">
          {tab.rows.map((row) => {
            const vs = againstCost(row.revenuePerTotalMileCents, costPerMile);
            const pct = max > 0 ? Math.max(2, Math.round((row.revenueCents / max) * 100)) : 0;
            return (
              <li key={row.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 break-words font-medium">{row.label}</span>
                  <span className="num shrink-0 font-semibold">{wholeDollars(row.revenueCents)}</span>
                </div>
                {/* Magnitude: one recessive hue, length only, 4px rounded data end. */}
                <span className="mt-1 block h-1.5 w-full rounded-full bg-wash" aria-hidden>
                  <span className="block h-full rounded-r-[4px] bg-ink" style={{ width: `${pct}%` }} />
                </span>
                <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-mute">
                  <span>
                    {row.loadCount} {row.loadCount === 1 ? 'load' : 'loads'}
                  </span>
                  <span className="num">{perMile(row.revenuePerTotalMileCents)}/total mi</span>
                  {vs && (
                    <span className={vs.above ? 'text-ok' : 'text-bad'}>
                      {vs.above ? 'above' : 'below'} cost by {perMile(vs.gapCents)}
                    </span>
                  )}
                  {row.revenuePerTotalMileCents === null && <span>no deadhead recorded</span>}
                  {row.basis !== 'actual' && <span>{row.basis === 'expected' ? 'estimated' : 'part estimated'}</span>}
                </p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/**
 * The imported load history, read-only. Importing stays on the web
 * (MOBILE_PARITY_PLAN.md section 6, decision 6); this is what it found.
 */
function ImportedHistory() {
  const history = useHistorySummary();
  const h = history.data;
  if (!h || h.loadCount === 0) return null;
  return (
    <Card title="Your imported history">
      <dl className="grid grid-cols-2 gap-3">
        <div>
          <dt className="field-label">Loads</dt>
          <dd className="num text-lg font-semibold">{h.loadCount.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt className="field-label">Days covered</dt>
          <dd className="num text-lg font-semibold">{h.periodDays.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt className="field-label">Revenue</dt>
          <dd className="num text-lg font-semibold">{wholeDollars(h.totalRevenueCents)}</dd>
        </div>
        <div>
          <dt className="field-label">Per mile</dt>
          <dd className="num text-lg font-semibold">{perMile(h.revenuePerMileCents)}</dd>
        </div>
      </dl>
    </Card>
  );
}
