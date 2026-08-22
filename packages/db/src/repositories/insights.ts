/**
 * Insights — what the loads actually made.
 *
 * Reads only. No new tables: `loads` was designed with this in mind and already
 * carries expected and actual for revenue, cost and margin.
 *
 * ---------------------------------------------------------------------------
 * Two things every query in here has to get right
 * ---------------------------------------------------------------------------
 *
 * **1. Actual first, expected second.** An imported load has
 * `actual_revenue_amount` and `actual_*_miles` and null `expected_*`, because
 * HaulQ never predicted them — the importer is explicit that writing imported
 * figures as predictions would fake a closed loop. A load HaulQ scored has the
 * opposite shape until it is reconciled. So every measure below coalesces
 * actual over expected, and `basis` reports which one a row is standing on.
 * Mixing them silently would make the expected-vs-actual gap — the number this
 * product is for — meaningless.
 *
 * **2. Rate per TOTAL mile, not per loaded mile.** $400 for 127 loaded miles is
 * $3.15/mi and looks excellent; the 176 empty miles to reach it make it
 * $1.32/mi, which is mediocre. Every per-mile figure here divides by loaded +
 * deadhead. The loaded-only figure is returned beside it, never instead of it.
 *
 * A load with no deadhead recorded is EXCLUDED from per-total-mile averages
 * rather than treated as zero deadhead. Treating unknown as zero produces the
 * flattering number by default, which is the failure this whole file exists to
 * avoid.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { loads } from '../schema/loads.ts';
import { factoringPackets, invoices } from '../schema/pay.ts';
import { carrierProfiles } from '../schema/tenancy.ts';

/** Revenue: what actually came in, falling back to what was agreed. */
const REVENUE = sql<number>`coalesce(${loads.actualRevenueAmount}, ${loads.rateAmount})`;
const LOADED = sql<number>`coalesce(${loads.actualLoadedMiles}, ${loads.expectedLoadedMiles})`;
const DEADHEAD = sql<number>`coalesce(${loads.actualDeadheadMiles}, ${loads.expectedDeadheadMiles})`;

/**
 * Rows that can carry a per-total-mile figure at all.
 *
 * Revenue, loaded miles and deadhead all present and positive. Deadhead may be
 * legitimately zero — a reload at the same dock — so it is checked for
 * null rather than for truthiness.
 */
const MEASURABLE = sql`${REVENUE} is not null and ${LOADED} > 0 and ${DEADHEAD} is not null`;

export interface InsightsWindow {
  /** Days back from now. Default 90 — the import's own horizon. */
  days?: number | undefined;
}

function since(days: number) {
  return sql`${loads.deliveredAt} >= now() - ${`${days} days`}::interval`;
}

/** Loads that count: delivered onward, not cancelled, not soft-deleted. */
function counted(s: Scope, days: number) {
  return and(
    eq(loads.orgId, s.ctx.orgId),
    isNull(loads.deletedAt),
    sql`${loads.status} in ('delivered','invoiced','paid')`,
    since(days),
  );
}

export interface InsightsSummary {
  loadCount: number;
  /** Loads with enough recorded to compute a per-total-mile figure. */
  measurableCount: number;
  revenueCents: number;
  loadedMiles: number;
  deadheadMiles: number;
  /** Minor units per mile. Null when nothing is measurable. */
  revenuePerTotalMileCents: number | null;
  revenuePerLoadedMileCents: number | null;
  /** Deadhead as a share of all miles run. The number a carrier can act on. */
  deadheadRatio: number | null;
  /** From operating facts, when set. What the per-mile figures are judged against. */
  costPerMileCents: number | null;
  factsReconciledAt: string | null;
  periodDays: number;
}

export async function insightsSummary(
  s: Scope,
  q: InsightsWindow = {},
): Promise<InsightsSummary> {
  const days = q.days ?? 90;

  const [row] = await s.db
    .select({
      loadCount: sql<number>`count(*)::int`,
      measurableCount: sql<number>`count(*) filter (where ${MEASURABLE})::int`,
      revenueCents: sql<number>`coalesce(sum(${REVENUE}), 0)::bigint`,
      loadedMiles: sql<number>`coalesce(sum(${LOADED}), 0)::int`,
      deadheadMiles: sql<number>`coalesce(sum(${DEADHEAD}), 0)::int`,
      // Summed then divided, not an average of per-load rates. Averaging the
      // rates weights a 70-mile run the same as a 700-mile one.
      measurableRevenue: sql<number>`coalesce(sum(${REVENUE}) filter (where ${MEASURABLE}), 0)::bigint`,
      measurableTotal: sql<number>`coalesce(sum(${LOADED} + ${DEADHEAD}) filter (where ${MEASURABLE}), 0)::int`,
      measurableLoaded: sql<number>`coalesce(sum(${LOADED}) filter (where ${MEASURABLE}), 0)::int`,
    })
    .from(loads)
    .where(counted(s, days));

  // Operating facts live on `carrier_profiles`, not on `orgs` — ADR-0002 split
  // them so a broker tenant, which has no MC number and no cost per mile, does
  // not carry columns that are mandatory for every real row of the other kind.
  const [profile] = await s.db
    .select({
      facts: carrierProfiles.operatingFacts,
      reconciledAt: carrierProfiles.operatingFactsReconciledAt,
    })
    .from(carrierProfiles)
    .where(eq(carrierProfiles.orgId, s.ctx.orgId));

  const facts = (profile?.facts ?? {}) as { costPerMileCents?: number };
  const r = row!;
  const totalMiles = Number(r.loadedMiles) + Number(r.deadheadMiles);

  return {
    loadCount: Number(r.loadCount),
    measurableCount: Number(r.measurableCount),
    revenueCents: Number(r.revenueCents),
    loadedMiles: Number(r.loadedMiles),
    deadheadMiles: Number(r.deadheadMiles),
    revenuePerTotalMileCents:
      Number(r.measurableTotal) > 0
        ? Math.round(Number(r.measurableRevenue) / Number(r.measurableTotal))
        : null,
    revenuePerLoadedMileCents:
      Number(r.measurableLoaded) > 0
        ? Math.round(Number(r.measurableRevenue) / Number(r.measurableLoaded))
        : null,
    deadheadRatio: totalMiles > 0 ? Number(r.deadheadMiles) / totalMiles : null,
    costPerMileCents: facts.costPerMileCents ?? null,
    factsReconciledAt: profile?.reconciledAt?.toISOString() ?? null,
    periodDays: days,
  };
}

export interface BreakdownRow {
  key: string;
  label: string;
  loadCount: number;
  revenueCents: number;
  totalMiles: number;
  revenuePerTotalMileCents: number | null;
  /** Which columns the figures came from, so the UI can say so. */
  basis: 'actual' | 'expected' | 'mixed';
}

/**
 * One shape for every breakdown.
 *
 * Broker, lane and truck differ only in what they group by, and writing three
 * near-identical queries is how they drift apart — one gets the deadhead fix
 * and the others do not.
 */
async function breakdown(
  s: Scope,
  days: number,
  groupExpr: ReturnType<typeof sql>,
  labelExpr: ReturnType<typeof sql>,
  limit: number,
): Promise<BreakdownRow[]> {
  const rows = await s.db
    .select({
      key: sql<string>`${groupExpr}`,
      label: sql<string>`${labelExpr}`,
      loadCount: sql<number>`count(*)::int`,
      revenueCents: sql<number>`coalesce(sum(${REVENUE}), 0)::bigint`,
      measurableRevenue: sql<number>`coalesce(sum(${REVENUE}) filter (where ${MEASURABLE}), 0)::bigint`,
      measurableTotal: sql<number>`coalesce(sum(${LOADED} + ${DEADHEAD}) filter (where ${MEASURABLE}), 0)::int`,
      totalMiles: sql<number>`coalesce(sum(${LOADED} + coalesce(${DEADHEAD}, 0)), 0)::int`,
      actualCount: sql<number>`count(*) filter (where ${loads.actualRevenueAmount} is not null)::int`,
    })
    .from(loads)
    .where(counted(s, days))
    .groupBy(groupExpr, labelExpr)
    .orderBy(sql`coalesce(sum(${REVENUE}), 0) desc`)
    .limit(limit);

  return rows.map((r) => {
    const n = Number(r.loadCount);
    const actual = Number(r.actualCount);
    return {
      key: String(r.key ?? 'unknown'),
      label: String(r.label ?? 'Unknown'),
      loadCount: n,
      revenueCents: Number(r.revenueCents),
      totalMiles: Number(r.totalMiles),
      revenuePerTotalMileCents:
        Number(r.measurableTotal) > 0
          ? Math.round(Number(r.measurableRevenue) / Number(r.measurableTotal))
          : null,
      basis: actual === n ? 'actual' : actual === 0 ? 'expected' : 'mixed',
    };
  });
}

export async function revenueByBroker(s: Scope, q: InsightsWindow & { limit?: number } = {}) {
  return breakdown(
    s,
    q.days ?? 90,
    sql`coalesce(${loads.brokerId}::text, 'none')`,
    // `loads.broker_id` is literal SQL text, not `${loads.brokerId}` — same
    // reasoning `loadMargin` documents above: with a single-table
    // `.from(loads)`, drizzle renders an interpolated column reference
    // unqualified, and `brokers` has no column literally named `broker_id`.
    // Unlike `loadMargin`'s version of this bug, `brokers` has nothing for
    // the bare identifier to resolve to at all, so this was not a silent
    // wrong answer — it was `column "broker_id" does not exist` on every
    // call, which is the 500 a carrier actually saw on Insights.
    sql`coalesce((select b.name from brokers b where b.id = loads.broker_id), 'No broker recorded')`,
    q.limit ?? 15,
  );
}

/**
 * Lanes, grouped state-to-state rather than city-to-city.
 *
 * A carrier runs Wichita→OKC and Wichita→Norman as the same commercial lane. At
 * city granularity a 90-day history produces forty groups of one load each,
 * which tells nobody anything.
 */
export async function revenueByLane(s: Scope, q: InsightsWindow & { limit?: number } = {}) {
  // `loads.id` literal, not `${loads.id}` — here `load_stops` *does* have its
  // own `id` column, so this was `loadMargin`'s exact failure mode: a silent
  // `st.load_id = st.id` that never matches, rather than a thrown error.
  // Every lane read back as "?? → ??" instead of a state pair.
  const origin = sql`(select st.state from load_stops st where st.load_id = loads.id and st.type = 'pickup' order by st.seq limit 1)`;
  const dest = sql`(select st.state from load_stops st where st.load_id = loads.id and st.type = 'delivery' order by st.seq desc limit 1)`;
  const lane = sql`coalesce(${origin}, '??') || ' → ' || coalesce(${dest}, '??')`;

  return breakdown(s, q.days ?? 90, lane, lane, q.limit ?? 15);
}

export async function revenueByTruck(s: Scope, q: InsightsWindow & { limit?: number } = {}) {
  return breakdown(
    s,
    q.days ?? 90,
    sql`coalesce(${loads.truckId}::text, 'none')`,
    // Literal `loads.truck_id`, same reasoning as `revenueByBroker` above —
    // `trucks` has no column named `truck_id` either.
    sql`coalesce((select t.label from trucks t where t.id = loads.truck_id), 'No truck recorded')`,
    q.limit ?? 15,
  );
}

// ---------------------------------------------------------------------------
// Per-load detail
// ---------------------------------------------------------------------------
//
// PHASE_1_PLAN.md section 4, item 1: the one gap in this file that was never
// blocked on Pay — a single-row read using the columns already on `loads`,
// not a new aggregation engine. Named here rather than in Pay's own
// repository because it is Insights' question ("what did this load make"),
// answered with a Pay fact (the invoice) folded in.

export interface LoadMargin {
  loadId: string;
  reference: number;
  revenueCents: number | null;
  loadedMiles: number | null;
  deadheadMiles: number | null;
  revenuePerTotalMileCents: number | null;
  revenuePerLoadedMileCents: number | null;
  /** Single load, so this is binary — "mixed" only means anything across a
   *  group of loads, which `BreakdownRow.basis` already covers. */
  basis: 'actual' | 'expected';
  /** The load's current open invoice, if it has one. Null either side means
   *  no invoice has been generated yet, not that one failed. */
  invoiceStatus: string | null;
  invoiceTotalCents: number | null;
}

export async function loadMargin(s: Scope, loadId: string): Promise<LoadMargin | undefined> {
  const [row] = await s.db
    .select({
      reference: loads.reference,
      revenueCents: REVENUE,
      loadedMiles: LOADED,
      deadheadMiles: DEADHEAD,
      isActual: sql<boolean>`${loads.actualRevenueAmount} is not null`,
      // A scalar subquery rather than a join: `invoices_load_key` guarantees
      // at most one non-void invoice per load, so this can never multiply
      // the row the way a join risks if that constraint is ever loosened.
      //
      // `loads.id` is written as literal SQL text, not `${loads.id}`: with a
      // single-table `.from(loads)`, drizzle renders an interpolated column
      // reference unqualified (bare `"id"`), and inside this correlated
      // subquery that bare identifier resolves to `invoices.id` — the
      // subquery's own closer scope — not the outer load's id. The
      // condition silently becomes `i.load_id = i.id`, which never matches,
      // and every load reads back with no invoice. Caught by
      // `insights.test.ts`'s `loadMargin` suite against real Postgres;
      // `tsc` has no way to see it since the generated SQL is only wrong at
      // runtime.
      invoiceStatus: sql<string | null>`(select i.status from invoices i where i.load_id = loads.id and i.status <> 'void' limit 1)`,
      invoiceTotalCents: sql<number | null>`(select i.total_amount from invoices i where i.load_id = loads.id and i.status <> 'void' limit 1)`,
    })
    .from(loads)
    .where(and(eq(loads.orgId, s.ctx.orgId), eq(loads.id, loadId), isNull(loads.deletedAt)))
    .limit(1);

  if (!row) return undefined;

  const revenueCents = row.revenueCents === null ? null : Number(row.revenueCents);
  const loadedMiles = row.loadedMiles === null ? null : Number(row.loadedMiles);
  const deadheadMiles = row.deadheadMiles === null ? null : Number(row.deadheadMiles);
  const measurable = revenueCents !== null && loadedMiles !== null && loadedMiles > 0 && deadheadMiles !== null;

  return {
    loadId,
    reference: row.reference,
    revenueCents,
    loadedMiles,
    deadheadMiles,
    revenuePerTotalMileCents: measurable
      ? Math.round(revenueCents! / (loadedMiles! + deadheadMiles!))
      : null,
    revenuePerLoadedMileCents:
      revenueCents !== null && loadedMiles ? Math.round(revenueCents / loadedMiles) : null,
    basis: row.isActual ? 'actual' : 'expected',
    invoiceStatus: row.invoiceStatus,
    invoiceTotalCents: row.invoiceTotalCents === null ? null : Number(row.invoiceTotalCents),
  };
}

// ---------------------------------------------------------------------------
// Payment speed and exceptions
// ---------------------------------------------------------------------------
//
// PHASE_1_PLAN.md section 4, item 3: "entirely gated on 1b — there is nothing
// to measure until an invoice has a paid date." Pay now writes `sentAt` and
// `paidAt`, so this reads them rather than aggregating anything new on the
// load side.

export interface PaymentPerformance {
  /** Invoices that reached `paid` within the window. */
  paidInvoiceCount: number;
  /** Days from `sentAt` to `paidAt`, averaged. Null with nothing paid yet. */
  avgDaysToPayment: number | null;
  /** Paid, but after `dueAt`. Invoices with no due date can't be late. */
  lateCount: number;
  /** `lateCount / paidInvoiceCount`. The single number for "how often does
   *  this go wrong" — not currently-overdue invoices, which is what
   *  `receivablesAging` in Pay already answers. */
  exceptionRate: number | null;
  /** Factoring submissions a factor turned down in the window — a different
   *  kind of exception, kept separate rather than folded into one rate that
   *  would average two unrelated failure modes together. */
  factoringRejectedCount: number;
  periodDays: number;
}

export async function paymentPerformance(
  s: Scope,
  q: InsightsWindow = {},
): Promise<PaymentPerformance> {
  const days = q.days ?? 90;

  const [row] = await s.db
    .select({
      paidCount: sql<number>`count(*)::int`,
      avgDays: sql<string | null>`avg(extract(epoch from (${invoices.paidAt} - ${invoices.sentAt})) / 86400)`,
      lateCount: sql<number>`count(*) filter (where ${invoices.dueAt} is not null and ${invoices.paidAt} > ${invoices.dueAt})::int`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.orgId, s.ctx.orgId),
        eq(invoices.status, 'paid'),
        sql`${invoices.paidAt} >= now() - ${`${days} days`}::interval`,
      ),
    );

  const [rejected] = await s.db
    .select({ n: sql<number>`count(*)::int` })
    .from(factoringPackets)
    .where(
      and(
        eq(factoringPackets.orgId, s.ctx.orgId),
        eq(factoringPackets.status, 'rejected'),
        sql`${factoringPackets.respondedAt} >= now() - ${`${days} days`}::interval`,
      ),
    );

  const paidInvoiceCount = Number(row?.paidCount ?? 0);
  const lateCount = Number(row?.lateCount ?? 0);

  return {
    paidInvoiceCount,
    avgDaysToPayment: row?.avgDays != null ? Number(row.avgDays) : null,
    lateCount,
    exceptionRate: paidInvoiceCount > 0 ? lateCount / paidInvoiceCount : null,
    factoringRejectedCount: Number(rejected?.n ?? 0),
    periodDays: days,
  };
}
