/**
 * Pay, for owners, dispatchers and accountants. Web's `Pay.tsx` on a phone
 * (MOBILE_PARITY_PLAN.md M3).
 *
 * Web is one long page: aging tiles, a table with inline buttons, the
 * selected invoice's detail below it, factoring companies at the bottom. On
 * a phone that becomes a list and screens it opens:
 *
 * - **This screen**: what is owed and how much of it is late, the status
 *   filter, and one card per invoice.
 * - **`/pay/$invoiceId`**: everything done to one invoice (mark sent, record a
 *   payment, void, factoring), the same "act on the thing you opened" shape
 *   the load screen uses.
 * - **`/pay/new`** and **`/pay/factoring`**: the two forms, each its own screen.
 *
 * Money here is the carrier's receivables from brokers, never HaulQ's own
 * subscription. See `@haulq/client`'s `pay.ts` note on keeping the two apart
 * for App Review.
 */

import { INVOICE_STATUSES, type InvoiceStatus } from '@haulq/contracts';
import {
  AGING_LABEL,
  agingSummary,
  canWritePay,
  daysOverdue,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  useInvoices,
  useReceivablesAging,
  type Invoice,
} from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { Card, Chip, Empty, ErrorNote, LoadMore, Money, Pill } from '../../components/ui.tsx';
import { shortDate } from './shared.ts';

export function PayScreen() {
  const session = useSession();
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const invoices = useInvoices(status);
  const items = invoices.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = invoices.data?.pages[0]?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl">Pay</h1>
        {canWritePay(session?.role) && (
          <Link to="/pay/new" className="hq-btn hq-btn-brand active:scale-100" aria-label="New invoice">
            + Invoice
          </Link>
        )}
      </div>

      <Owed />

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Filter by status">
        <Chip active={status === ''} onClick={() => setStatus('')} label="All" count={total} />
        {INVOICE_STATUSES.filter((s) => counts[s]).map((s) => (
          <Chip key={s} active={status === s} onClick={() => setStatus(s)} label={INVOICE_STATUS_LABEL[s]} count={counts[s] ?? 0} />
        ))}
      </div>

      {invoices.isError && <ErrorNote error={invoices.error} />}
      {invoices.isLoading && <p className="text-sm text-mute">Loading…</p>}
      {invoices.isSuccess && items.length === 0 && (
        <div className="hq-card px-4">
          <Empty>
            {status
              ? `No invoices ${INVOICE_STATUS_LABEL[status]}.`
              : 'No invoices yet. Once a load is delivered, invoice it from here or from the load.'}
          </Empty>
        </div>
      )}

      <ul className="space-y-3">
        {items.map((invoice) => (
          <li key={invoice.id}>
            <InvoiceCard invoice={invoice} />
          </li>
        ))}
      </ul>
      <LoadMore onClick={() => void invoices.fetchNextPage()} loading={invoices.isFetchingNextPage} hasMore={invoices.hasNextPage} />

      <Link to="/pay/factoring" className="hq-card flex items-center justify-between px-4 py-3.5">
        <span className="font-semibold">Factoring companies</span>
        <span className="text-mute" aria-hidden>
          ›
        </span>
      </Link>
    </div>
  );
}

/**
 * The headline: money out with brokers, and the late part of it in red,
 * then only the late buckets that have something in them. Five equal tiles,
 * as web shows, would put four zeros on a phone's first screen.
 */
function Owed() {
  const aging = useReceivablesAging();
  if (aging.isError) return <ErrorNote error={aging.error} />;
  if (!aging.data) return null;

  const sum = agingSummary(aging.data);
  const late = aging.data.filter((b) => b.bucket !== 'current' && b.count > 0);

  return (
    <Card>
      <p className="field-label">Owed to you</p>
      <p className="num mt-1 text-3xl font-semibold">
        <Money cents={sum.owedCents} />
      </p>
      <p className="text-sm text-mute">
        {sum.owedCount === 0
          ? 'Nothing waiting on a broker.'
          : `${sum.owedCount} ${sum.owedCount === 1 ? 'invoice' : 'invoices'} awaiting payment`}
      </p>
      {sum.lateCount > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-line pt-3">
          <p className="text-sm font-semibold text-bad">
            <Money cents={sum.lateCents} /> is late
          </p>
          <ul className="space-y-1">
            {late.map((b) => (
              <li key={b.bucket} className="flex justify-between text-sm">
                <span className="text-slate">
                  {AGING_LABEL[b.bucket] ?? b.bucket} <span className="text-mute">· {b.count}</span>
                </span>
                <Money cents={b.totalCents} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function InvoiceCard({ invoice }: { invoice: Invoice }) {
  const late = daysOverdue(invoice);
  return (
    <Link to="/pay/$invoiceId" params={{ invoiceId: invoice.id }} className="block">
      <Card>
        <div className="flex items-center justify-between gap-2">
          <span className="num text-lg font-semibold">Invoice {invoice.reference}</span>
          <Pill tone={INVOICE_STATUS_TONE[invoice.status]}>{INVOICE_STATUS_LABEL[invoice.status]}</Pill>
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <span className="text-base font-semibold">
            <Money cents={invoice.totalAmount} />
          </span>
          <span className={`text-sm ${late ? 'font-semibold text-bad' : 'text-mute'}`}>
            {invoice.status === 'paid' && invoice.paidAt
              ? `Paid ${shortDate(invoice.paidAt)}`
              : invoice.status === 'void'
                ? 'Voided'
                : late
                  ? `${late} ${late === 1 ? 'day' : 'days'} late`
                  : invoice.dueAt
                    ? `Due ${shortDate(invoice.dueAt)}`
                    : 'No due date'}
          </span>
        </div>
      </Card>
    </Link>
  );
}
