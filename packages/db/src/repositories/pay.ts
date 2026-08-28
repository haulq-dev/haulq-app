/**
 * HaulQ Pay — invoices, factoring, payments.
 *
 * PHASE_1_PLAN.md section 5's exit gate, split into what each function does:
 * `generateInvoice` produces the invoice with the right numbers on it,
 * `assembleFactoringPacket`/`submitFactoringPacket`/`recordFactoringResponse`
 * carry it through a factor, and `recordPayment` is where money becomes
 * known — which is also where this file touches `loads`.
 *
 * ---------------------------------------------------------------------------
 * What "the load's actual_cost/actual_margin written once money is known"
 * (plan section 5) means here, and what it does not
 * ---------------------------------------------------------------------------
 *
 * This file writes `loads.actualRevenueAmount` once an invoice is fully
 * paid — the invoice total is the authoritative, reconciled figure for what
 * the load actually earned, superseding the `rate` it was booked at.
 *
 * It does not write `actualCost` or `actualMargin`. Both need the carrier's
 * real operating cost for this specific load (fuel, tolls, driver pay), and
 * nothing in this phase's four tables produces that — the marketing page's
 * "expenses from fuel cards, tolls and maintenance" is a different feature
 * with its own table, not built here. Writing a partial or guessed cost
 * into a column Insights already treats as "the only honest number" (see
 * `schema/loads.ts` decision 3) would be worse than leaving it null: a wrong
 * `actualMargin` reads as reconciled and is not. `testing.ts`'s
 * `setLoadActualsForTest` comment — "no repository function does this
 * outside the CSV importer" — is now half true; update it if `actualCost`
 * ever gains a real writer.
 *
 * ---------------------------------------------------------------------------
 * The state machines the database owns, and what this file owns instead
 * ---------------------------------------------------------------------------
 *
 * Same split as `loads.ts`: `sql/post/0700_invoice_status.sql` forbids an
 * invoice moving backwards or leaving `void` from `paid`, so nothing here
 * duplicates that check — a constraint violation is a raw Postgres error,
 * translated at the route, same as `LoadError`'s module note describes.
 * What this file owns is the parts the database cannot infer: which
 * timestamp a transition implies, whether an invoice's payments now cover
 * its total, and — the one cross-cutting rule — that `loads.status` moves
 * to `invoiced` and `paid` through `updateLoadStatus`, not a second copy of
 * that state machine living here.
 */

import { and, asc, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { decodeCursor, toCursorPage, type CursorPage } from '../pagination.ts';
import { brokers } from '../schema/brokers.ts';
import { loads } from '../schema/loads.ts';
import {
  factoringCompanies,
  factoringPackets,
  invoices,
  payments,
} from '../schema/pay.ts';
import { withTransaction } from '../transaction.ts';
import { updateLoadStatus } from './loads.ts';

export type Invoice = typeof invoices.$inferSelect;
export type InvoiceStatus = Invoice['status'];
export type FactoringCompany = typeof factoringCompanies.$inferSelect;
export type FactoringPacket = typeof factoringPackets.$inferSelect;
export type FactoringPacketStatus = FactoringPacket['status'];
export type Payment = typeof payments.$inferSelect;

/**
 * Raised for a rule this file enforces rather than the database. Same
 * contract as `LoadError`/`DocumentError`: `message` is for the log,
 * `explanation` is the sentence a carrier should read.
 */
export class PayError extends Error {
  readonly code: string;
  readonly explanation: string;

  constructor(code: string, message: string, explanation: string) {
    super(message);
    this.name = 'PayError';
    this.code = code;
    this.explanation = explanation;
  }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export interface InvoiceLineItemInput {
  code: string;
  description: string;
  amountCents: number;
  currency?: string | undefined;
}

export interface GenerateInvoiceInput {
  loadId: string;
  lineItems: InvoiceLineItemInput[];
  /** The document Pay read to produce this. See `schema/pay.ts`'s note. */
  sourceDocumentId?: string | undefined;
  /** Overrides the due date computed from the broker's payment terms. */
  dueAt?: string | undefined;
}

/** The load facts invoicing needs: its reference, and its broker's terms. */
async function loadForInvoicing(
  s: Scope,
  loadId: string,
): Promise<{ reference: number; paymentTermsDays: number | null }> {
  const [row] = await s.db
    .select({
      reference: loads.reference,
      paymentTermsDays: brokers.paymentTermsDays,
    })
    .from(loads)
    .leftJoin(brokers, eq(brokers.id, loads.brokerId))
    .where(and(eq(loads.orgId, s.ctx.orgId), eq(loads.id, loadId)))
    .limit(1);

  if (!row) {
    throw new PayError(
      'load_not_found',
      `no load ${loadId} in org ${s.ctx.orgId}`,
      'That load is not in this account.',
    );
  }
  return row;
}

/**
 * Generate an invoice from a load and its line items.
 *
 * Refuses a second open invoice for a load with a friendly error rather than
 * letting `invoices_load_key` reject it — the partial unique index is the
 * enforcement, this is the message. A load already carrying a voided
 * invoice is not "already invoiced"; the index's own `where status <> 'void'`
 * is what makes reissuing possible, and this check has to agree with it.
 */
export async function generateInvoice(
  s: Scope,
  input: GenerateInvoiceInput,
): Promise<Invoice> {
  if (input.lineItems.length === 0) {
    throw new PayError(
      'no_line_items',
      'invoice generated with no line items',
      'An invoice needs at least one line item.',
    );
  }

  const currency = input.lineItems[0]!.currency ?? 'USD';
  for (const item of input.lineItems) {
    if ((item.currency ?? 'USD') !== currency) {
      throw new PayError(
        'mixed_currency',
        'line items span more than one currency',
        'All line items on one invoice must be in the same currency.',
      );
    }
  }
  const totalAmount = input.lineItems.reduce((sum, item) => sum + item.amountCents, 0);

  return withTransaction(s, async (tx) => {
    const load = await loadForInvoicing(tx, input.loadId);

    const [open] = await tx.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.orgId, tx.ctx.orgId),
          eq(invoices.loadId, input.loadId),
          sql`${invoices.status} <> 'void'`,
        ),
      )
      .limit(1);
    if (open) {
      throw new PayError(
        'already_invoiced',
        `load ${input.loadId} already has an open invoice`,
        'That load already has an invoice. Void it before generating another.',
      );
    }

    const dueAt = input.dueAt
      ? new Date(input.dueAt)
      : load.paymentTermsDays != null
        ? new Date(Date.now() + load.paymentTermsDays * 86_400_000)
        : null;

    const [row] = await tx.db
      .insert(invoices)
      .values({
        orgId: tx.ctx.orgId,
        loadId: input.loadId,
        sourceDocumentId: input.sourceDocumentId ?? null,
        lineItems: input.lineItems.map((item) => ({
          code: item.code,
          description: item.description,
          amountCents: item.amountCents,
          currency: item.currency ?? currency,
        })),
        totalAmount,
        totalCurrency: currency,
        ...(dueAt ? { dueAt } : {}),
      })
      .returning();
    if (!row) throw new Error('invoice insert returned nothing');

    await recordEvent(tx, 'invoice.generated', {
      subjectId: row.id,
      payload: {
        reference: row.reference,
        loadReference: load.reference,
        totalAmount: row.totalAmount,
        totalCurrency: row.totalCurrency,
      },
    });

    return row;
  });
}

/** Fetch an invoice for writing, or say why not. Void is terminal. */
async function invoiceForUpdate(s: Scope, id: string, action: string): Promise<Invoice> {
  const [row] = await s.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.orgId, s.ctx.orgId), eq(invoices.id, id)))
    .limit(1);
  if (!row) {
    throw new PayError(
      'not_found',
      `no invoice ${id} in org ${s.ctx.orgId}`,
      'That invoice is not in this account.',
    );
  }
  if (row.status === 'void') {
    throw new PayError(
      'void',
      `refusing to ${action} void invoice ${id}`,
      'That invoice was voided. Generate a new one instead.',
    );
  }
  return row;
}

/**
 * Hand a draft invoice to the broker or factor.
 *
 * Also moves the load to `invoiced` — through `updateLoadStatus`, so the
 * event it fires and the timestamp it fills in are the same ones every other
 * caller of that function gets, not a parallel copy that can drift.
 */
export async function sendInvoice(s: Scope, invoiceId: string): Promise<Invoice> {
  return withTransaction(s, async (tx) => {
    const existing = await invoiceForUpdate(tx, invoiceId, 'send');
    if (existing.status !== 'draft') {
      throw new PayError(
        'not_draft',
        `invoice ${invoiceId} is ${existing.status}, not draft`,
        'Only a draft invoice can be sent.',
      );
    }

    const load = await loadForInvoicing(tx, existing.loadId);

    const [row] = await tx.db
      .update(invoices)
      .set({ status: 'sent', sentAt: new Date() })
      .where(and(eq(invoices.orgId, tx.ctx.orgId), eq(invoices.id, invoiceId)))
      .returning();
    if (!row) throw new Error('invoice send returned nothing');

    await recordEvent(tx, 'invoice.sent', {
      subjectId: row.id,
      payload: {
        reference: row.reference,
        loadReference: load.reference,
        totalAmount: row.totalAmount,
        totalCurrency: row.totalCurrency,
      },
    });

    await updateLoadStatus(tx, existing.loadId, { status: 'invoiced' });

    return row;
  });
}

/**
 * Void an invoice. The trigger refuses this once `status = 'paid'` — see the
 * module note — so nothing here re-checks that; the Postgres error is
 * translated at the route.
 */
export async function voidInvoice(
  s: Scope,
  invoiceId: string,
  reason: string,
): Promise<Invoice> {
  if (!reason.trim()) {
    throw new PayError(
      'reason_required',
      'invoice voided without a reason',
      'Say why this invoice is being voided — the timeline records it.',
    );
  }

  return withTransaction(s, async (tx) => {
    await invoiceForUpdate(tx, invoiceId, 'void');

    const [row] = await tx.db
      .update(invoices)
      .set({ status: 'void', voidedAt: new Date(), voidReason: reason })
      .where(and(eq(invoices.orgId, tx.ctx.orgId), eq(invoices.id, invoiceId)))
      .returning();
    if (!row) throw new Error('invoice void returned nothing');

    await recordEvent(tx, 'invoice.voided', {
      subjectId: row.id,
      payload: { reference: row.reference, reason },
    });

    return row;
  });
}

// ---------------------------------------------------------------------------
// Factoring
// ---------------------------------------------------------------------------

export interface CreateFactoringCompanyInput {
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
  submissionMethod?: 'email' | 'portal' | 'api' | undefined;
  notes?: string | undefined;
}

export async function createFactoringCompany(
  s: Scope,
  input: CreateFactoringCompanyInput,
): Promise<FactoringCompany> {
  return withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .insert(factoringCompanies)
      .values({
        orgId: tx.ctx.orgId,
        name: input.name.trim(),
        email: input.email ?? null,
        phone: input.phone ?? null,
        submissionMethod: input.submissionMethod ?? 'email',
        notes: input.notes ?? null,
      })
      .returning();
    if (!row) throw new Error('factoring company insert returned nothing');

    await recordEvent(tx, 'factoring_company.added', {
      subjectId: row.id,
      payload: { name: row.name },
    });

    return row;
  });
}

export interface ListFactoringCompaniesQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** Alphabetical, cursor-paginated on `(name, id)` — see `pagination.ts`. */
export async function listFactoringCompanies(
  s: Scope,
  q: ListFactoringCompaniesQuery = {},
): Promise<CursorPage<FactoringCompany>> {
  const conditions = [eq(factoringCompanies.orgId, s.ctx.orgId), eq(factoringCompanies.active, true)];
  if (q.cursor) {
    const cursor = decodeCursor(q.cursor);
    const cursorName = String(cursor.v);
    conditions.push(
      or(
        gt(factoringCompanies.name, cursorName),
        and(eq(factoringCompanies.name, cursorName), gt(factoringCompanies.id, cursor.id)),
      )!,
    );
  }

  const limit = Math.min(q.limit ?? 50, 200);
  const rows = await s.db
    .select()
    .from(factoringCompanies)
    .where(and(...conditions))
    .orderBy(asc(factoringCompanies.name), asc(factoringCompanies.id))
    .limit(limit);

  return toCursorPage(rows, limit, (row) => ({ v: row.name, id: row.id }));
}

/** An invoice's reference and its factor's name, for a packet's sentences. */
async function packetContext(
  s: Scope,
  packet: FactoringPacket,
): Promise<{ invoiceReference: number; factoringCompanyName: string }> {
  const [invoice] = await s.db
    .select({ reference: invoices.reference })
    .from(invoices)
    .where(eq(invoices.id, packet.invoiceId))
    .limit(1);
  const [factor] = await s.db
    .select({ name: factoringCompanies.name })
    .from(factoringCompanies)
    .where(eq(factoringCompanies.id, packet.factoringCompanyId))
    .limit(1);

  return {
    invoiceReference: invoice?.reference ?? 0,
    factoringCompanyName: factor?.name ?? 'the factor',
  };
}

export interface AssembleFactoringPacketInput {
  invoiceId: string;
  factoringCompanyId: string;
  /** Which of the load's `documents` rows to bundle. See `schema/pay.ts`. */
  documentIds: string[];
}

/**
 * Start assembling a submission. A new row every time, even resubmitting the
 * same invoice to the same factor after a rejection — see the schema note on
 * why a resubmission is not an edit.
 */
export async function assembleFactoringPacket(
  s: Scope,
  input: AssembleFactoringPacketInput,
): Promise<FactoringPacket> {
  return withTransaction(s, async (tx) => {
    const invoice = await invoiceForUpdate(tx, input.invoiceId, 'assemble a factoring packet for');

    const [factor] = await tx.db
      .select({ id: factoringCompanies.id, name: factoringCompanies.name })
      .from(factoringCompanies)
      .where(
        and(
          eq(factoringCompanies.orgId, tx.ctx.orgId),
          eq(factoringCompanies.id, input.factoringCompanyId),
        ),
      )
      .limit(1);
    if (!factor) {
      throw new PayError(
        'factoring_company_not_found',
        `no factoring company ${input.factoringCompanyId} in org ${tx.ctx.orgId}`,
        'That factoring company is not in this account.',
      );
    }

    const [row] = await tx.db
      .insert(factoringPackets)
      .values({
        orgId: tx.ctx.orgId,
        invoiceId: invoice.id,
        factoringCompanyId: factor.id,
        documentIds: input.documentIds,
      })
      .returning();
    if (!row) throw new Error('factoring packet insert returned nothing');

    await recordEvent(tx, 'factoring_packet.assembled', {
      subjectId: row.id,
      payload: {
        invoiceReference: invoice.reference,
        factoringCompanyName: factor.name,
        documentCount: input.documentIds.length,
      },
    });

    return row;
  });
}

async function packetForUpdate(
  s: Scope,
  id: string,
  action: string,
): Promise<FactoringPacket> {
  const [row] = await s.db
    .select()
    .from(factoringPackets)
    .where(and(eq(factoringPackets.orgId, s.ctx.orgId), eq(factoringPackets.id, id)))
    .limit(1);
  if (!row) {
    throw new PayError(
      'not_found',
      `no factoring packet ${id} in org ${s.ctx.orgId}`,
      'That factoring packet is not in this account.',
    );
  }
  if (row.status === 'funded' || row.status === 'rejected') {
    throw new PayError(
      'terminal',
      `refusing to ${action} ${row.status} factoring packet ${id}`,
      row.status === 'funded'
        ? 'That packet is already funded.'
        : 'That packet was rejected. Assemble a new one to resubmit.',
    );
  }
  return row;
}

/**
 * Mark a packet sent. See the event catalogue's note on `factoring_packet.submitted`'s
 * `topic`: this phase does not build the consumer that would email it, so
 * "submitted" today means a person did it — the carrier reviewed the
 * assembled packet and sent it themselves. The row and the state machine do
 * not know the difference, which is the point: an API integration slots in
 * later without a schema change.
 */
export async function submitFactoringPacket(
  s: Scope,
  packetId: string,
): Promise<FactoringPacket> {
  return withTransaction(s, async (tx) => {
    const packet = await packetForUpdate(tx, packetId, 'submit');
    if (packet.status !== 'assembling') {
      throw new PayError(
        'not_assembling',
        `packet ${packetId} is ${packet.status}, not assembling`,
        'That packet has already been submitted.',
      );
    }
    const context = await packetContext(tx, packet);

    const [row] = await tx.db
      .update(factoringPackets)
      .set({ status: 'submitted', submittedAt: new Date() })
      .where(and(eq(factoringPackets.orgId, tx.ctx.orgId), eq(factoringPackets.id, packetId)))
      .returning();
    if (!row) throw new Error('factoring packet submit returned nothing');

    await recordEvent(tx, 'factoring_packet.submitted', {
      subjectId: row.id,
      payload: context,
    });

    return row;
  });
}

export interface FactoringResponseInput {
  outcome: 'accepted' | 'rejected';
  /** Required when `outcome` is `'rejected'` — the carrier is going to ask. */
  reason?: string | undefined;
}

/** Record what the factor said about a submitted packet. */
export async function recordFactoringResponse(
  s: Scope,
  packetId: string,
  input: FactoringResponseInput,
): Promise<FactoringPacket> {
  if (input.outcome === 'rejected' && !input.reason?.trim()) {
    throw new PayError(
      'reason_required',
      'factoring rejection recorded without a reason',
      'Say why the factor rejected this packet.',
    );
  }

  return withTransaction(s, async (tx) => {
    const packet = await packetForUpdate(tx, packetId, 'record a response for');
    if (packet.status !== 'submitted') {
      throw new PayError(
        'not_submitted',
        `packet ${packetId} is ${packet.status}, not submitted`,
        'That packet has not been submitted yet.',
      );
    }
    const context = await packetContext(tx, packet);

    const [row] = await tx.db
      .update(factoringPackets)
      .set({
        status: input.outcome,
        respondedAt: new Date(),
        ...(input.outcome === 'rejected' ? { rejectionReason: input.reason } : {}),
      })
      .where(and(eq(factoringPackets.orgId, tx.ctx.orgId), eq(factoringPackets.id, packetId)))
      .returning();
    if (!row) throw new Error('factoring packet response returned nothing');

    if (input.outcome === 'accepted') {
      await recordEvent(tx, 'factoring_packet.accepted', { subjectId: row.id, payload: context });
    } else {
      await recordEvent(tx, 'factoring_packet.rejected', {
        subjectId: row.id,
        payload: { ...context, reason: input.reason! },
      });
    }

    return row;
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface RecordPaymentInput {
  invoiceId: string;
  amountCents: number;
  /** Defaults to the invoice's own currency. */
  currency?: string | undefined;
  source: Payment['source'];
  /** Overrides `now()`, for a deposit recorded the day after it cleared. */
  receivedAt?: string | undefined;
  reference?: string | undefined;
  notes?: string | undefined;
  /** When this money settles a specific submission — see `schema/pay.ts`. */
  factoringPacketId?: string | undefined;
}

export interface RecordPaymentResult {
  payment: Payment;
  /** Reflects the `paid` transition if this payment completed the invoice. */
  invoice: Invoice;
}

/**
 * Record money received against an invoice.
 *
 * The one function in this file with three consequences, all in one
 * transaction because they are one fact: a payment lands, an invoice may
 * become fully paid, and if it does the load moves to `paid` and its
 * `actualRevenue` is set. Splitting these across separate calls would let a
 * caller record the payment and forget the rest, which is exactly the kind
 * of gap `documents.ts`'s validate/extract split warns against — so it does
 * not happen here even though the three things are logically separable.
 *
 * `factoringPacketId`, when given, also flips that packet to `funded` — see
 * `schema/pay.ts`'s note on why this is what makes `funded` an observed fact
 * rather than a guess.
 */
export async function recordPayment(
  s: Scope,
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  return withTransaction(s, async (tx) => {
    const invoice = await invoiceForUpdate(tx, input.invoiceId, 'record a payment against');
    if (invoice.status === 'draft') {
      throw new PayError(
        'not_sent',
        `payment recorded against draft invoice ${input.invoiceId}`,
        'Send the invoice before recording a payment against it.',
      );
    }

    const currency = input.currency ?? invoice.totalCurrency;

    const [payment] = await tx.db
      .insert(payments)
      .values({
        orgId: tx.ctx.orgId,
        invoiceId: invoice.id,
        paymentAmount: input.amountCents,
        paymentCurrency: currency,
        source: input.source,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        factoringPacketId: input.factoringPacketId ?? null,
      })
      .returning();
    if (!payment) throw new Error('payment insert returned nothing');

    await recordEvent(tx, 'payment.recorded', {
      subjectId: payment.id,
      payload: {
        invoiceReference: invoice.reference,
        amount: payment.paymentAmount,
        currency: payment.paymentCurrency,
        source: payment.source,
      },
    });

    if (input.factoringPacketId) {
      const [packet] = await tx.db
        .select()
        .from(factoringPackets)
        .where(
          and(
            eq(factoringPackets.orgId, tx.ctx.orgId),
            eq(factoringPackets.id, input.factoringPacketId),
          ),
        )
        .limit(1);

      if (packet && packet.status !== 'funded') {
        const context = await packetContext(tx, packet);
        await tx.db
          .update(factoringPackets)
          .set({ status: 'funded' })
          .where(
            and(eq(factoringPackets.orgId, tx.ctx.orgId), eq(factoringPackets.id, packet.id)),
          );

        await recordEvent(tx, 'factoring_packet.funded', {
          subjectId: packet.id,
          payload: {
            ...context,
            amount: payment.paymentAmount,
            currency: payment.paymentCurrency,
          },
        });
      }
    }

    // Phase 1 assumes one currency per invoice (moneyNotNull's default, USD
    // throughout) so a plain sum is enough; a multi-currency invoice would
    // need this converted first, and nothing here does that conversion.
    const [sumRow] = await tx.db
      .select({ total: sql<number>`coalesce(sum(${payments.paymentAmount}), 0)::bigint` })
      .from(payments)
      .where(and(eq(payments.orgId, tx.ctx.orgId), eq(payments.invoiceId, invoice.id)));
    const totalPaid = Number(sumRow?.total ?? 0);

    let updatedInvoice = invoice;
    if (invoice.status !== 'paid' && totalPaid >= invoice.totalAmount) {
      const load = await loadForInvoicing(tx, invoice.loadId);

      const [row] = await tx.db
        .update(invoices)
        .set({ status: 'paid', paidAt: new Date() })
        .where(and(eq(invoices.orgId, tx.ctx.orgId), eq(invoices.id, invoice.id)))
        .returning();
      if (!row) throw new Error('invoice paid-update returned nothing');
      updatedInvoice = row;

      await recordEvent(tx, 'invoice.paid', {
        subjectId: row.id,
        payload: {
          reference: row.reference,
          loadReference: load.reference,
          totalAmount: row.totalAmount,
          totalCurrency: row.totalCurrency,
        },
      });

      await updateLoadStatus(tx, invoice.loadId, { status: 'paid' });

      // The authoritative reconciled figure — see the module note on why
      // this file writes actualRevenue and deliberately not actualCost.
      await tx.db
        .update(loads)
        .set({
          actualRevenueAmount: row.totalAmount,
          actualRevenueCurrency: row.totalCurrency,
        })
        .where(and(eq(loads.orgId, tx.ctx.orgId), eq(loads.id, invoice.loadId)));
    }

    return { payment, invoice: updatedInvoice };
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getInvoice(s: Scope, id: string): Promise<Invoice | undefined> {
  const [row] = await s.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.orgId, s.ctx.orgId), eq(invoices.id, id)))
    .limit(1);
  return row;
}

export interface ListInvoicesQuery {
  status?: InvoiceStatus[] | undefined;
  loadId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

/** Newest first, cursor-paginated on `(createdAt, id)` both descending — see `pagination.ts`. */
export async function listInvoices(
  s: Scope,
  q: ListInvoicesQuery = {},
): Promise<CursorPage<Invoice>> {
  const filters = [eq(invoices.orgId, s.ctx.orgId)];
  if (q.status?.length) filters.push(inArray(invoices.status, q.status));
  if (q.loadId) filters.push(eq(invoices.loadId, q.loadId));
  if (q.cursor) {
    const cursor = decodeCursor(q.cursor);
    const cursorDate = new Date(cursor.v);
    filters.push(
      or(
        lt(invoices.createdAt, cursorDate),
        and(eq(invoices.createdAt, cursorDate), lt(invoices.id, cursor.id)),
      )!,
    );
  }

  const limit = Math.min(q.limit ?? 50, 200);
  const rows = await s.db
    .select()
    .from(invoices)
    .where(and(...filters))
    .orderBy(desc(invoices.createdAt), desc(invoices.id))
    .limit(limit);

  return toCursorPage(rows, limit, (row) => ({ v: row.createdAt.toISOString(), id: row.id }));
}

export async function invoiceCounts(s: Scope): Promise<Record<string, number>> {
  const rows = await s.db
    .select({ status: invoices.status, count: sql<number>`count(*)::int` })
    .from(invoices)
    .where(eq(invoices.orgId, s.ctx.orgId))
    .groupBy(invoices.status);

  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

export interface AgingBucket {
  bucket: 'current' | 'past_1_30' | 'past_31_60' | 'past_61_90' | 'past_over_90';
  count: number;
  totalCents: number;
}

const AGING_BUCKET_ORDER: AgingBucket['bucket'][] = [
  'current',
  'past_1_30',
  'past_31_60',
  'past_61_90',
  'past_over_90',
];

/**
 * Open invoices (`status = 'sent'`), bucketed by how far past due they are.
 *
 * `dueAt` is null for an invoice sent with no broker payment terms on file —
 * those count as `current` rather than dropping out, because "we don't know
 * the terms" is not the same claim as "this isn't overdue" and burying the
 * row would hide exactly the invoice a carrier most needs to go find terms
 * for.
 */
export async function receivablesAging(s: Scope): Promise<AgingBucket[]> {
  const bucketExpr = sql<string>`
    case
      when ${invoices.dueAt} is null or ${invoices.dueAt} >= now() then 'current'
      when now() - ${invoices.dueAt} <= interval '30 days' then 'past_1_30'
      when now() - ${invoices.dueAt} <= interval '60 days' then 'past_31_60'
      when now() - ${invoices.dueAt} <= interval '90 days' then 'past_61_90'
      else 'past_over_90'
    end
  `;

  const rows = await s.db
    .select({
      bucket: bucketExpr,
      count: sql<number>`count(*)::int`,
      totalCents: sql<number>`coalesce(sum(${invoices.totalAmount}), 0)::bigint`,
    })
    .from(invoices)
    .where(and(eq(invoices.orgId, s.ctx.orgId), eq(invoices.status, 'sent')))
    .groupBy(bucketExpr);

  const byBucket = new Map(
    rows.map((r) => [
      r.bucket as AgingBucket['bucket'],
      { count: Number(r.count), totalCents: Number(r.totalCents) },
    ]),
  );

  // Every bucket returned, zero-filled, so a screen summing them does not
  // have to special-case an empty one.
  return AGING_BUCKET_ORDER.map((bucket) => ({
    bucket,
    ...(byBucket.get(bucket) ?? { count: 0, totalCents: 0 }),
  }));
}

export async function getFactoringPacket(
  s: Scope,
  id: string,
): Promise<FactoringPacket | undefined> {
  const [row] = await s.db
    .select()
    .from(factoringPackets)
    .where(and(eq(factoringPackets.orgId, s.ctx.orgId), eq(factoringPackets.id, id)))
    .limit(1);
  return row;
}

/** Newest first, cursor-paginated on `(createdAt, id)` both descending — see `pagination.ts`. */
export async function listFactoringPackets(
  s: Scope,
  q: {
    invoiceId?: string | undefined;
    status?: FactoringPacketStatus[] | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  } = {},
): Promise<CursorPage<FactoringPacket>> {
  const filters = [eq(factoringPackets.orgId, s.ctx.orgId)];
  if (q.invoiceId) filters.push(eq(factoringPackets.invoiceId, q.invoiceId));
  if (q.status?.length) filters.push(inArray(factoringPackets.status, q.status));
  if (q.cursor) {
    const cursor = decodeCursor(q.cursor);
    const cursorDate = new Date(cursor.v);
    filters.push(
      or(
        lt(factoringPackets.createdAt, cursorDate),
        and(eq(factoringPackets.createdAt, cursorDate), lt(factoringPackets.id, cursor.id)),
      )!,
    );
  }

  const limit = Math.min(q.limit ?? 50, 200);
  const rows = await s.db
    .select()
    .from(factoringPackets)
    .where(and(...filters))
    .orderBy(desc(factoringPackets.createdAt), desc(factoringPackets.id))
    .limit(limit);

  return toCursorPage(rows, limit, (row) => ({ v: row.createdAt.toISOString(), id: row.id }));
}

export async function listPayments(s: Scope, invoiceId: string): Promise<Payment[]> {
  return s.db
    .select()
    .from(payments)
    .where(and(eq(payments.orgId, s.ctx.orgId), eq(payments.invoiceId, invoiceId)))
    .orderBy(asc(payments.receivedAt));
}
