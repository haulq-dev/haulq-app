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
 * with void as the one branch — so the actions are three named buttons
 * instead. `canTransitionInvoice` still decides whether Void is offered at
 * all, same reasoning as the loads screen: a paid invoice does not get an
 * option that only exists to fail.
 *
 * **Selecting a row, not expanding one.** An invoice's detail — its line
 * items, its payments, its factoring packets — is too much for a table cell
 * and too much for every row at once. One invoice selected at a time, shown
 * below the table, keeps the table scannable and the detail readable.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  canTransitionInvoice,
  INVOICE_STATUSES,
  type FactoringPacketStatus,
  type InvoiceStatus,
} from '@haulq/contracts';
import { request } from '../lib/api.ts';
import { useOrgs, useSession } from '../components/AuthGate.tsx';
import { Card, Empty, ErrorNote, Field, Money, Num, Pill } from '../components/ui.tsx';

// ---------------------------------------------------------------------------
// Shapes the API returns
// ---------------------------------------------------------------------------

interface LineItem {
  code: string;
  description: string;
  amountCents: number;
  currency: string;
}

interface Invoice {
  id: string;
  loadId: string;
  reference: number;
  status: InvoiceStatus;
  sourceDocumentId: string | null;
  lineItems: LineItem[];
  totalAmount: number;
  totalCurrency: string;
  dueAt: string | null;
  sentAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

interface InvoicesResponse {
  items: Invoice[];
  counts: Record<string, number>;
}

interface Payment {
  id: string;
  invoiceId: string;
  paymentAmount: number;
  paymentCurrency: string;
  source: 'factor' | 'broker_direct';
  receivedAt: string;
  reference: string | null;
  notes: string | null;
  factoringPacketId: string | null;
}

interface FactoringCompany {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  submissionMethod: string;
  active: boolean;
}

interface FactoringPacket {
  id: string;
  invoiceId: string;
  factoringCompanyId: string;
  status: FactoringPacketStatus;
  submittedAt: string | null;
  respondedAt: string | null;
  rejectionReason: string | null;
}

interface AgingBucket {
  bucket: string;
  count: number;
  totalCents: number;
}

interface LoadOption {
  id: string;
  reference: number;
  brokerName: string | null;
  status: string;
}

const AGING_LABEL: Record<string, string> = {
  current: 'Current',
  past_1_30: '1–30 days late',
  past_31_60: '31–60 days late',
  past_61_90: '61–90 days late',
  past_over_90: 'Over 90 days late',
};

const INVOICE_STATUS_TONE: Record<InvoiceStatus, 'ok' | 'warn' | 'neutral'> = {
  draft: 'neutral',
  sent: 'warn',
  paid: 'ok',
  void: 'neutral',
};

const PACKET_STATUS_TONE: Record<FactoringPacketStatus, 'ok' | 'warn' | 'neutral'> = {
  assembling: 'neutral',
  submitted: 'warn',
  accepted: 'ok',
  rejected: 'warn',
  funded: 'ok',
};

const pretty = (s: string) => s.replace(/_/g, ' ');

/** A headline number, same shape as `Insights.tsx`'s `Stat` — kept local
 *  rather than shared, per `ui.tsx`'s own note on premature abstraction. */
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

function SendControl({ invoice }: { invoice: Invoice }) {
  const queryClient = useQueryClient();
  const send = useMutation({
    mutationFn: () => request(`/v1/invoices/${invoice.id}/send`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  return (
    <>
      <button
        className="hq-btn hq-btn-primary"
        disabled={send.isPending}
        onClick={() => send.mutate()}
      >
        {send.isPending ? 'Sending…' : 'Send'}
      </button>
      <ErrorNote error={send.error} />
    </>
  );
}

function VoidControl({ invoice }: { invoice: Invoice }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const void_ = useMutation({
    mutationFn: () => request(`/v1/invoices/${invoice.id}/void`, { method: 'POST', body: { reason } }),
    onSuccess: async () => {
      setOpen(false);
      setReason('');
      await queryClient.invalidateQueries();
    },
  });

  if (!canTransitionInvoice(invoice.status, 'void').allowed) return null;

  if (!open) {
    return (
      <button className="hq-btn hq-btn-ghost text-bad" onClick={() => setOpen(true)}>
        Void
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="hq-input w-auto py-1 text-sm"
        placeholder="Why is this voided?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        className="hq-btn hq-btn-ghost text-bad"
        disabled={!reason.trim() || void_.isPending}
        onClick={() => void_.mutate()}
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

function RecordPaymentControl({
  invoice,
  packets,
}: {
  invoice: Invoice;
  packets: FactoringPacket[];
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(() => (invoice.totalAmount / 100).toFixed(2));
  const [source, setSource] = useState<'broker_direct' | 'factor'>('broker_direct');
  const [factoringPacketId, setFactoringPacketId] = useState('');
  const [reference, setReference] = useState('');

  const record = useMutation({
    mutationFn: () =>
      request(`/v1/invoices/${invoice.id}/payments`, {
        method: 'POST',
        body: {
          amount: { amount: Math.round(Number(amount) * 100), currency: invoice.totalCurrency },
          source,
          ...(source === 'factor' && factoringPacketId ? { factoringPacketId } : {}),
          ...(reference ? { reference } : {}),
        },
      }),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries();
    },
  });

  if (invoice.status !== 'sent') return null;

  const acceptedPackets = packets.filter((p) => p.status === 'accepted' || p.status === 'submitted');

  if (!open) {
    return (
      <button className="hq-btn hq-btn-primary" onClick={() => setOpen(true)}>
        Record payment
      </button>
    );
  }

  return (
    <div className="mt-2 grid gap-3 border border-line bg-wash p-3 sm:grid-cols-4">
      <Field label="Amount ($)">
        <input
          className="hq-input"
          data-numeric="true"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>
      <Field label="Source">
        <select
          className="hq-input"
          value={source}
          onChange={(e) => setSource(e.target.value as typeof source)}
        >
          <option value="broker_direct">Broker, direct</option>
          <option value="factor">Factor</option>
        </select>
      </Field>
      {source === 'factor' && (
        <Field label="Which packet" hint="Marks it funded once recorded.">
          <select
            className="hq-input"
            value={factoringPacketId}
            onChange={(e) => setFactoringPacketId(e.target.value)}
          >
            <option value="">Not tracked</option>
            {acceptedPackets.map((p) => (
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
          disabled={!amount || Number(amount) <= 0 || record.isPending}
          onClick={() => record.mutate()}
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

function AssemblePacket({
  invoice,
  companies,
}: {
  invoice: Invoice;
  companies: FactoringCompany[];
}) {
  const queryClient = useQueryClient();
  const [factoringCompanyId, setFactoringCompanyId] = useState('');
  const assemble = useMutation({
    mutationFn: () =>
      request(`/v1/factoring-packets`, {
        method: 'POST',
        body: { invoiceId: invoice.id, factoringCompanyId, documentIds: [] },
      }),
    onSuccess: async () => {
      setFactoringCompanyId('');
      await queryClient.invalidateQueries();
    },
  });

  if (companies.length === 0) {
    return (
      <p className="text-sm text-mute">
        Add a factoring company below before assembling a packet.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="hq-input w-auto"
        value={factoringCompanyId}
        onChange={(e) => setFactoringCompanyId(e.target.value)}
      >
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
        onClick={() => assemble.mutate()}
      >
        Assemble packet
      </button>
      <ErrorNote error={assemble.error} />
    </div>
  );
}

function PacketRow({ packet, companyName }: { packet: FactoringPacket; companyName: string }) {
  const queryClient = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const submit = useMutation({
    mutationFn: () => request(`/v1/factoring-packets/${packet.id}/submit`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const respond = useMutation({
    mutationFn: (body: { outcome: 'accepted' | 'rejected'; reason?: string }) =>
      request(`/v1/factoring-packets/${packet.id}/response`, { method: 'POST', body }),
    onSuccess: async () => {
      setRejecting(false);
      setReason('');
      await queryClient.invalidateQueries();
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line py-2 first:border-t-0">
      <span className="min-w-32 text-sm font-medium">{companyName}</span>
      <Pill tone={PACKET_STATUS_TONE[packet.status]}>{pretty(packet.status)}</Pill>

      {packet.status === 'assembling' && (
        <button className="hq-btn hq-btn-ghost" disabled={submit.isPending} onClick={() => submit.mutate()}>
          Mark submitted
        </button>
      )}

      {packet.status === 'submitted' && !rejecting && (
        <>
          <button
            className="hq-btn hq-btn-ghost text-ok"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ outcome: 'accepted' })}
          >
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
            onClick={() => respond.mutate({ outcome: 'rejected', reason })}
          >
            Confirm
          </button>
          <button className="hq-btn hq-btn-ghost" onClick={() => setRejecting(false)}>
            Back
          </button>
        </>
      )}

      {packet.status === 'rejected' && packet.rejectionReason && (
        <span className="text-xs text-mute">{packet.rejectionReason}</span>
      )}

      <ErrorNote error={submit.error ?? respond.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invoice detail — line items, payments, factoring
// ---------------------------------------------------------------------------

function InvoiceDetail({
  invoice,
  companies,
  canManageMoney,
}: {
  invoice: Invoice;
  companies: FactoringCompany[];
  canManageMoney: boolean;
}) {
  const payments = useQuery({
    queryKey: ['invoice-payments', invoice.id],
    queryFn: () => request<{ items: Payment[] }>(`/v1/invoices/${invoice.id}/payments`),
  });
  const packets = useQuery({
    queryKey: ['factoring-packets', invoice.id],
    queryFn: () => request<{ items: FactoringPacket[] }>(`/v1/factoring-packets?invoiceId=${invoice.id}`),
  });

  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? 'Unknown factor';

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
                  <td className="text-right"><Money cents={item.amountCents} /></td>
                </tr>
              ))}
              <tr>
                <td className="text-sm font-medium">Total</td>
                <td className="text-right font-medium"><Money cents={invoice.totalAmount} /></td>
              </tr>
            </tbody>
          </table>

          {invoice.voidReason && (
            <p className="mt-3 border-l-2 border-line bg-wash px-3 py-2 text-sm text-slate">
              Voided: {invoice.voidReason}
            </p>
          )}

          <h3 className="field-label mb-2 mt-6 text-mute">Payments</h3>
          {payments.data && payments.data.items.length === 0 && (
            <Empty>No payments recorded yet.</Empty>
          )}
          {payments.data && payments.data.items.length > 0 && (
            <ul className="space-y-1.5">
              {payments.data.items.map((p) => (
                <li key={p.id} className="flex items-center justify-between text-sm">
                  <span>
                    <Money cents={p.paymentAmount} />{' '}
                    <span className="text-mute">
                      · {p.source === 'factor' ? 'factor' : 'broker, direct'} ·{' '}
                      {new Date(p.receivedAt).toLocaleDateString()}
                    </span>
                  </span>
                  {p.reference && <span className="num text-xs text-mute">{p.reference}</span>}
                </li>
              ))}
            </ul>
          )}

          {canManageMoney && (
            <div className="mt-3">
              <RecordPaymentControl invoice={invoice} packets={packets.data?.items ?? []} />
            </div>
          )}
        </div>

        <div>
          <h3 className="field-label mb-2 text-mute">Factoring</h3>
          {packets.data && packets.data.items.length === 0 && (
            <Empty>No factoring packet started for this invoice.</Empty>
          )}
          {packets.data?.items.map((packet) => (
            <PacketRow key={packet.id} packet={packet} companyName={companyName(packet.factoringCompanyId)} />
          ))}

          {canManageMoney && invoice.status !== 'draft' && invoice.status !== 'void' && (
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

interface DraftLineItem {
  code: string;
  description: string;
  amount: string;
}

const EMPTY_LINE_ITEM: DraftLineItem = { code: 'linehaul', description: '', amount: '' };

function GenerateInvoice({ loads, onDone }: { loads: LoadOption[]; onDone: () => void }) {
  const [loadId, setLoadId] = useState('');
  const [items, setItems] = useState<DraftLineItem[]>([EMPTY_LINE_ITEM]);
  const queryClient = useQueryClient();

  const generate = useMutation({
    mutationFn: () =>
      request<Invoice>('/v1/invoices', {
        body: {
          loadId,
          lineItems: items
            .filter((i) => i.description.trim() && i.amount)
            .map((i) => ({
              code: i.code,
              description: i.description,
              amountCents: Math.round(Number(i.amount) * 100),
            })),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onDone();
    },
  });

  const setItem = (i: number, patch: Partial<DraftLineItem>) =>
    setItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, ...patch } : item)));

  const ready =
    loadId && items.some((i) => i.description.trim() && Number(i.amount) > 0);

  return (
    <Card title="Generate an invoice">
      <Field label="Load">
        <select className="hq-input" value={loadId} onChange={(e) => setLoadId(e.target.value)}>
          <option value="">Choose a delivered load…</option>
          {loads.map((l) => (
            <option key={l.id} value={l.id}>
              Load {l.reference} — {l.brokerName ?? 'no broker'}
            </option>
          ))}
        </select>
      </Field>

      <div className="mt-5 space-y-3">
        {items.map((item, i) => (
          <div key={i} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_140px_auto]">
            <Field label="Code">
              <input
                className="hq-input"
                value={item.code}
                onChange={(e) => setItem(i, { code: e.target.value })}
              />
            </Field>
            <Field label="Description">
              <input
                className="hq-input"
                value={item.description}
                onChange={(e) => setItem(i, { description: e.target.value })}
              />
            </Field>
            <Field label="Amount ($)">
              <input
                className="hq-input"
                data-numeric="true"
                inputMode="decimal"
                value={item.amount}
                onChange={(e) => setItem(i, { amount: e.target.value })}
              />
            </Field>
            <button
              className="hq-btn hq-btn-ghost"
              disabled={items.length === 1}
              onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          className="hq-btn hq-btn-ghost"
          onClick={() => setItems((prev) => [...prev, { ...EMPTY_LINE_ITEM, code: 'fuel_surcharge' }])}
        >
          + Add line item
        </button>
      </div>

      <div className="mt-6 flex gap-3">
        <button
          className="hq-btn hq-btn-brand"
          disabled={!ready || generate.isPending}
          onClick={() => generate.mutate()}
        >
          {generate.isPending ? 'Generating…' : 'Generate invoice'}
        </button>
        <button className="hq-btn hq-btn-ghost" onClick={onDone}>
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

function FactoringCompanies({
  companies,
  canManageMoney,
}: {
  companies: FactoringCompany[];
  canManageMoney: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      request('/v1/factoring-companies', {
        body: { name, ...(email ? { email } : {}) },
      }),
    onSuccess: async () => {
      setName('');
      setEmail('');
      setAdding(false);
      await queryClient.invalidateQueries();
    },
  });

  return (
    <Card
      title="Factoring companies"
      action={
        canManageMoney &&
        !adding && (
          <button className="hq-btn hq-btn-ghost" onClick={() => setAdding(true)}>
            + Add
          </button>
        )
      }
    >
      {companies.length === 0 && !adding && <Empty>No factoring companies on file yet.</Empty>}

      {companies.length > 0 && (
        <ul className="space-y-1.5">
          {companies.map((c) => (
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
              onClick={() => create.mutate()}
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
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function PayScreen() {
  const [filter, setFilter] = useState<InvoiceStatus | ''>('');
  const [generating, setGenerating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const session = useSession();
  const orgs = useOrgs();

  const invoices = useQuery({
    queryKey: ['invoices', filter],
    queryFn: () => request<InvoicesResponse>(`/v1/invoices${filter ? `?status=${filter}` : ''}`),
  });
  const aging = useQuery({
    queryKey: ['receivables-aging'],
    queryFn: () => request<{ buckets: AgingBucket[] }>('/v1/invoices/receivables-aging'),
  });
  const companies = useQuery({
    queryKey: ['factoring-companies'],
    queryFn: () => request<{ items: FactoringCompany[] }>('/v1/factoring-companies'),
  });
  // Delivered and invoiced loads: the load has to have gotten far enough to
  // bill, and a load already at `invoiced` may have had its first invoice
  // voided and be waiting on a reissue.
  const loads = useQuery({
    queryKey: ['loads', 'invoiceable'],
    queryFn: () => request<{ items: LoadOption[] }>('/v1/loads?status=delivered,invoiced&limit=200'),
  });

  const myRole = orgs.data?.items.find((o) => o.id === session?.orgId)?.role;
  const canWrite = myRole === 'owner' || myRole === 'dispatcher' || myRole === 'accountant';
  const canManageMoney = myRole === 'owner' || myRole === 'accountant';

  const items = invoices.data?.items ?? [];
  const counts = invoices.data?.counts ?? {};

  // Loads that already carry an open (non-void) invoice do not belong in the
  // picker — generating a second would only bounce off `already_invoiced`.
  const openInvoiceLoadIds = new Set(
    (invoices.data?.items ?? []).filter((i) => i.status !== 'void').map((i) => i.loadId),
  );
  const invoiceableLoads = (loads.data?.items ?? []).filter((l) => !openInvoiceLoadIds.has(l.id));

  const selected = items.find((i) => i.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl">Pay</h1>
          <p className="mt-1 max-w-prose text-slate">
            Invoices generated from delivered loads, sent, factored where you use
            one, and tracked through to paid.
          </p>
        </div>
        {canWrite && !generating && (
          <button className="hq-btn hq-btn-primary" onClick={() => setGenerating(true)}>
            Generate an invoice
          </button>
        )}
      </div>

      {aging.data && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {aging.data.buckets.map((b) => (
            <AgingTile key={b.bucket} {...b} />
          ))}
        </div>
      )}

      {generating && (
        <GenerateInvoice loads={invoiceableLoads} onDone={() => setGenerating(false)} />
      )}

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
            {pretty(s)} <Num value={counts[s] ?? 0} />
          </button>
        ))}
      </div>

      <Card>
        {invoices.isError && <ErrorNote error={invoices.error} />}
        {invoices.data && items.length === 0 && (
          <Empty>{filter ? `Nothing at ${pretty(filter)}.` : 'No invoices yet.'}</Empty>
        )}

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
                {items.map((invoice) => (
                  <tr
                    key={invoice.id}
                    className={selectedId === invoice.id ? 'bg-wash' : undefined}
                  >
                    <td>
                      <button
                        className="num block text-left font-medium hover:underline"
                        onClick={() => setSelectedId(invoice.id)}
                      >
                        {invoice.reference}
                      </button>
                    </td>
                    <td>
                      <Pill tone={INVOICE_STATUS_TONE[invoice.status]}>{pretty(invoice.status)}</Pill>
                    </td>
                    <td><Money cents={invoice.totalAmount} /></td>
                    <td className="text-sm text-slate">
                      {invoice.dueAt ? new Date(invoice.dueAt).toLocaleDateString() : '—'}
                    </td>
                    <td>
                      {canWrite && (
                        <div className="flex flex-wrap items-center gap-2">
                          {invoice.status === 'draft' && <SendControl invoice={invoice} />}
                          {canManageMoney && <VoidControl invoice={invoice} />}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected && (
        <InvoiceDetail
          invoice={selected}
          companies={companies.data?.items ?? []}
          canManageMoney={canManageMoney}
        />
      )}

      <FactoringCompanies companies={companies.data?.items ?? []} canManageMoney={canManageMoney} />
    </div>
  );
}
