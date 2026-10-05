/**
 * The work on a load, from the load's own page: moving it along and who runs
 * it, its paperwork, and its invoice.
 *
 * Each of these used to live somewhere else on web — status and truck on the
 * Loads list, paperwork in Documents, the invoice in Pay — so finishing one
 * load meant visiting three screens and finding it again on each. The phone's
 * load screen already had them together (`apps/mobile/src/routes/load/`);
 * this is the same set, in web's idiom. Nothing here is new behaviour: the
 * same endpoints and shared hooks, just in the place the work happens.
 */

import { documentKindLabel } from '@haulq/contracts';
import {
  canWritePay,
  DOCUMENT_STATUS_TONE,
  fileSize,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  loadIsBillable,
  useDocuments,
  useInvoicesForLoad,
} from '@haulq/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { request, type Driver, type Truck } from '../lib/api.ts';
import { Card, ErrorNote, Field, LoadMore, Money, Pill, useToast } from '../components/ui.tsx';
import { Detail } from './Documents.tsx';
import { StatusControl, type Load } from './Loads.tsx';

// ---------------------------------------------------------------------------
// Status and assignment
// ---------------------------------------------------------------------------

/**
 * Status uses the Loads list's own control, so the two can't drift on which
 * moves are offered. Assignment sets the driver as well as the truck: the
 * endpoint always took both, and the list only ever had room for the truck.
 */
export function StatusAndAssignment({ load, trucks, drivers }: { load: Load; trucks: Truck[]; drivers: Driver[] }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const assign = useMutation({
    mutationFn: (next: { truckId: string | null; driverId: string | null }) =>
      request(`/v1/loads/${load.id}/assignment`, { method: 'PATCH', body: next }),
    onSuccess: async () => {
      toast(`Load ${load.reference} assignment saved`);
      await queryClient.invalidateQueries();
    },
  });

  // An out-of-service truck can't take new work, but the one already on this
  // load stays selectable, or the picker would show it as blank.
  const truckOptions = trucks.filter((t) => t.active || t.id === load.truckId);

  return (
    <Card title="Status and assignment">
      <div className="grid gap-5 sm:grid-cols-3">
        <div>
          <span className="field-label mb-1.5 block text-mute">Status</span>
          <StatusControl load={load} />
        </div>
        <Field label="Truck" hint="Needed from dispatched onward.">
          <select
            className="hq-input"
            value={load.truckId ?? ''}
            disabled={assign.isPending}
            onChange={(e) => assign.mutate({ truckId: e.target.value || null, driverId: load.driverId })}
          >
            <option value="">No truck</option>
            {truckOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Driver">
          <select
            className="hq-input"
            value={load.driverId ?? ''}
            disabled={assign.isPending}
            onChange={(e) => assign.mutate({ truckId: load.truckId, driverId: e.target.value || null })}
          >
            <option value="">No driver</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.fullName}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorNote error={assign.error} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Invoice
// ---------------------------------------------------------------------------

/**
 * Once a load is delivered, the next thing it needs is billing. This links
 * to its invoice in Pay, or opens Pay's form with this load already chosen.
 * Shown only to roles that can bill, and only once billing makes sense.
 */
export function LoadInvoice({ load, role }: { load: Load; role: string | undefined }) {
  const show = canWritePay(role) && loadIsBillable(load.status);
  const invoices = useInvoicesForLoad(load.id, { enabled: show });
  if (!show) return null;
  if (invoices.isError) return <ErrorNote error={invoices.error} />;
  if (!invoices.data) return null;

  const open = invoices.data.find((i) => i.status !== 'void');
  if (open) {
    return (
      <Card title="Invoice">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="num font-medium">
            Invoice {open.reference} · <Money cents={open.totalAmount} />
          </span>
          <span className="flex items-center gap-3">
            <Pill tone={INVOICE_STATUS_TONE[open.status]}>{INVOICE_STATUS_LABEL[open.status]}</Pill>
            <Link to="/pay" search={{ invoice: open.id }} className="hq-btn hq-btn-ghost">
              Open in Pay
            </Link>
          </span>
        </div>
      </Card>
    );
  }

  // Paid with only voided invoices behind it: nothing left to do here.
  if (load.status !== 'delivered' && load.status !== 'invoiced') return null;

  return (
    <Card title="Invoice">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate">
          {invoices.data.length > 0 ? 'Its invoice was voided. It can be invoiced again.' : 'Delivered and not invoiced yet.'}
        </p>
        <Link to="/pay" search={{ newFor: load.id }} className="hq-btn hq-btn-primary">
          Create the invoice
        </Link>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Paperwork
// ---------------------------------------------------------------------------

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.tif,.tiff,.heic,application/pdf,image/*';

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * What's on the load, each opening to the same preview and checks the
 * Documents screen shows, and a way to add a file straight onto this load
 * rather than uploading it to the inbox and attaching it after.
 */
export function LoadPaperwork({ loadId }: { loadId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const docs = useDocuments({ loadId });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const items = docs.data?.pages.flatMap((p) => p.items) ?? [];

  const send = async (files: FileList) => {
    setBusy(true);
    setError(null);
    try {
      let added = 0;
      for (const file of Array.from(files)) {
        const res = await request<{ deduped: boolean }>(
          `/v1/documents?${new URLSearchParams({ filename: file.name, loadId })}`,
          { raw: { body: file, contentType: file.type || 'application/octet-stream' } },
        );
        if (!res.deduped) added += 1;
      }
      toast(added > 0 ? `${added === 1 ? 'File' : `${added} files`} added to this load` : 'Already had that file');
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Paperwork"
      action={
        <label className="hq-btn hq-btn-ghost cursor-pointer">
          <input
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              if (e.target.files?.length) void send(e.target.files);
              e.target.value = '';
            }}
          />
          {busy ? 'Uploading…' : 'Add a file'}
        </label>
      }
    >
      <ErrorNote error={error ?? docs.error} />
      {docs.isSuccess && items.length === 0 && (
        <p className="text-sm text-mute">Nothing on this load yet. Rate confirmations, BOLs and PODs attached to it show here.</p>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-line">
          {items.map((doc) => (
            <li key={doc.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 py-3 text-left"
                onClick={() => setOpen(open === doc.id ? null : doc.id)}
                aria-expanded={open === doc.id}
              >
                <span className="min-w-0">
                  <span className="block truncate">{documentKindLabel(doc.kind)}</span>
                  <span className="block truncate text-xs text-mute">
                    {doc.filename ?? 'Untitled'} · {when(doc.receivedAt)}
                    {doc.byteSize ? ` · ${fileSize(doc.byteSize)}` : ''}
                  </span>
                </span>
                <Pill tone={DOCUMENT_STATUS_TONE[doc.status] ?? 'neutral'}>{doc.status}</Pill>
              </button>
              {open === doc.id && <Detail document={doc} />}
            </li>
          ))}
        </ul>
      )}
      <LoadMore onClick={() => void docs.fetchNextPage()} loading={docs.isFetchingNextPage} hasMore={docs.hasNextPage} />
    </Card>
  );
}
