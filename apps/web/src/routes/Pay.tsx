/**
 * HaulQ Pay — invoices, factoring, payments.
 *
 * Same shape as `Loads.tsx`: a filtered table, inline controls per row rather
 * than a second screen per action, and nothing offered that the API would
 * refuse. Two differences worth naming:
 *
 * **Invoices don't get a status dropdown.** `loads.status` has nine values
 * and legitimate skips, so `Loads.tsx` needs `nextStatuses` to build a menu.
 * `invoice_status` has four and moves in one direction — draft → sent → paid,
 * with void as the one branch — so the actions are named buttons instead.
 * `invoiceActions` decides which a role sees, the same rule the mobile app
 * uses: a paid invoice does not get an option that only exists to fail.
 *
 * **Selecting a row, not expanding one.** An invoice's detail — its line
 * items, its payments, its factoring packets — is too much for a table cell
 * and too much for every row at once. One invoice selected at a time, shown
 * below the table, keeps the table scannable and the detail readable.
 *
 * Types, money parsing, role rules and every request come from
 * `@haulq/client`'s `pay.ts` and its hooks, shared with the mobile app.
 */

import {
  AGING_LABEL,
  balanceDue,
  canManageMoney,
  canWritePay,
  centsToInput,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  invoiceActions,
  lineItemsBody,
  PACKET_STATUS_TONE,
  parseDollars,
  settleablePackets,
  useAddFactoringCompany,
  useAssemblePacket,
  useFactoringCompanies,
  useFactoringPackets,
  useGenerateInvoice,
  useInvoiceableLoads,
  useInvoicePayments,
  useInvoice,
  useInvoices,
  useMarkInvoiceSent,
  useRecordPayment,
  useReceivablesAging,
  useRespondToPacket,
  useSubmitPacket,
  useVoidInvoice,
  type AgingBucket,
  type DraftLineItem,
  type FactoringCompany,
  type FactoringPacket,
  type Invoice,
  type PaymentSource,
} from '@haulq/client';
import { INVOICE_STATUSES, type InvoiceStatus } from '@haulq/contracts';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, LoadMore, Money, Num, Pill, useDocumentTitle, useToast } from '../components/ui.tsx';

/** A headline number, same shape as `Insights.tsx`'s `Stat` — kept local per `ui.tsx`'s note on premature abstraction. */
function AgingTile({ bucket, count, totalCents }: AgingBucket) {
  const overdue = bucket !== 'current';
  return (
    <div className="border border-line bg-white p-4">
      <span className="field-label block text-mute">{AGING_LABEL[bucket] ?? bucket}</span>
      <span className={`num mt-1.5 block text-2xl ${overdue && count > 0 ? 'text-bad' : 'text-ink'}`}>
        <Money cents={totalCents} />
      </span>
      <span className="mt-1 block text-xs text-mute">
        {count} {count === 1 ? 'invoice' : 'invoices'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-invoice actions
// ---------------------------------------------------------------------------

/** Records that the invoice went to the broker. It emails nothing; Autopilot's invoice email is what delivers one. */
function SendControl({ invoice }: { invoice: Invoice }) {
  const send = useMarkInvoiceSent();
  const toast = useToast();
  return (
    <>
      <button className="hq-btn hq-btn-primary" disabled={send.isPending} onClick={() => send.mutate(invoice.id, { onSuccess: () => toast(`Invoice ${invoice.reference} marked sent`) })} title="Records that you sent it to the broker">
        {send.isPending ? 'Saving…' : 'Mark sent'}
      </button>
      <ErrorNote error={send.error} />
    </>
  );
}

function VoidControl({ invoice }: { invoice: Invoice }) {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const void_ = useVoidInvoice();
  const toast = useToast();

  if (!open) {
    return (
      <button className="hq-btn hq-btn-ghost text-bad" onClick={() => setOpen(true)}>
        Void
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input className="hq-input w-auto py-1 text-sm" placeholder="Why is this voided?" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button
        className="hq-btn hq-btn-ghost text-bad"
        disabled={!reason.trim() || void_.isPending}
        onClick={() =>
          void_.mutate(
            { id: invoice.id, reason: reason.trim() },
            {
              onSuccess: () => {
                setOpen(false);
                setReason('');
                toast(`Invoice ${invoice.reference} voided`);
              },
            },
          )
        }
      >
        Confirm void
      </button>
      <button className="hq-btn hq-btn-ghost" onClick={() => setOpen(false)}>
        Back
      </button>
      <ErrorNote error={void_.error} />
    </div>
  );
}

/** Starts at what is still owed after any partial payments, so the common case is one click. */
function RecordPaymentControl({ invoice, owedCents, packets }: { invoice: Invoice; owedCents: number; packets: FactoringPacket[] }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(() => centsToInput(owedCents));
  const [source, setSource] = useState<PaymentSource>('broker_direct');
  const [factoringPacketId, setFactoringPacketId] = useState('');
  const [reference, setReference] = useState('');
  const record = useRecordPayment();

  if (!open) {
    return (
      <button
        className="hq-btn hq-btn-primary"
        onClick={() => {
          setAmount(centsToInput(owedCents));
          setOpen(true);
        }}
      >
        Record payment
      </button>
    );
  }

  const cents = parseDollars(amount);

  return (
    <div className="mt-2 grid gap-3 border border-line bg-wash p-3 sm:grid-cols-4">
      <Field label="Amount ($)" {...(cents === null && amount ? { hint: 'Not an amount, like 2400.00.' } : {})}>
        <input className="hq-input" data-numeric="true" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Source">
        <select className="hq-input" value={source} onChange={(e) => setSource(e.target.value as PaymentSource)}>
          <option value="broker_direct">Broker, direct</option>
          <option value="factor">Factor</option>
        </select>
      </Field>
      {source === 'factor' && (
        <Field label="Which packet" hint="Marks it funded once recorded.">
          <select className="hq-input" value={factoringPacketId} onChange={(e) => setFactoringPacketId(e.target.value)}>
            <option value="">Not tracked</option>
            {packets.map((p) => (
              <option key={p.id} value={p.id}>
                Packet {p.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Reference" hint="Check #, ACH trace, factor batch id.">
        <input className="hq-input" value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>

      <div className="flex items-end gap-2 sm:col-span-4">
        <button
          className="hq-btn hq-btn-brand"
          disabled={cents === null || cents <= 0 || record.isPending}
          onClick={() =>
            record.mutate(
              {
                invoiceId: invoice.id,
                amountCents: cents!,
                currency: invoice.totalCurrency,
                source,
                ...(source === 'factor' && factoringPacketId ? { factoringPacketId } : {}),
                ...(reference.trim() ? { reference: reference.trim() } : {}),
              },
              {
                onSuccess: () => {
                  setOpen(false);
                  toast(`Payment recorded on invoice ${invoice.reference}`);
                },
              },
            )
          }
        >
          {record.isPending ? 'Recording…' : 'Record payment'}
        </button>
        <button className="hq-btn hq-btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <div className="sm:col-span-4">
        <ErrorNote error={record.error} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Factoring, for the selected invoice
// ---------------------------------------------------------------------------

function AssemblePacket({ invoice, companies }: { invoice: Invoice; companies: FactoringCompany[] }) {
  const [factoringCompanyId, setFactoringCompanyId] = useState('');
  const assemble = useAssemblePacket();

  if (companies.length === 0) {
    return <p className="text-sm text-mute">Add a factoring company below before assembling a packet.</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className="hq-input w-auto" value={factoringCompanyId} onChange={(e) => setFactoringCompanyId(e.target.value)}>
        <option value="">Choose a factor…</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        className="hq-btn hq-btn-primary"
        disabled={!factoringCompanyId || assemble.isPending}
        onClick={() => assemble.mutate({ invoiceId: invoice.id, factoringCompanyId }, { onSuccess: () => setFactoringCompanyId('') })}
      >
        Assemble packet
      </button>
      <ErrorNote error={assemble.error} />
    </div>
  );
}

function PacketRow({ packet, companyName, canRespond }: { packet: FactoringPacket; companyName: string; canRespond: boolean }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const submit = useSubmitPacket();
  const respond = useRespondToPacket();

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line py-2 first:border-t-0">
      <span className="min-w-32 text-sm font-medium">{companyName}</span>
      <Pill tone={PACKET_STATUS_TONE[packet.status]}>{packet.status}</Pill>

      {packet.status === 'assembling' && (
        <button className="hq-btn hq-btn-ghost" disabled={submit.isPending} onClick={() => submit.mutate(packet.id)}>
          Mark submitted
        </button>
      )}

      {/* The factor's answer is a money decision: owner or accountant, as the API requires. */}
      {packet.status === 'submitted' && canRespond && !rejecting && (
        <>
          <button className="hq-btn hq-btn-ghost text-ok" disabled={respond.isPending} onClick={() => respond.mutate({ id: packet.id, outcome: 'accepted' })}>
            Accepted
          </button>
          <button className="hq-btn hq-btn-ghost text-bad" onClick={() => setRejecting(true)}>
            Rejected
          </button>
        </>
      )}

      {rejecting && (
        <>
          <input
            className="hq-input w-auto py-1 text-sm"
            placeholder="Why did the factor reject it?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            className="hq-btn hq-btn-ghost text-bad"
            disabled={!reason.trim() || respond.isPending}
            onClick={() =>
              respond.mutate(
                { id: packet.id, outcome: 'rejected', reason: reason.trim() },
                {
                  onSuccess: () => {
                    setRejecting(false);
                    setReason('');
                  },
                },
              )
            }
          >
            Confirm
          </button>
          <button className="hq-btn hq-btn-ghost" onClick={() => setRejecting(false)}>
            Back
          </button>
        </>
      )}

      {packet.status === 'rejected' && packet.rejectionReason && <span className="text-xs text-mute">{packet.rejectionReason}</span>}

      <ErrorNote error={submit.error ?? respond.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invoice detail — line items, payments, factoring
// ---------------------------------------------------------------------------

function InvoiceDetail({ invoice, companies, role }: { invoice: Invoice; companies: FactoringCompany[]; role: string | undefined }) {
  const payments = useInvoicePayments(invoice.id);
  const packets = useFactoringPackets(invoice.id);
  const actions = invoiceActions(invoice, role);
  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? 'Unknown factor';
  const owed = payments.data ? balanceDue(invoice, payments.data) : invoice.totalAmount;

  return (
    <Card title={`Invoice ${invoice.reference}`}>
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="field-label mb-2 text-mute">Line items</h3>
          <table className="hq-table">
            <tbody>
              {invoice.lineItems.map((item, i) => (
                <tr key={i}>
                  <td className="text-sm">{item.description}</td>
                  <td className="text-right">
                    <Money cents={item.amountCents} />
                  </td>
                </tr>
              ))}
              <tr>
                <td className="text-sm font-medium">Total</td>
                <td className="text-right font-medium">
                  <Money cents={invoice.totalAmount} />
                </td>
              </tr>
            </tbody>
          </table>

          {invoice.voidReason && <p className="mt-3 border-l-2 border-line bg-wash px-3 py-2 text-sm text-slate">Voided: {invoice.voidReason}</p>}

          <h3 className="field-label mb-2 mt-6 text-mute">Payments</h3>
          <ErrorNote error={payments.error} />
          {payments.data && payments.data.length === 0 && <Empty>No payments recorded yet.</Empty>}
          {payments.data && payments.data.length > 0 && (
            <ul className="space-y-1.5">
              {payments.data.map((p) => (
                <li key={p.id} className="flex items-center justify-between text-sm">
                  <span>
                    <Money cents={p.paymentAmount} />{' '}
                    <span className="text-mute">
                      · {p.source === 'factor' ? 'factor' : 'broker, direct'} · {new Date(p.receivedAt).toLocaleDateString()}
                    </span>
                  </span>
                  {p.reference && <span className="num text-xs text-mute">{p.reference}</span>}
                </li>
              ))}
              {invoice.status === 'sent' && (
                <li className="flex items-center justify-between border-t border-line pt-1.5 text-sm font-medium">
                  <span>Still owed</span>
                  <Money cents={owed} />
                </li>
              )}
            </ul>
          )}

          {actions.recordPayment && (
            <div className="mt-3">
              <RecordPaymentControl invoice={invoice} owedCents={owed} packets={settleablePackets(packets.data ?? [])} />
            </div>
          )}
        </div>

        <div>
          <h3 className="field-label mb-2 text-mute">Factoring</h3>
          <ErrorNote error={packets.error} />
          {packets.data && packets.data.length === 0 && <Empty>No factoring packet started for this invoice.</Empty>}
          {packets.data?.map((packet) => (
            <PacketRow key={packet.id} packet={packet} companyName={companyName(packet.factoringCompanyId)} canRespond={canManageMoney(role)} />
          ))}

          {actions.startPacket && (
            <div className="mt-3">
              <AssemblePacket invoice={invoice} companies={companies} />
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Generating an invoice
// ---------------------------------------------------------------------------

const EMPTY_LINE_ITEM: DraftLineItem = { code: 'linehaul', description: '', amount: '' };

function GenerateInvoice({ onDone, initialLoadId }: { onDone: (createdId?: string) => void; initialLoadId?: string | undefined }) {
  const toast = useToast();
  const loads = useInvoiceableLoads();
  const generate = useGenerateInvoice();
  const [loadId, setLoadId] = useState(initialLoadId ?? '');
  const [items, setItems] = useState<DraftLineItem[]>([EMPTY_LINE_ITEM]);

  const setItem = (i: number, patch: Partial<DraftLineItem>) => setItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, ...patch } : item)));
  const body = lineItemsBody(items);
  const ready = loadId !== '' && 'items' in body;

  return (
    <Card title="Generate an invoice">
      <Field label="Load">
        <select className="hq-input" value={loadId} onChange={(e) => setLoadId(e.target.value)}>
          <option value="">Choose a delivered load…</option>
          {(loads.data ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              Load {l.reference} — {l.brokerName ?? 'no broker'}
            </option>
          ))}
        </select>
      </Field>
      <ErrorNote error={loads.error} />

      <div className="mt-5 space-y-3">
        {items.map((item, i) => (
          <div key={i} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_140px_auto]">
            <Field label="Code">
              <input className="hq-input" value={item.code} onChange={(e) => setItem(i, { code: e.target.value })} />
            </Field>
            <Field label="Description">
              <input className="hq-input" value={item.description} onChange={(e) => setItem(i, { description: e.target.value })} />
            </Field>
            <Field label="Amount ($)">
              <input className="hq-input" data-numeric="true" inputMode="decimal" value={item.amount} onChange={(e) => setItem(i, { amount: e.target.value })} />
            </Field>
            <button className="hq-btn hq-btn-ghost" disabled={items.length === 1} onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}>
              Remove
            </button>
          </div>
        ))}
        {'invalidRow' in body && (
          <p className="text-sm text-bad">Line {body.invalidRow + 1} needs a description and an amount above zero, like 2400.00.</p>
        )}
        <button className="hq-btn hq-btn-ghost" onClick={() => setItems((prev) => [...prev, { ...EMPTY_LINE_ITEM, code: 'fuel_surcharge' }])}>
          + Add line item
        </button>
      </div>

      <div className="mt-6 flex gap-3">
        <button
          className="hq-btn hq-btn-brand"
          disabled={!ready || generate.isPending}
          onClick={() => 'items' in body && generate.mutate({ loadId, lineItems: body.items }, { onSuccess: (invoice) => { toast(`Invoice ${invoice.reference} generated`); onDone(invoice.id); } })}
        >
          {generate.isPending ? 'Generating…' : 'Generate invoice'}
        </button>
        <button className="hq-btn hq-btn-ghost" onClick={() => onDone()}>
          Cancel
        </button>
      </div>

      <ErrorNote error={generate.error} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Factoring companies
// ---------------------------------------------------------------------------

function FactoringCompanies({ canAdd }: { canAdd: boolean }) {
  const companies = useFactoringCompanies();
  const create = useAddFactoringCompany();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const list = companies.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card
      title="Factoring companies"
      action={
        canAdd &&
        !adding && (
          <button className="hq-btn hq-btn-ghost" onClick={() => setAdding(true)}>
            + Add
          </button>
        )
      }
    >
      <ErrorNote error={companies.error} />
      {companies.isSuccess && list.length === 0 && !adding && <Empty>No factoring companies on file yet.</Empty>}

      {list.length > 0 && (
        <ul className="space-y-1.5">
          {list.map((c) => (
            <li key={c.id} className="flex items-center justify-between text-sm">
              <span>{c.name}</span>
              <span className="text-xs text-mute">{c.email ?? c.submissionMethod}</span>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Name">
            <input className="hq-input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email" hint="Where a packet gets sent, for now.">
            <input className="hq-input" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <div className="flex items-end gap-2">
            <button
              className="hq-btn hq-btn-brand"
              disabled={!name.trim() || create.isPending}
              onClick={() =>
                create.mutate(
                  { name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}) },
                  {
                    onSuccess: () => {
                      setName('');
                      setEmail('');
                      setAdding(false);
                    },
                  },
                )
              }
            >
              Add
            </button>
            <button className="hq-btn hq-btn-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
          <div className="sm:col-span-3">
            <ErrorNote error={create.error} />
          </div>
        </div>
      )}

      <LoadMore onClick={() => void companies.fetchNextPage()} loading={companies.isFetchingNextPage} hasMore={companies.hasNextPage} />
    </Card>
  );
}

/** The companies for the selected invoice's factoring section; the same cached list the card shows. */
function useCompanyList(): FactoringCompany[] {
  const companies = useFactoringCompanies();
  return companies.data?.pages.flatMap((p) => p.items) ?? [];
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function PayScreen() {
  useDocumentTitle('Pay');
  const navigate = useNavigate({ from: '/pay' });
  const search = useSearch({ from: '/pay' });
  const filter: InvoiceStatus | '' = search.status ?? '';
  const setFilter = (status: InvoiceStatus | '') =>
    void navigate({ search: (prev) => ({ ...prev, status: status || undefined }), replace: true });
  // Which invoice is open lives in the URL, so a load's "Open in Pay" can
  // land on it, and Back from here returns to the load.
  const selectedId = search.invoice ?? null;
  const setSelectedId = (id: string) => void navigate({ search: (prev) => ({ ...prev, invoice: id }), replace: true });
  const [generating, setGenerating] = useState(Boolean(search.newFor));
  // Closing the form drops `newFor`; generating one also opens what was made.
  const stopGenerating = (createdId?: string) => {
    setGenerating(false);
    if (search.newFor || createdId) {
      void navigate({ search: (prev) => ({ ...prev, newFor: undefined, ...(createdId ? { invoice: createdId } : {}) }), replace: true });
    }
  };
  const session = useSession();
  const orgs = useOrgs();

  const invoices = useInvoices(filter);
  const aging = useReceivablesAging();
  const companies = useCompanyList();

  const role = orgs.data?.items.find((o) => o.id === session?.orgId)?.role;
  const canWrite = canWritePay(role);

  const items = invoices.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = invoices.data?.pages[0]?.counts ?? {};
  // An invoice linked from a load may not be on the list's first page, or
  // under the current filter; fetch it on its own then.
  const listed = items.find((i) => i.id === selectedId);
  const fetched = useInvoice(selectedId ?? '', { enabled: Boolean(selectedId) && invoices.isSuccess && !listed });
  const selected = listed ?? fetched.data ?? null;

  // The detail renders below the list; bring it into view when one is picked.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [selected?.id]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl">Pay</h1>
          <p className="mt-1 max-w-prose text-slate">Invoices generated from delivered loads, sent, factored where you use one, and tracked through to paid.</p>
        </div>
        {canWrite && !generating && (
          <button className="hq-btn hq-btn-primary" onClick={() => setGenerating(true)}>
            Generate an invoice
          </button>
        )}
      </div>

      {aging.data && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {aging.data.map((b) => (
            <AgingTile key={b.bucket} {...b} />
          ))}
        </div>
      )}

      {generating && <GenerateInvoice onDone={stopGenerating} initialLoadId={search.newFor} />}

      <div className="flex flex-wrap gap-1.5">
        <button
          className={`field-label border px-3 py-2 ${filter === '' ? 'border-ink bg-wash text-ink' : 'border-line text-mute hover:text-ink'}`}
          onClick={() => setFilter('')}
        >
          All <Num value={Object.values(counts).reduce((a, b) => a + b, 0)} />
        </button>
        {INVOICE_STATUSES.filter((s) => counts[s]).map((s) => (
          <button
            key={s}
            className={`field-label border px-3 py-2 ${filter === s ? 'border-ink bg-wash text-ink' : 'border-line text-mute hover:text-ink'}`}
            onClick={() => setFilter(s)}
          >
            {INVOICE_STATUS_LABEL[s]} <Num value={counts[s] ?? 0} />
          </button>
        ))}
      </div>

      <Card>
        {invoices.isError && <ErrorNote error={invoices.error} />}
        {invoices.isLoading && <Empty>Loading…</Empty>}
        {invoices.data && items.length === 0 && <Empty>{filter ? `No invoices ${INVOICE_STATUS_LABEL[filter]}.` : 'No invoices yet.'}</Empty>}

        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="hq-table">
              <thead>
                <tr>
                  <th className="field-label">Invoice</th>
                  <th className="field-label">Status</th>
                  <th className="field-label">Total</th>
                  <th className="field-label">Due</th>
                  <th className="field-label">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((invoice) => {
                  const actions = invoiceActions(invoice, role);
                  return (
                    <tr key={invoice.id} className={selectedId === invoice.id ? 'bg-wash' : undefined}>
                      <td>
                        <button className="num block text-left font-medium hover:underline" onClick={() => setSelectedId(invoice.id)}>
                          {invoice.reference}
                        </button>
                      </td>
                      <td>
                        <Pill tone={INVOICE_STATUS_TONE[invoice.status]}>{INVOICE_STATUS_LABEL[invoice.status]}</Pill>
                      </td>
                      <td>
                        <Money cents={invoice.totalAmount} />
                      </td>
                      <td className="text-sm text-slate">{invoice.dueAt ? new Date(invoice.dueAt).toLocaleDateString() : '—'}</td>
                      <td>
                        <div className="flex flex-wrap items-center gap-2">
                          {actions.markSent && <SendControl invoice={invoice} />}
                          {actions.void && <VoidControl invoice={invoice} />}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <LoadMore onClick={() => void invoices.fetchNextPage()} loading={invoices.isFetchingNextPage} hasMore={invoices.hasNextPage} />
      </Card>

      <div ref={detailRef} className="scroll-mt-4">
        {selected && <InvoiceDetail invoice={selected} companies={companies} role={role} />}
      </div>

      <FactoringCompanies canAdd={canManageMoney(role)} />
    </div>
  );
}
