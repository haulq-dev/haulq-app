/**
 * What the delivered-to-paid loop says, and how it decides what to bill.
 * `FEATURE_REQUESTS_PLAN.md` section 8, piece 3.
 *
 * Pure functions, no I/O — the loop (`delivered-to-paid.ts`) gathers the
 * facts and calls these. Templated rather than model-written, on purpose:
 * these messages go out under a carrier's name to people who pay them, the
 * first loop's whole design is that a carrier can read a week of drafts and
 * see the system say the same sensible thing every time, and the plan
 * reserves a model for free-text replies where wording genuinely varies —
 * not for a payment reminder.
 */

import { formatMoney } from '@haulq/db';
import type {
  DeliveredUninvoicedCandidate,
  OverdueInvoiceCandidate,
} from '@haulq/db';

export interface Sender {
  carrierName: string;
  mcNumber: string | null;
}

const date = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const signOff = (sender: Sender) =>
  `Thank you,\n${sender.carrierName}${sender.mcNumber ? `\nMC ${sender.mcNumber}` : ''}`;

/** How a load is named to a broker: their own number if we have it, ours if not. */
const loadLabel = (c: { brokerLoadNumber: string | null; loadReference: number }) =>
  c.brokerLoadNumber ? `your load ${c.brokerLoadNumber}` : `load ${c.loadReference}`;

// --- payment reminder -----------------------------------------------------------

/**
 * One reminder per broker, listing everything of theirs that is overdue.
 * A broker with five late invoices gets one email, not five — five in a
 * row reads as harassment, and one is what a dispatcher would send.
 */
export function paymentReminder(
  sender: Sender,
  invoices: OverdueInvoiceCandidate[],
): { subject: string; body: string } {
  const many = invoices.length > 1;
  const lines = invoices.map(
    (i) =>
      `- Invoice ${i.reference} (${loadLabel({ brokerLoadNumber: i.brokerLoadNumber, loadReference: i.loadReference })}): ` +
      `${formatMoney(i.outstandingCents, i.currency)} outstanding, due ${date(i.dueAt)} ` +
      `(${i.daysOverdue} day${i.daysOverdue === 1 ? '' : 's'} overdue)`,
  );

  return {
    subject: `Payment reminder: ${invoices.length} overdue invoice${many ? 's' : ''} from ${sender.carrierName}`,
    body: [
      'Hello,',
      '',
      `This is a reminder from ${sender.carrierName} that ${many ? 'the following invoices are' : 'the following invoice is'} past due:`,
      '',
      ...lines,
      '',
      `Could you confirm the payment status, or let us know the expected payment date? If ${many ? 'these have' : 'this has'} already been paid, thank you — please reply with the remittance details so we can match ${many ? 'them' : 'it'} on our side.`,
      '',
      signOff(sender),
    ].join('\n'),
  };
}

// --- invoice ---------------------------------------------------------------------

export interface DerivedLineItem {
  code: string;
  description: string;
  amountCents: number;
  currency: string;
}

export type Derivation =
  | { ok: true; lineItems: DerivedLineItem[]; totalCents: number }
  | { ok: false; reason: 'no_pod' | 'has_accessorials' };

/**
 * What an unattended loop is allowed to bill, and nothing more.
 *
 * The amount is the highest-stakes number the loop touches, so the rule is
 * deliberately narrow: **a load with a proof of delivery on file, and a
 * rate, and no accessorials.** That is one line item, the rate the load
 * already carries, which the rate confirmation was validated against when
 * it arrived. Anything with accessorials (detention, layover, lumper) means
 * a human deciding what was actually earned, so it is refused here rather
 * than guessed at — and shows up in the loop's skip counts, not silently.
 *
 * `rateIsLinehaul` needs no special case: with no accessorials, the rate is
 * the whole bill either way.
 */
export function deriveLineItems(c: DeliveredUninvoicedCandidate): Derivation {
  if (!c.documentKinds.includes('pod')) return { ok: false, reason: 'no_pod' };
  if (c.accessorialsCents > 0) return { ok: false, reason: 'has_accessorials' };

  return {
    ok: true,
    lineItems: [
      {
        code: 'linehaul',
        description: `Freight: ${c.origin} to ${c.destination}`,
        amountCents: c.rateCents,
        currency: c.currency,
      },
    ],
    totalCents: c.rateCents,
  };
}

const KIND_LABEL: Record<string, string> = {
  rate_confirmation: 'rate confirmation',
  pod: 'proof of delivery',
  bol: 'bill of lading',
};

/**
 * The invoice email. Shadow-only for now — `invoice_delivery`'s ceiling in
 * `OUTBOUND_ACTIONS` — because outbound email cannot carry attachments yet
 * and this message says they are attached. **Do not raise that ceiling
 * without also making the attachment line below true.**
 */
export function invoiceDelivery(
  sender: Sender,
  c: DeliveredUninvoicedCandidate,
  derived: Extract<Derivation, { ok: true }>,
): { subject: string; body: string } {
  const label = c.brokerLoadNumber ? `load ${c.brokerLoadNumber}` : `load ${c.reference}`;
  const attached = ['invoice', ...c.documentKinds.filter((k) => KIND_LABEL[k]).map((k) => KIND_LABEL[k]!)];

  return {
    subject: `Invoice for ${label}: ${c.origin} to ${c.destination}`,
    body: [
      'Hello,',
      '',
      `Please find our invoice for ${label}, ${c.origin} to ${c.destination}, delivered ${date(c.deliveredAt)}.`,
      '',
      ...derived.lineItems.map((i) => `  ${i.description}: ${formatMoney(i.amountCents, i.currency)}`),
      `  Total due: ${formatMoney(derived.totalCents, c.currency)}`,
      ...(c.paymentTermsDays != null ? ['', `Payment terms: net ${c.paymentTermsDays} days.`] : []),
      '',
      `Attached: ${attached.join(', ')}.`,
      '',
      'Please confirm receipt, and let us know if anything is needed to process payment.',
      '',
      signOff(sender),
    ].join('\n'),
  };
}
