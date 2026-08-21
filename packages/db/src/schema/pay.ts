/**
 * HaulQ Pay — Phase 1b.
 *
 * PHASE_1_PLAN.md section 5 sketches this as four tables and calls out that
 * "the actual columns get decided when this is built" — this file is that
 * decision, made against what Phase 0 and 1a (Docs) already established
 * rather than against a standing start. Nothing in Pay owns document
 * handling, the object store or the mailer; it reads what Docs already
 * validated and writes a new fact on top.
 *
 * The exit gate this schema serves (plan section 5, restated): a delivered
 * load's documents produce an invoice with the right numbers on it, and a
 * factoring packet a factor will actually accept, with the load's
 * `actual_cost`/`actual_margin` written once money is known. Three
 * sentences, four tables — `invoices` and `payments` for the first and
 * third, `factoring_companies` and `factoring_packets` for the second.
 *
 * ---------------------------------------------------------------------------
 * Pay tracks money. It does not move it.
 * ---------------------------------------------------------------------------
 *
 * Plan section 7's second open question, answered here in the schema itself
 * by what is absent: there is no column anywhere below that initiates a
 * transfer. `payments.receivedAt` records that money arrived; nothing
 * requests that it does. Actually moving funds — ACH, a factor's API pulling
 * on this invoice — is a different regulatory surface (money transmission
 * licensing in most states) and does not belong in this table even as a
 * disabled feature, because a disabled "pay now" button is still a decision
 * about what this product is that a schema change shouldn't make silently.
 *
 * ---------------------------------------------------------------------------
 * A factoring company is a payment method, not a counterparty
 * ---------------------------------------------------------------------------
 *
 * `factoring_companies` is shaped like `brokers.ts` in isolation — per-org,
 * asserted facts, a name and contact details — but the relationship it
 * models is different. A carrier has one or a few factors and reuses them
 * across every load; a broker is one-per-load and often one-and-done. That
 * is why a factoring company has no `blocked` flag or per-load reference the
 * way `brokers` does: the analogous "carrier stopped using this factor" state
 * is just no longer selecting it, the way nobody adds an `unused` flag to a
 * saved payment card.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { moneyNotNull, pk, timestamps } from './_shared.ts';
import {
  factoringPacketStatusEnum,
  invoiceStatusEnum,
  paymentSourceEnum,
} from './enums.ts';
import { documents } from './documents.ts';
import { loads } from './loads.ts';
import { orgs } from './tenancy.ts';

/**
 * One row per invoice, generated once a load's documents pass validation —
 * not hand-typed from nothing. Docs is upstream of this table, not beside
 * it: `sourceDocumentId` is the validated document (typically the POD or the
 * signed rate confirmation) whose agreement with the load is what makes
 * generating this invoice safe to do automatically.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    loadId: uuid('load_id')
      .notNull()
      .references(() => loads.id, { onDelete: 'restrict' }),

    /**
     * Human-facing sequential number, per org — same pattern and same
     * trigger-assigned mechanism as `loads.reference`
     * (`sql/post/0600_invoice_reference.sql`). What gets typed on a
     * factoring packet's cover sheet; a uuid is not.
     */
    reference: integer('reference').notNull().default(0),

    status: invoiceStatusEnum('status').notNull().default('draft'),

    /**
     * The document Pay read to generate this — see the module note. Nullable
     * because an invoice can also be created by hand for a load Docs never
     * touched (a cash customer, a quick local run with no paperwork).
     */
    sourceDocumentId: uuid('source_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),

    /**
     * Linehaul, fuel surcharge, detention, TONU, lumper — one row per
     * accessorial. `jsonb` for the same reason `loads.accessorialDetail`
     * already is: the set of codes a carrier bills is not fixed, and a
     * generated invoice's line items are a snapshot at generation time, not
     * a live join back to the load that produced them (the load's own
     * accessorials can change after the invoice is sent).
     *
     * Shape: `{ code: string, description: string, amountCents: number,
     * currency: string }[]`.
     */
    lineItems: jsonb('line_items').notNull().default(sql`'[]'::jsonb`),

    ...moneyNotNull('total'),

    /**
     * From the broker's payment terms (`brokers.paymentTermsDays`) at the
     * time this invoice was sent. Copied rather than joined live, same
     * reasoning as `lineItems`: a broker renegotiating terms next quarter
     * must not silently move the due date on an invoice already sent.
     */
    dueAt: timestamp('due_at', { withTimezone: true }),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),

    ...timestamps,
  },
  (t) => [
    unique('invoices_org_reference_key').on(t.orgId, t.reference),
    /**
     * One non-void invoice per load. Partial, not a table-level unique: a
     * corrected invoice voids and reissues, and a plain unique constraint
     * would make the reissue impossible while the voided row still exists.
     */
    uniqueIndex('invoices_load_key').on(t.loadId).where(sql`status <> 'void'`),
    index('invoices_org_status_idx').on(t.orgId, t.status),
    index('invoices_org_due_idx').on(t.orgId, t.dueAt),
    index('invoices_source_document_idx').on(t.sourceDocumentId),
  ],
);

/**
 * A carrier's factor. See the module note on why this holds no `blocked`
 * flag or per-load reference the way `brokers` does.
 */
export const factoringCompanies = pgTable(
  'factoring_companies',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),

    /**
     * 'email' | 'portal' | 'api' — text with a check constraint
     * (`sql/post/0500_constraints.sql`), matching `documents.kind`'s
     * reasoning: which method a given factor supports is decided per-factor
     * relationship, not per HaulQ deploy. Every factor is 'email' today —
     * plan section 7 names the packet format as still unanswered, and
     * 'portal'/'api' exist so that answer does not require a schema change,
     * only a new value in the list.
     */
    submissionMethod: text('submission_method').notNull().default('email'),

    active: boolean('active').notNull().default(true),
    notes: text('notes'),

    ...timestamps,
  },
  (t) => [
    index('factoring_companies_org_idx').on(t.orgId),
    unique('factoring_companies_org_name_key').on(t.orgId, t.name),
  ],
);

/**
 * One submission of one invoice to one factor. An invoice rejected by a
 * factor and resubmitted (to the same factor or a different one) is a new
 * row, not an edit — the rejection is a fact that happened and stays in the
 * log the way a rejected document does (`documents.status = 'rejected'`).
 */
export const factoringPackets = pgTable(
  'factoring_packets',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    factoringCompanyId: uuid('factoring_company_id')
      .notNull()
      .references(() => factoringCompanies.id, { onDelete: 'restrict' }),

    status: factoringPacketStatusEnum('status').notNull().default('assembling'),

    /**
     * Which of the load's `documents` rows this packet bundled — the invoice
     * itself plus whichever of rate confirmation, BOL and POD the factor
     * requires. An array of document ids rather than a join table: the set
     * is decided once at assembly time and is never queried from the
     * document side, so a join table would exist only to be read one way.
     */
    documentIds: jsonb('document_ids').notNull().default(sql`'[]'::jsonb`),

    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    /** Populated when status is `rejected`. The carrier is going to ask why. */
    rejectionReason: text('rejection_reason'),

    ...timestamps,
  },
  (t) => [
    index('factoring_packets_org_idx').on(t.orgId),
    index('factoring_packets_org_status_idx').on(t.orgId, t.status),
    index('factoring_packets_invoice_idx').on(t.invoiceId),
    index('factoring_packets_factoring_company_idx').on(t.factoringCompanyId),
  ],
);

/**
 * Money actually received against an invoice. What receivables aging and
 * payment speed (Insights) both read. Split from a factor's advance and its
 * later reserve release, or a broker paying in two installments, are two
 * rows here, not one — an invoice's `paidAt` is set once the sum of its
 * payments reaches its total, not on the first dollar.
 */
export const payments = pgTable(
  'payments',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    /**
     * Which submission this money settles, when `source = 'factor'`. Null for
     * a broker paying direct, and null is also allowed for a factor payment
     * where no packet was tracked (a carrier who submitted by hand before
     * `factoring_packets` existed for them). This is what turns a packet's
     * `funded` status into an observed fact rather than a guess — see
     * `recordPayment` in `repositories/pay.ts`.
     */
    factoringPacketId: uuid('factoring_packet_id').references(() => factoringPackets.id, {
      onDelete: 'set null',
    }),

    ...moneyNotNull('payment'),
    source: paymentSourceEnum('source').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),

    /** Check number, ACH trace id, factor batch reference — whatever ties
     *  this row back to a bank statement when a carrier disputes it. */
    reference: text('reference'),
    notes: text('notes'),

    ...timestamps,
  },
  (t) => [
    index('payments_org_idx').on(t.orgId),
    index('payments_org_received_idx').on(t.orgId, t.receivedAt),
    index('payments_invoice_idx').on(t.invoiceId),
    index('payments_factoring_packet_idx').on(t.factoringPacketId),
  ],
);

// --- relations ---------------------------------------------------------

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  org: one(orgs, { fields: [invoices.orgId], references: [orgs.id] }),
  load: one(loads, { fields: [invoices.loadId], references: [loads.id] }),
  sourceDocument: one(documents, {
    fields: [invoices.sourceDocumentId],
    references: [documents.id],
  }),
  factoringPackets: many(factoringPackets),
  payments: many(payments),
}));

export const factoringCompaniesRelations = relations(
  factoringCompanies,
  ({ one, many }) => ({
    org: one(orgs, { fields: [factoringCompanies.orgId], references: [orgs.id] }),
    packets: many(factoringPackets),
  }),
);

export const factoringPacketsRelations = relations(factoringPackets, ({ one, many }) => ({
  org: one(orgs, { fields: [factoringPackets.orgId], references: [orgs.id] }),
  invoice: one(invoices, {
    fields: [factoringPackets.invoiceId],
    references: [invoices.id],
  }),
  factoringCompany: one(factoringCompanies, {
    fields: [factoringPackets.factoringCompanyId],
    references: [factoringCompanies.id],
  }),
  payments: many(payments),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  org: one(orgs, { fields: [payments.orgId], references: [orgs.id] }),
  invoice: one(invoices, { fields: [payments.invoiceId], references: [invoices.id] }),
  factoringPacket: one(factoringPackets, {
    fields: [payments.factoringPacketId],
    references: [factoringPackets.id],
  }),
}));
