/**
 * Autopilot's reads — what the delivered-to-paid loop looks at.
 * `FEATURE_REQUESTS_PLAN.md` section 8, piece 3.
 *
 * Read-only, and unscoped by `Scope` on purpose, the same shape
 * `findExceptionCandidates` in `repositories/track.ts` already has: a sweep
 * runs on a schedule across every org, not inside one org's request. Every
 * query below still takes an `orgId` and filters on it — the loop walks
 * orgs one at a time, so a bug in one carrier's pass cannot read another's
 * loads.
 *
 * Nothing here decides what to *do*. It answers "what is true right now",
 * with the deliberately conservative filters the safety of an unattended
 * loop depends on — see each function for what it refuses to return and
 * why.
 */

import { and, eq, inArray, isNull, lte, gte, sql } from 'drizzle-orm';
import type { Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { brokers } from '../schema/brokers.ts';
import { documents } from '../schema/documents.ts';
import { loadStops, loads } from '../schema/loads.ts';
import { factoringPackets, invoices, payments } from '../schema/pay.ts';
import { autonomySettings } from '../schema/outbound.ts';
import { carrierProfiles, orgs } from '../schema/tenancy.ts';

const DAY_MS = 86_400_000;

export interface AutopilotOrg {
  orgId: string;
  /** Who the message is signed as. */
  carrierName: string;
  mcNumber: string | null;
  /** Only the action types this pass asked about, and only ones the carrier explicitly set. */
  modes: Record<string, string>;
}

/**
 * Orgs that have *explicitly* configured at least one of `actions`.
 *
 * This is the opt-in. A carrier that has never touched autonomy settings
 * gets nothing — not even shadow drafts — because filling a stranger's
 * record with messages they never asked to see is not "safe by default",
 * it is noise. Setting an action to `shadow` is how a carrier starts
 * watching.
 */
export async function listAutopilotOrgs(db: Database, actions: string[]): Promise<AutopilotOrg[]> {
  const settings = await db
    .select({
      orgId: autonomySettings.orgId,
      actionType: autonomySettings.actionType,
      mode: autonomySettings.mode,
    })
    .from(autonomySettings)
    .where(and(inArray(autonomySettings.actionType, actions), isNull(autonomySettings.deletedAt)));
  if (settings.length === 0) return [];

  const orgIds = [...new Set(settings.map((r) => r.orgId))];
  const orgRows = await db
    .select({ id: orgs.id, name: orgs.name })
    .from(orgs)
    .where(and(inArray(orgs.id, orgIds), isNull(orgs.deletedAt)));
  const profiles = await db
    .select({
      orgId: carrierProfiles.orgId,
      legalName: carrierProfiles.legalName,
      dbaName: carrierProfiles.dbaName,
      mcNumber: carrierProfiles.mcNumber,
    })
    .from(carrierProfiles)
    .where(inArray(carrierProfiles.orgId, orgIds));

  const profileByOrg = new Map(profiles.map((p) => [p.orgId, p]));
  return orgRows.map((o) => {
    const profile = profileByOrg.get(o.id);
    return {
      orgId: o.id,
      carrierName: profile?.dbaName || profile?.legalName || o.name,
      mcNumber: profile?.mcNumber ?? null,
      modes: Object.fromEntries(settings.filter((r) => r.orgId === o.id).map((r) => [r.actionType, r.mode])),
    };
  });
}

// --- overdue invoices ---------------------------------------------------------

export interface OverdueInvoiceCandidate {
  invoiceId: string;
  reference: number;
  loadReference: number;
  brokerLoadNumber: string | null;
  brokerId: string;
  brokerName: string;
  brokerEmail: string;
  /** What is still owed — the total less anything already received. */
  outstandingCents: number;
  currency: string;
  dueAt: Date;
  daysOverdue: number;
}

/**
 * Sent invoices that are overdue and still owed, and safe to remind about.
 *
 * What it refuses to return, each for a reason:
 *  - **No `dueAt`.** No terms means no due date; inventing one (net-30)
 *    would tell a broker they are late against terms nobody agreed.
 *  - **Nothing outstanding.** Partial payments leave an invoice `sent`; a
 *    balance of zero is not a reminder.
 *  - **An invoice a factor has.** Once a packet is submitted, accepted or
 *    funded the broker owes the *factor*, and a carrier chasing the broker
 *    directly is wrong at best and a breach of the factoring agreement at
 *    worst.
 *  - **No broker email.** Nowhere to send it.
 *  - **Older than `maxDaysOverdue`.** Past that it is a collections
 *    conversation with a person, not a polite automated nudge.
 */
export async function findOverdueInvoices(
  db: Database,
  orgId: string,
  now: Date,
  window: { minDaysOverdue: number; maxDaysOverdue: number },
): Promise<OverdueInvoiceCandidate[]> {
  const latest = new Date(now.getTime() - window.minDaysOverdue * DAY_MS);
  const earliest = new Date(now.getTime() - window.maxDaysOverdue * DAY_MS);

  const rows = await db
    .select({
      invoiceId: invoices.id,
      reference: invoices.reference,
      totalCents: invoices.totalAmount,
      currency: invoices.totalCurrency,
      dueAt: invoices.dueAt,
      loadReference: loads.reference,
      brokerLoadNumber: loads.brokerLoadNumber,
      brokerId: brokers.id,
      brokerName: brokers.name,
      brokerEmail: brokers.email,
    })
    .from(invoices)
    .innerJoin(loads, eq(loads.id, invoices.loadId))
    .innerJoin(brokers, eq(brokers.id, loads.brokerId))
    .where(
      and(
        eq(invoices.orgId, orgId),
        eq(invoices.status, 'sent'),
        isNull(invoices.deletedAt),
        lte(invoices.dueAt, latest),
        gte(invoices.dueAt, earliest),
      ),
    );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.invoiceId);
  const received = await db
    .select({ invoiceId: payments.invoiceId, total: sql<number>`coalesce(sum(${payments.paymentAmount}), 0)::bigint` })
    .from(payments)
    .where(inArray(payments.invoiceId, ids))
    .groupBy(payments.invoiceId);
  const receivedBy = new Map(received.map((r) => [r.invoiceId, Number(r.total)]));

  const withFactor = await db
    .select({ invoiceId: factoringPackets.invoiceId })
    .from(factoringPackets)
    .where(
      and(
        inArray(factoringPackets.invoiceId, ids),
        inArray(factoringPackets.status, ['submitted', 'accepted', 'funded']),
      ),
    );
  const factored = new Set(withFactor.map((r) => r.invoiceId));

  const out: OverdueInvoiceCandidate[] = [];
  for (const r of rows) {
    if (!r.dueAt || !r.brokerEmail?.trim() || factored.has(r.invoiceId)) continue;
    const outstanding = r.totalCents - (receivedBy.get(r.invoiceId) ?? 0);
    if (outstanding <= 0) continue;
    out.push({
      invoiceId: r.invoiceId,
      reference: r.reference,
      loadReference: r.loadReference,
      brokerLoadNumber: r.brokerLoadNumber,
      brokerId: r.brokerId,
      brokerName: r.brokerName,
      brokerEmail: r.brokerEmail.trim(),
      outstandingCents: outstanding,
      currency: r.currency,
      dueAt: r.dueAt,
      daysOverdue: Math.floor((now.getTime() - r.dueAt.getTime()) / DAY_MS),
    });
  }
  return out;
}

// --- delivered, not invoiced --------------------------------------------------

export interface DeliveredUninvoicedCandidate {
  loadId: string;
  reference: number;
  brokerLoadNumber: string | null;
  brokerName: string;
  brokerEmail: string;
  /** The broker's agreed terms, when the carrier has them — stated on the invoice, never invented. */
  paymentTermsDays: number | null;
  origin: string;
  destination: string;
  deliveredAt: Date;
  rateCents: number;
  /** True when `rate` is linehaul only — accessorials are billed on top. */
  rateIsLinehaul: boolean;
  accessorialsCents: number;
  currency: string;
  /**
   * One document per kind, the earliest received, for documents on file that
   * were not rejected or quarantined — what an invoice email may attach.
   */
  documents: Array<{ id: string; kind: string }>;
}

/**
 * Delivered loads with no invoice yet, that have enough on file to invoice.
 *
 * Refuses a load with no rate (nothing to bill), no broker email (nowhere to
 * send), or that has any non-void invoice (already handled). Whether the
 * *amounts* are safe to derive automatically is decided by the caller —
 * that is a billing rule, not a query.
 *
 * `minHoursDelivered` is a grace period: a dispatcher who invoices on the
 * same afternoon should never find the system got there first.
 */
export async function findDeliveredUninvoiced(
  db: Database,
  orgId: string,
  now: Date,
  minHoursDelivered: number,
): Promise<DeliveredUninvoicedCandidate[]> {
  const cutoff = new Date(now.getTime() - minHoursDelivered * 3_600_000);

  const rows = await db
    .select({
      loadId: loads.id,
      reference: loads.reference,
      brokerLoadNumber: loads.brokerLoadNumber,
      brokerName: brokers.name,
      brokerEmail: brokers.email,
      paymentTermsDays: brokers.paymentTermsDays,
      deliveredAt: loads.deliveredAt,
      rateCents: loads.rateAmount,
      rateIsLinehaul: loads.rateIsLinehaul,
      accessorialsCents: loads.accessorialsAmount,
      currency: loads.rateCurrency,
    })
    .from(loads)
    .innerJoin(brokers, eq(brokers.id, loads.brokerId))
    .where(
      and(
        eq(loads.orgId, orgId),
        eq(loads.status, 'delivered'),
        isNull(loads.deletedAt),
        lte(loads.deliveredAt, cutoff),
        sql`not exists (select 1 from ${invoices} where ${invoices.loadId} = ${loads.id} and ${invoices.status} <> 'void')`,
      ),
    );
  if (rows.length === 0) return [];

  const loadIds = rows.map((r) => r.loadId);
  const stops = await db
    .select({ loadId: loadStops.loadId, seq: loadStops.seq, city: loadStops.city, state: loadStops.state })
    .from(loadStops)
    .where(inArray(loadStops.loadId, loadIds));
  const docs = await db
    .select({ id: documents.id, loadId: documents.loadId, kind: documents.kind, receivedAt: documents.receivedAt })
    .from(documents)
    .where(
      and(
        inArray(documents.loadId, loadIds),
        inArray(documents.status, ['received', 'classifying', 'extracting', 'extracted', 'validated']),
        isNull(documents.deletedAt),
      ),
    );

  const out: DeliveredUninvoicedCandidate[] = [];
  for (const r of rows) {
    if (!r.deliveredAt || !r.brokerEmail?.trim() || !r.rateCents || r.rateCents <= 0) continue;
    const loadStopsSorted = stops.filter((s) => s.loadId === r.loadId).sort((a, b) => a.seq - b.seq);
    const first = loadStopsSorted[0];
    const last = loadStopsSorted[loadStopsSorted.length - 1];
    out.push({
      loadId: r.loadId,
      reference: r.reference,
      brokerLoadNumber: r.brokerLoadNumber,
      brokerName: r.brokerName,
      brokerEmail: r.brokerEmail.trim(),
      paymentTermsDays: r.paymentTermsDays ?? null,
      origin: first ? `${first.city}, ${first.state}` : 'origin',
      destination: last ? `${last.city}, ${last.state}` : 'destination',
      deliveredAt: r.deliveredAt,
      rateCents: r.rateCents,
      rateIsLinehaul: r.rateIsLinehaul,
      accessorialsCents: r.accessorialsCents ?? 0,
      currency: r.currency ?? 'USD',
      documents: firstOfEachKind(docs.filter((d) => d.loadId === r.loadId)),
    });
  }
  return out;
}

// --- an invoice, as a document ------------------------------------------------

export interface InvoiceRenderFacts {
  invoiceId: string;
  reference: number;
  status: string;
  createdAt: Date;
  dueAt: Date | null;
  lineItems: Array<{ code: string; description: string; amountCents: number; currency: string }>;
  totalCents: number;
  currency: string;
  loadReference: number;
  brokerLoadNumber: string | null;
  origin: string;
  destination: string;
  deliveredAt: Date | null;
  brokerName: string | null;
  brokerEmail: string | null;
  paymentTermsDays: number | null;
  carrierName: string;
  mcNumber: string | null;
}

/**
 * Everything an invoice document says, in one read, scoped to the caller's
 * org — an invoice id from another carrier simply does not resolve.
 *
 * Rendered from the invoice's own snapshot (`lineItems`, `totalAmount`),
 * never re-derived from the load: an invoice is what was billed, and the
 * load's rate can change after it. Returns undefined rather than throwing,
 * so a caller can say "that attachment does not exist" in its own words.
 */
export async function getInvoiceRenderFacts(s: Scope, invoiceId: string): Promise<InvoiceRenderFacts | undefined> {
  const [row] = await s.db
    .select({
      invoiceId: invoices.id,
      reference: invoices.reference,
      status: invoices.status,
      createdAt: invoices.createdAt,
      dueAt: invoices.dueAt,
      lineItems: invoices.lineItems,
      totalCents: invoices.totalAmount,
      currency: invoices.totalCurrency,
      loadId: loads.id,
      loadReference: loads.reference,
      brokerLoadNumber: loads.brokerLoadNumber,
      deliveredAt: loads.deliveredAt,
      brokerName: brokers.name,
      brokerEmail: brokers.email,
      paymentTermsDays: brokers.paymentTermsDays,
      orgName: orgs.name,
    })
    .from(invoices)
    .innerJoin(loads, eq(loads.id, invoices.loadId))
    .innerJoin(orgs, eq(orgs.id, invoices.orgId))
    .leftJoin(brokers, eq(brokers.id, loads.brokerId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.orgId, s.ctx.orgId)));
  if (!row) return undefined;

  const stops = await s.db
    .select({ seq: loadStops.seq, city: loadStops.city, state: loadStops.state })
    .from(loadStops)
    .where(eq(loadStops.loadId, row.loadId));
  stops.sort((a, b) => a.seq - b.seq);

  const [profile] = await s.db
    .select({ legalName: carrierProfiles.legalName, dbaName: carrierProfiles.dbaName, mcNumber: carrierProfiles.mcNumber })
    .from(carrierProfiles)
    .where(eq(carrierProfiles.orgId, s.ctx.orgId));

  const first = stops[0];
  const last = stops[stops.length - 1];
  return {
    invoiceId: row.invoiceId,
    reference: row.reference,
    status: row.status,
    createdAt: row.createdAt,
    dueAt: row.dueAt,
    lineItems: row.lineItems as InvoiceRenderFacts['lineItems'],
    totalCents: row.totalCents,
    currency: row.currency,
    loadReference: row.loadReference,
    brokerLoadNumber: row.brokerLoadNumber,
    origin: first ? `${first.city}, ${first.state}` : '',
    destination: last ? `${last.city}, ${last.state}` : '',
    deliveredAt: row.deliveredAt,
    brokerName: row.brokerName,
    brokerEmail: row.brokerEmail,
    paymentTermsDays: row.paymentTermsDays,
    carrierName: profile?.dbaName || profile?.legalName || row.orgName,
    mcNumber: profile?.mcNumber ?? null,
  };
}

/** The earliest-received document of each kind — the original, not a later re-upload of it. */
function firstOfEachKind(
  docs: Array<{ id: string; kind: string; receivedAt: Date }>,
): Array<{ id: string; kind: string }> {
  const earliest = new Map<string, { id: string; kind: string; receivedAt: Date }>();
  for (const d of docs) {
    const known = earliest.get(d.kind);
    if (!known || d.receivedAt < known.receivedAt) earliest.set(d.kind, d);
  }
  return [...earliest.values()].map(({ id, kind }) => ({ id, kind }));
}
