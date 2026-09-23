/**
 * The delivered-to-paid loop. `FEATURE_REQUESTS_PLAN.md` section 8, piece 3.
 *
 * One pass: for every carrier that has explicitly configured it, look at
 * what is true right now, decide what a dispatcher would send, and hand it
 * to the outbound choke point (`outbound/dispatch.ts`). This file decides
 * *what* and *to whom*; it never decides *whether it may* — the choke point
 * owns that (ceiling, kill switch, mode, dedupe), so a rule here cannot be
 * more permissive than the carrier's own settings.
 *
 * Two stages today:
 *
 *  - **Delivered, not invoiced** → the invoice email. Shadow-only: the
 *    action's ceiling is `shadow` until outbound email can carry
 *    attachments. It still runs, because a week of "here is the invoice I
 *    would have sent" is the fastest way to learn whether the amounts it
 *    derives are right, before anything is allowed to bill.
 *  - **Sent, past due** → a payment reminder, one per broker per week.
 *
 * What it will not do, by design: it never creates or sends an invoice
 * record, and never retries a failed send. A failed message stays failed on
 * the record until a person looks — a loop that quietly retries an email in
 * a carrier's name is how a broker ends up with it four times.
 */

import { randomUUID } from 'node:crypto';
import {
  findDeliveredUninvoiced,
  findOverdueInvoices,
  listAutopilotOrgs,
  scope,
  type AutopilotOrg,
  type Database,
} from '@haulq/db';
import type { RuntimeLog } from '../runtime.ts';
import { OutboundError, sendAsCarrier, type OutboundDeps } from '../outbound/dispatch.ts';
import { deriveLineItems, invoiceDelivery, paymentReminder } from './messages.ts';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export interface DeliveredToPaidOptions {
  db: Database;
  deps: OutboundDeps;
  log: RuntimeLog;
  now?: Date;
  /** A dispatcher who invoices the same afternoon should never find the system got there first. */
  invoiceGraceHours?: number;
  /** Days past due before the first reminder — a payment in the mail is not late. */
  reminderAfterDays?: number;
  /** Past this it is a collections conversation with a person, not an automated nudge. */
  reminderStopsAfterDays?: number;
}

export interface PassSummary {
  orgs: number;
  /** Messages that were newly recorded or promoted this pass. */
  recorded: number;
  /** Of those, how many actually left. */
  sent: number;
  /** Why something was left alone — the count is how a carrier finds out what the loop declined to guess at. */
  skipped: Record<string, number>;
}

/** The actions this loop drives. An org must have set at least one to be visited at all. */
export const DELIVERED_TO_PAID_ACTIONS = ['invoice_delivery', 'payment_reminder'] as const;

export async function runDeliveredToPaidPass(options: DeliveredToPaidOptions): Promise<PassSummary> {
  const now = options.now ?? new Date();
  const summary: PassSummary = { orgs: 0, recorded: 0, sent: 0, skipped: {} };
  const skip = (reason: string) => {
    summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
  };

  const orgs = await listAutopilotOrgs(options.db, [...DELIVERED_TO_PAID_ACTIONS]);
  for (const org of orgs) {
    summary.orgs += 1;
    try {
      await runOrg(options, org, now, summary, skip);
    } catch (err) {
      // One carrier's failure must not stop everyone else's pass.
      options.log.error(
        { orgId: org.orgId, err: err instanceof Error ? err.message : String(err) },
        'autopilot pass failed for an org',
      );
      skip('org_error');
    }
  }
  return summary;
}

async function runOrg(
  options: DeliveredToPaidOptions,
  org: AutopilotOrg,
  now: Date,
  summary: PassSummary,
  skip: (reason: string) => void,
): Promise<void> {
  const s = scope(options.db, {
    orgId: org.orgId,
    actor: { type: 'system', name: 'autopilot' },
    correlationId: randomUUID(),
  });
  const sender = { carrierName: org.carrierName, mcNumber: org.mcNumber };

  const record = async (input: Parameters<typeof sendAsCarrier>[2]) => {
    try {
      const result = await sendAsCarrier(options.deps, s, input);
      if (result.created) summary.recorded += 1;
      if (result.sent) summary.sent += 1;
      if (!result.created) skip('already_handled');
    } catch (err) {
      // A message that should never have been built — most often a broker
      // whose stored "email" is not an address. Counted, not thrown.
      if (err instanceof OutboundError) {
        skip(err.code);
        return;
      }
      throw err;
    }
  };

  // --- delivered, not invoiced ---------------------------------------------------
  if (org.modes['invoice_delivery']) {
    const candidates = await findDeliveredUninvoiced(
      options.db,
      org.orgId,
      now,
      options.invoiceGraceHours ?? 24,
    );
    for (const c of candidates) {
      const derived = deriveLineItems(c);
      if (!derived.ok) {
        skip(`invoice_${derived.reason}`);
        continue;
      }
      const message = invoiceDelivery(sender, c, derived);
      await record({
        actionType: 'invoice_delivery',
        to: [c.brokerEmail],
        subject: message.subject,
        body: message.body,
        relatedType: 'load',
        relatedId: c.loadId,
        // One invoice email per load, ever. A promoted shadow draft reuses
        // this key (see `createOutbound`), so approving the shadow week does
        // not mean re-deciding it.
        dedupeKey: `invoice-delivery:${c.loadId}`,
      });
    }
  }

  // --- past due --------------------------------------------------------------------
  if (org.modes['payment_reminder']) {
    const overdue = await findOverdueInvoices(options.db, org.orgId, now, {
      minDaysOverdue: options.reminderAfterDays ?? 3,
      maxDaysOverdue: options.reminderStopsAfterDays ?? 60,
    });

    const byBroker = new Map<string, typeof overdue>();
    for (const inv of overdue) {
      const list = byBroker.get(inv.brokerId) ?? [];
      list.push(inv);
      byBroker.set(inv.brokerId, list);
    }

    const week = Math.floor(now.getTime() / WEEK_MS);
    for (const [brokerId, invoices] of byBroker) {
      const message = paymentReminder(sender, invoices);
      await record({
        actionType: 'payment_reminder',
        to: [invoices[0]!.brokerEmail],
        subject: message.subject,
        body: message.body,
        relatedType: 'broker',
        relatedId: brokerId,
        // At most one reminder per broker per week. An invoice that goes
        // overdue mid-week waits for the next one; that is the price of
        // never sending a broker two emails in a week from the same carrier.
        dedupeKey: `payment-reminder:${brokerId}:${week}`,
      });
    }
  }
}
