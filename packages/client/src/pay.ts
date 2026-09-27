/**
 * Pay: invoices, payments, factoring. What `/v1/invoices`, `/v1/factoring-*`
 * return, and the small rules both front ends apply. The shapes are copied
 * from `apps/web/src/routes/Pay.tsx` for the mobile port
 * (MOBILE_PARITY_PLAN.md M3). Web still declares its own copy.
 *
 * Nothing here is about the HaulQ subscription. These are the carrier's
 * own receivables. Keep Stripe and plan wording out of this file and out of
 * every screen built on it, so an App Review reader never mistakes a
 * carrier's invoice to a broker for an in-app purchase (Guideline 3.1.1).
 */

import { canTransitionInvoice, type FactoringPacketStatus, type InvoiceStatus } from '@haulq/contracts';
import { canManageMoney, canWritePay } from './access.ts';

export interface InvoiceLineItem {
  code: string;
  description: string;
  amountCents: number;
  currency: string;
}

export interface Invoice {
  id: string;
  loadId: string;
  reference: number;
  status: InvoiceStatus;
  sourceDocumentId: string | null;
  lineItems: InvoiceLineItem[];
  totalAmount: number;
  totalCurrency: string;
  dueAt: string | null;
  sentAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface InvoicesPage {
  items: Invoice[];
  /** Org-wide, by status, whatever the filter. */
  counts: Record<string, number>;
  nextCursor: string | null;
}

export type PaymentSource = 'factor' | 'broker_direct';

export interface Payment {
  id: string;
  invoiceId: string;
  paymentAmount: number;
  paymentCurrency: string;
  source: PaymentSource;
  receivedAt: string;
  reference: string | null;
  notes: string | null;
  factoringPacketId: string | null;
}

export interface FactoringCompany {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  submissionMethod: string;
  active: boolean;
}

export interface FactoringCompaniesPage {
  items: FactoringCompany[];
  nextCursor: string | null;
}

export interface FactoringPacket {
  id: string;
  invoiceId: string;
  factoringCompanyId: string;
  status: FactoringPacketStatus;
  submittedAt: string | null;
  respondedAt: string | null;
  rejectionReason: string | null;
}

export type AgingBucketName = 'current' | 'past_1_30' | 'past_31_60' | 'past_61_90' | 'past_over_90';

/** Sent, unpaid invoices only. The API zero-fills every bucket. */
export interface AgingBucket {
  bucket: AgingBucketName | string;
  count: number;
  totalCents: number;
}

export const AGING_LABEL: Record<string, string> = {
  current: 'Not due yet',
  past_1_30: '1–30 days late',
  past_31_60: '31–60 days late',
  past_61_90: '61–90 days late',
  past_over_90: 'Over 90 days late',
};

export const INVOICE_STATUS_TONE: Record<InvoiceStatus, 'ok' | 'warn' | 'neutral'> = {
  draft: 'neutral',
  sent: 'warn',
  paid: 'ok',
  void: 'neutral',
};

export const PACKET_STATUS_TONE: Record<FactoringPacketStatus, 'ok' | 'warn' | 'neutral'> = {
  assembling: 'neutral',
  submitted: 'warn',
  accepted: 'ok',
  rejected: 'warn',
  funded: 'ok',
};

/**
 * `draft` reads as "not sent yet" to a carrier. `sent` as "waiting on
 * payment", because that is what the state means to them. The pill is the
 * only place the raw enum would otherwise leak.
 */
export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'not sent',
  sent: 'awaiting payment',
  paid: 'paid',
  void: 'void',
};

/** Totals across the aging buckets: what is owed, and how much of it is late. */
export function agingSummary(buckets: readonly AgingBucket[]): {
  owedCents: number;
  owedCount: number;
  lateCents: number;
  lateCount: number;
} {
  let owedCents = 0;
  let owedCount = 0;
  let lateCents = 0;
  let lateCount = 0;
  for (const b of buckets) {
    owedCents += b.totalCents;
    owedCount += b.count;
    if (b.bucket !== 'current') {
      lateCents += b.totalCents;
      lateCount += b.count;
    }
  }
  return { owedCents, owedCount, lateCents, lateCount };
}

/** Sent, unpaid and past its due date. Only a sent invoice can be late. */
export function isOverdue(invoice: Pick<Invoice, 'status' | 'dueAt'>, now: number = Date.now()): boolean {
  return invoice.status === 'sent' && invoice.dueAt !== null && new Date(invoice.dueAt).getTime() < now;
}

/** Days past due, whole days, or 0 when not late. */
export function daysOverdue(invoice: Pick<Invoice, 'status' | 'dueAt'>, now: number = Date.now()): number {
  if (!isOverdue(invoice, now)) return 0;
  return Math.max(1, Math.floor((now - new Date(invoice.dueAt!).getTime()) / 86_400_000));
}

/** What is still owed after the payments recorded so far. Never negative. */
export function balanceDue(invoice: Pick<Invoice, 'totalAmount'>, payments: readonly Pick<Payment, 'paymentAmount'>[]): number {
  const paid = payments.reduce((sum, p) => sum + p.paymentAmount, 0);
  return Math.max(0, invoice.totalAmount - paid);
}

/**
 * Dollars as typed into a phone keyboard, to cents. Accepts `2400`,
 * `2,400.5`, `$2,400.50`. Returns `null` for anything else, including more
 * than two decimal places, so a stray keystroke is refused rather than
 * silently rounded into a different amount on an invoice.
 */
export function parseDollars(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Cents back to what the amount field shows: `240000` → `2400.00`. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * The line items a carrier bills most, as one-tap additions. `code` is free
 * text on the wire (see `InvoiceLineItemSchema`), so these are conventions,
 * not an enum, and "Other" stays available.
 */
export const LINE_ITEM_PRESETS: readonly { code: string; description: string }[] = [
  { code: 'linehaul', description: 'Linehaul' },
  { code: 'fuel_surcharge', description: 'Fuel surcharge' },
  { code: 'detention', description: 'Detention' },
  { code: 'lumper', description: 'Lumper' },
  { code: 'layover', description: 'Layover' },
  { code: 'tonu', description: 'Truck ordered, not used' },
  { code: 'other', description: '' },
];

export interface DraftLineItem {
  code: string;
  description: string;
  /** As typed. */
  amount: string;
}

/**
 * The form's rows as `POST /v1/invoices` wants them. A row with neither a
 * description nor an amount is an empty row, dropped. A row with one but not
 * the other, or an amount that isn't money, is a mistake, reported by index,
 * so the form can say which row, rather than dropping it and billing less.
 */
export function lineItemsBody(
  drafts: readonly DraftLineItem[],
): { items: { code: string; description: string; amountCents: number }[] } | { invalidRow: number } | { empty: true } {
  const items: { code: string; description: string; amountCents: number }[] = [];
  for (const [i, d] of drafts.entries()) {
    const description = d.description.trim();
    const amount = d.amount.trim();
    if (!description && !amount) continue;
    const cents = parseDollars(amount);
    if (!description || cents === null || cents <= 0) return { invalidRow: i };
    items.push({ code: d.code.trim() || 'other', description, amountCents: cents });
  }
  return items.length === 0 ? { empty: true } : { items };
}

/**
 * A date input's `YYYY-MM-DD` as an instant the API accepts, at local noon.
 * Noon, not midnight, so a deposit dated the 3rd is still the 3rd in every
 * US time zone once the API stores it as UTC.
 */
export function dateInputToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).toISOString();
}

/** Today as a date input's value, in local time. */
export function todayInput(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * What a role may do to this invoice right now. Only decides what to show;
 * `requireRole` in `routes/pay.ts` and the invoice status trigger refuse.
 *
 * - **Mark sent**: a draft, by anyone on Pay. It records that the carrier
 *   sent it to the broker. It does not email anything (Autopilot's invoice
 *   email is what sends, see `outbound/dispatch.ts`'s `afterSent`).
 * - **Record payment**: sent, by money roles. A paid invoice can take no more.
 * - **Void**: money roles, while `canTransitionInvoice` allows it (not paid).
 * - **Factor**: start a packet once sent. Dispatchers may assemble and mark
 *   submitted (the API allows it). Recording the factor's answer is money roles.
 */
export function invoiceActions(invoice: Pick<Invoice, 'status'>, role: string | undefined) {
  return {
    markSent: invoice.status === 'draft' && canWritePay(role),
    recordPayment: invoice.status === 'sent' && canManageMoney(role),
    void: invoice.status !== 'void' && canTransitionInvoice(invoice.status, 'void').allowed && canManageMoney(role),
    startPacket: invoice.status === 'sent' && canWritePay(role),
  };
}

/** Packets a payment from a factor can settle: the ones a factor has, or said yes to. */
export function settleablePackets(packets: readonly FactoringPacket[]): FactoringPacket[] {
  return packets.filter((p) => p.status === 'submitted' || p.status === 'accepted');
}

/**
 * Loads that can take a new invoice: delivered or invoiced, with no open
 * (non-void) invoice already. An `invoiced` load whose only invoice was
 * voided is waiting on a reissue, so it belongs here. Generating for any
 * other would only bounce off `invoices_load_key`.
 */
export function invoiceableLoads<L extends { id: string; status: string }>(
  loads: readonly L[],
  invoices: readonly Pick<Invoice, 'loadId' | 'status'>[],
): L[] {
  const open = new Set(invoices.filter((i) => i.status !== 'void').map((i) => i.loadId));
  return loads.filter((l) => (l.status === 'delivered' || l.status === 'invoiced') && !open.has(l.id));
}

/** A load's status at or past delivery, where an invoice is the next thing. */
export function loadIsBillable(status: string): boolean {
  return status === 'delivered' || status === 'invoiced' || status === 'paid';
}
