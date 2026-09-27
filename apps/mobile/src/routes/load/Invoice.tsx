/**
 * The load's invoice, from the load's side. Once a load is delivered the next
 * thing it needs is billing, so this links straight to the invoice, or to a
 * new one with the load already chosen. Web's load screen doesn't have this;
 * on a phone, going back to Pay and finding the load again is the long way.
 */

import {
  formatMoney,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  useInvoicesForLoad,
  type Load,
} from '@haulq/client';
import { Link } from '@tanstack/react-router';
import { Card, ErrorNote, Pill } from '../../components/ui.tsx';

export function InvoiceCard({ load }: { load: Load }) {
  const invoices = useInvoicesForLoad(load.id);
  if (invoices.isError) return <ErrorNote error={invoices.error} />;
  if (!invoices.data) return null;

  const open = invoices.data.find((i) => i.status !== 'void');

  if (open) {
    return (
      <Link to="/pay/$invoiceId" params={{ invoiceId: open.id }} className="block">
        <Card title="Invoice">
          <div className="flex items-center justify-between gap-2">
            <span className="num font-semibold">
              Invoice {open.reference} · {formatMoney(open.totalAmount)}
            </span>
            <Pill tone={INVOICE_STATUS_TONE[open.status]}>{INVOICE_STATUS_LABEL[open.status]}</Pill>
          </div>
        </Card>
      </Link>
    );
  }

  // A paid load with only void invoices has nothing to do here.
  if (load.status !== 'delivered' && load.status !== 'invoiced') return null;

  return (
    <Card title="Invoice">
      <p className="mb-3 text-sm text-slate">
        {invoices.data.length > 0 ? 'Its invoice was voided. It can be invoiced again.' : 'Delivered and not invoiced yet.'}
      </p>
      <Link to="/pay/new" search={{ loadId: load.id }} className="hq-btn hq-btn-primary w-full active:scale-100">
        Create the invoice
      </Link>
    </Card>
  );
}
