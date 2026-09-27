/**
 * One invoice: what it bills, where it stands, and everything a role may do
 * to it. Web's `InvoiceDetail` plus the row's inline buttons, as one screen.
 *
 * Order follows how often each part is needed: the state and the one next
 * step (mark sent, or record the payment), then what it bills and what has
 * come in, then factoring, then the PDF on demand.
 *
 * Which buttons appear comes from `invoiceActions` in `@haulq/client`, so a
 * paid invoice is never offered a Void that the status trigger would only
 * refuse. `requireRole` in the API is what actually enforces it.
 *
 * **"Mark as sent", not "Send".** `POST /v1/invoices/:id/send` records that
 * the invoice went to the broker. It emails nothing (Autopilot's invoice
 * email is what delivers one). Web's button says "Send"; on a phone, with no
 * email client in view, that would read as HaulQ sending it.
 */

import {
  balanceDue,
  canManageMoney,
  centsToInput,
  dateInputToIso,
  daysOverdue,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  invoiceActions,
  laneEnds,
  PACKET_STATUS_TONE,
  parseDollars,
  settleablePackets,
  todayInput,
  useAssemblePacket,
  useFactoringCompanies,
  useFactoringPackets,
  useInvoice,
  useInvoicePayments,
  useLoad,
  useMarkInvoiceSent,
  useRecordPayment,
  useRespondToPacket,
  useSubmitPacket,
  useVoidInvoice,
  type FactoringPacket,
  type Invoice,
  type PaymentSource,
} from '@haulq/client';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { DocumentPreview } from '../../components/DocumentPreview.tsx';
import { Card, Empty, ErrorNote, Field, Money, Note, Pill } from '../../components/ui.tsx';
import { successFeedback } from '../../lib/haptics.ts';
import { shortDate } from './shared.ts';

export function InvoiceScreen() {
  const { invoiceId } = useParams({ from: '/pay/$invoiceId' });
  const invoice = useInvoice(invoiceId);

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/pay" className="text-sm text-brand">
        ‹ Pay
      </Link>
      {invoice.isError && <ErrorNote error={invoice.error} />}
      {invoice.isLoading && <p className="text-sm text-mute">Loading…</p>}
      {invoice.data && <Body invoice={invoice.data} />}
    </div>
  );
}

function Body({ invoice }: { invoice: Invoice }) {
  const role = useSession()?.role;
  const actions = invoiceActions(invoice, role);
  const payments = useInvoicePayments(invoice.id);
  const packets = useFactoringPackets(invoice.id);
  const late = daysOverdue(invoice);
  const owed = payments.data ? balanceDue(invoice, payments.data) : invoice.totalAmount;

  return (
    <>
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <h1 className="num text-2xl">Invoice {invoice.reference}</h1>
          <Pill tone={INVOICE_STATUS_TONE[invoice.status]} onPage>
            {INVOICE_STATUS_LABEL[invoice.status]}
          </Pill>
        </div>
        <p className="num text-3xl font-semibold">
          <Money cents={invoice.totalAmount} />
        </p>
        <Dates invoice={invoice} late={late} />
        <LoadLine loadId={invoice.loadId} />
      </header>

      {invoice.voidReason && <Note>Voided: {invoice.voidReason}</Note>}

      {actions.markSent && <MarkSent invoice={invoice} />}
      {actions.recordPayment && (
        <RecordPayment invoice={invoice} owedCents={owed} packets={settleablePackets(packets.data ?? [])} />
      )}

      <Card title="What it bills">
        <ul className="divide-y divide-line">
          {invoice.lineItems.map((item, i) => (
            <li key={i} className="flex items-baseline justify-between gap-3 py-2 text-sm">
              <span>{item.description}</span>
              <Money cents={item.amountCents} />
            </li>
          ))}
          <li className="flex items-baseline justify-between gap-3 py-2 font-semibold">
            <span>Total</span>
            <Money cents={invoice.totalAmount} />
          </li>
        </ul>
      </Card>

      <Card title="Payments">
        {payments.isError && <ErrorNote error={payments.error} />}
        {payments.data && payments.data.length === 0 && <Empty>No payments recorded yet.</Empty>}
        {payments.data && payments.data.length > 0 && (
          <ul className="divide-y divide-line">
            {payments.data.map((p) => (
              <li key={p.id} className="py-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span>
                    {p.source === 'factor' ? 'From the factor' : 'From the broker'}
                    <span className="text-mute"> · {shortDate(p.receivedAt)}</span>
                  </span>
                  <Money cents={p.paymentAmount} />
                </div>
                {p.reference && <p className="num text-xs text-mute">{p.reference}</p>}
              </li>
            ))}
          </ul>
        )}
        {payments.data && payments.data.length > 0 && invoice.status === 'sent' && (
          <p className="mt-2 flex justify-between border-t border-line pt-2 text-sm font-semibold">
            <span>Still owed</span>
            <Money cents={owed} />
          </p>
        )}
      </Card>

      <Factoring invoice={invoice} packets={packets.data ?? []} canStart={actions.startPacket} error={packets.error} />

      {actions.void && <VoidInvoice invoice={invoice} />}

      <InvoicePdf invoice={invoice} />
    </>
  );
}

function Dates({ invoice, late }: { invoice: Invoice; late: number }) {
  const parts: string[] = [];
  if (invoice.sentAt) parts.push(`Sent ${shortDate(invoice.sentAt)}`);
  if (invoice.paidAt) parts.push(`Paid ${shortDate(invoice.paidAt)}`);
  else if (invoice.dueAt && invoice.status !== 'void') parts.push(`Due ${shortDate(invoice.dueAt)}`);
  return (
    <p className="text-sm text-mute">
      {parts.join(' · ') || 'Not sent yet'}
      {late > 0 && (
        <span className="font-semibold text-bad">
          {' '}
          · {late} {late === 1 ? 'day' : 'days'} late
        </span>
      )}
    </p>
  );
}

function LoadLine({ loadId }: { loadId: string }) {
  const load = useLoad(loadId);
  if (!load.data) return null;
  const { pickup, delivery } = laneEnds(load.data.stops);
  return (
    <Link to="/loads/$loadId" params={{ loadId }} className="block text-sm text-brand">
      Load {load.data.reference}
      {load.data.brokerName && ` · ${load.data.brokerName}`}
      {pickup && delivery && ` · ${pickup.city} → ${delivery.city}`} ›
    </Link>
  );
}

function MarkSent({ invoice }: { invoice: Invoice }) {
  const send = useMarkInvoiceSent();
  return (
    <Card title="Next: send it to the broker">
      <p className="mb-3 text-sm text-slate">
        Once you've sent it, mark it here. That starts the clock on its due date and moves the load to invoiced. HaulQ
        doesn't email it from this button.
      </p>
      <button
        type="button"
        className="hq-btn hq-btn-primary w-full"
        disabled={send.isPending}
        onClick={() => send.mutate(invoice.id, { onSuccess: successFeedback })}
      >
        {send.isPending ? 'Saving…' : 'Mark as sent'}
      </button>
      <div className="mt-2">
        <ErrorNote error={send.error} />
      </div>
    </Card>
  );
}

/**
 * Money in. The amount starts at what is still owed, so the common case (the
 * broker paid in full) is one tap. A factor's payment can name the packet it
 * settles, which marks that packet funded.
 */
function RecordPayment({ invoice, owedCents, packets }: { invoice: Invoice; owedCents: number; packets: FactoringPacket[] }) {
  const record = useRecordPayment();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(() => centsToInput(owedCents));
  const [source, setSource] = useState<PaymentSource>(packets.length > 0 ? 'factor' : 'broker_direct');
  const [packetId, setPacketId] = useState(packets.length === 1 ? packets[0]!.id : '');
  const [date, setDate] = useState(todayInput);
  const [reference, setReference] = useState('');

  if (!open) {
    return (
      <button
        type="button"
        className="hq-btn hq-btn-primary w-full"
        onClick={() => {
          setAmount(centsToInput(owedCents));
          setOpen(true);
        }}
      >
        Record a payment
      </button>
    );
  }

  const cents = parseDollars(amount);
  const receivedAt = dateInputToIso(date);
  const valid = cents !== null && cents > 0 && receivedAt !== null;

  return (
    <Card title="Record a payment">
      <div className="space-y-3">
        <Field label="Amount ($)" {...(cents !== null && cents > owedCents ? { hint: 'More than is owed.' } : {})}>
          <input className="hq-input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="From">
          <select className="hq-input" value={source} onChange={(e) => setSource(e.target.value as PaymentSource)}>
            <option value="broker_direct">The broker</option>
            <option value="factor">A factoring company</option>
          </select>
        </Field>
        {source === 'factor' && packets.length > 0 && (
          <Field label="Which packet it settles" hint="Marks the packet funded.">
            <select className="hq-input" value={packetId} onChange={(e) => setPacketId(e.target.value)}>
              <option value="">Not tracked</option>
              {packets.map((p) => (
                <option key={p.id} value={p.id}>
                  Packet sent {p.submittedAt ? shortDate(p.submittedAt) : '(not yet)'} · {p.status}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Received">
          <input type="date" className="hq-input" value={date} max={todayInput()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Reference" hint="Check number, ACH trace, factor batch.">
          <input className="hq-input" value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <button
            type="button"
            className="hq-btn hq-btn-brand flex-1"
            disabled={!valid || record.isPending}
            onClick={() =>
              record.mutate(
                {
                  invoiceId: invoice.id,
                  amountCents: cents!,
                  currency: invoice.totalCurrency,
                  source,
                  receivedAt: receivedAt!,
                  ...(reference.trim() ? { reference: reference.trim() } : {}),
                  ...(source === 'factor' && packetId ? { factoringPacketId: packetId } : {}),
                },
                {
                  onSuccess: () => {
                    successFeedback();
                    setOpen(false);
                    setReference('');
                  },
                },
              )
            }
          >
            {record.isPending ? 'Saving…' : 'Save payment'}
          </button>
          <button type="button" className="hq-btn hq-btn-ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
        {amount && cents === null && <p className="text-sm text-bad">That isn't an amount. Use numbers, like 2400.00.</p>}
        <ErrorNote error={record.error} />
      </div>
    </Card>
  );
}

function VoidInvoice({ invoice }: { invoice: Invoice }) {
  const void_ = useVoidInvoice();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  if (!open) {
    return (
      <button type="button" className="w-full py-2 text-sm text-bad" onClick={() => setOpen(true)}>
        Void this invoice
      </button>
    );
  }

  return (
    <Card title="Void this invoice">
      <p className="mb-3 text-sm text-slate">
        A voided invoice stays on record. The load can then be invoiced again.
      </p>
      <Field label="Why">
        <input className="hq-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wrong rate, duplicate…" />
      </Field>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="hq-btn flex-1 bg-bad text-white"
          disabled={!reason.trim() || void_.isPending}
          onClick={() => void_.mutate({ id: invoice.id, reason: reason.trim() }, { onSuccess: () => setOpen(false) })}
        >
          {void_.isPending ? 'Voiding…' : 'Void it'}
        </button>
        <button type="button" className="hq-btn hq-btn-ghost" onClick={() => setOpen(false)}>
          Keep it
        </button>
      </div>
      <div className="mt-2">
        <ErrorNote error={void_.error} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Factoring
// ---------------------------------------------------------------------------

function Factoring({
  invoice,
  packets,
  canStart,
  error,
}: {
  invoice: Invoice;
  packets: FactoringPacket[];
  canStart: boolean;
  error: unknown;
}) {
  const companies = useFactoringCompanies();
  const list = companies.data?.pages.flatMap((p) => p.items) ?? [];
  const nameOf = (id: string) => list.find((c) => c.id === id)?.name ?? 'Factoring company';

  // Nothing to show and nothing to do: a draft, or a carrier who doesn't factor.
  if (packets.length === 0 && !canStart) return null;

  return (
    <Card title="Factoring">
      <ErrorNote error={error} />
      {packets.length === 0 && <p className="text-sm text-mute">Not sent to a factor.</p>}
      <ul className="divide-y divide-line">
        {packets.map((p) => (
          <li key={p.id} className="py-2">
            <PacketRow packet={p} companyName={nameOf(p.factoringCompanyId)} />
          </li>
        ))}
      </ul>
      {canStart && <StartPacket invoice={invoice} companies={list} hasPackets={packets.length > 0} />}
    </Card>
  );
}

function PacketRow({ packet, companyName }: { packet: FactoringPacket; companyName: string }) {
  const role = useSession()?.role;
  const submit = useSubmitPacket();
  const respond = useRespondToPacket();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{companyName}</span>
        <Pill tone={PACKET_STATUS_TONE[packet.status]}>{packet.status}</Pill>
      </div>
      {packet.submittedAt && <p className="text-xs text-mute">Sent to them {shortDate(packet.submittedAt)}</p>}
      {packet.status === 'rejected' && packet.rejectionReason && (
        <p className="text-sm text-slate">They said: {packet.rejectionReason}</p>
      )}

      {packet.status === 'assembling' && (
        <button type="button" className="hq-btn hq-btn-ghost" disabled={submit.isPending} onClick={() => submit.mutate(packet.id)}>
          {submit.isPending ? 'Saving…' : "I've sent it to them"}
        </button>
      )}

      {packet.status === 'submitted' && canManageMoney(role) && !rejecting && (
        <div className="flex gap-2">
          <button
            type="button"
            className="hq-btn hq-btn-ghost flex-1 text-ok"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ id: packet.id, outcome: 'accepted' })}
          >
            They accepted
          </button>
          <button type="button" className="hq-btn hq-btn-ghost flex-1 text-bad" onClick={() => setRejecting(true)}>
            They rejected
          </button>
        </div>
      )}

      {rejecting && (
        <div className="space-y-2">
          <Field label="What did they say?">
            <input className="hq-input" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <button
              type="button"
              className="hq-btn hq-btn-primary flex-1"
              disabled={!reason.trim() || respond.isPending}
              onClick={() =>
                respond.mutate(
                  { id: packet.id, outcome: 'rejected', reason: reason.trim() },
                  { onSuccess: () => setRejecting(false) },
                )
              }
            >
              Save
            </button>
            <button type="button" className="hq-btn hq-btn-ghost" onClick={() => setRejecting(false)}>
              Back
            </button>
          </div>
        </div>
      )}

      <ErrorNote error={submit.error ?? respond.error} />
    </div>
  );
}

function StartPacket({
  invoice,
  companies,
  hasPackets,
}: {
  invoice: Invoice;
  companies: { id: string; name: string }[];
  hasPackets: boolean;
}) {
  const assemble = useAssemblePacket();
  const [companyId, setCompanyId] = useState('');

  if (companies.length === 0) {
    return (
      <p className="mt-2 text-sm text-mute">
        To factor this invoice, first{' '}
        <Link to="/pay/factoring" className="text-brand underline">
          add your factoring company
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <Field label={hasPackets ? 'Send to another factor' : 'Send to a factor'}>
        <select className="hq-input" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          <option value="">Choose…</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <button
        type="button"
        className="hq-btn hq-btn-primary"
        disabled={!companyId || assemble.isPending}
        onClick={() =>
          assemble.mutate({ invoiceId: invoice.id, factoringCompanyId: companyId }, { onSuccess: () => setCompanyId('') })
        }
      >
        {assemble.isPending ? 'Starting…' : 'Start a packet'}
      </button>
      <ErrorNote error={assemble.error} />
    </div>
  );
}

/**
 * The PDF the broker gets, rendered fresh by the API each time. Behind a tap
 * rather than loaded with the screen: it's a server render, and most visits
 * here are to record a payment, not to read the invoice.
 */
function InvoicePdf({ invoice }: { invoice: Invoice }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="hq-btn hq-btn-ghost w-full" onClick={() => setOpen(true)}>
        Show the invoice PDF
      </button>
    );
  }
  return (
    <Card title="Invoice PDF">
      <DocumentPreview
        id={invoice.id}
        path={`/v1/invoices/${invoice.id}/pdf`}
        contentType="application/pdf"
        filename={`Invoice-${invoice.reference}.pdf`}
      />
    </Card>
  );
}
