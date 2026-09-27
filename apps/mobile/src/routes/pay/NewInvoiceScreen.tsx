/**
 * Generate an invoice for a delivered load. Web's `GenerateInvoice` form.
 *
 * Two things web doesn't do, both to save typing on a phone:
 *
 * - **Choosing the load fills in the linehaul** from the load's own rate, as
 *   long as nobody has typed an amount yet. The rate is what the broker
 *   agreed to, so it is almost always the first line.
 * - **Common charges are one tap** (`LINE_ITEM_PRESETS`): fuel surcharge,
 *   detention, lumper and so on add a labelled row, and only the amount is
 *   left to type.
 *
 * Opened from a load's screen, `?loadId=` preselects it. The picker lists only
 * loads that can take an invoice (`invoiceableLoads`), so a load that already
 * has an open one is not offered just to bounce off the API.
 */

import {
  canWritePay,
  centsToInput,
  formatMoney,
  laneEnds,
  LINE_ITEM_PRESETS,
  lineItemsBody,
  useGenerateInvoice,
  useInvoiceableLoads,
  type DraftLineItem,
  type Load,
} from '@haulq/client';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useSession } from '../../components/AuthGate.tsx';
import { Card, ErrorNote, Field, Note } from '../../components/ui.tsx';
import { successFeedback } from '../../lib/haptics.ts';

const blankRow = (code = 'linehaul', description = 'Linehaul'): DraftLineItem => ({ code, description, amount: '' });

function loadLabel(load: Load): string {
  const { pickup, delivery } = laneEnds(load.stops);
  const lane = pickup && delivery ? ` · ${pickup.city} → ${delivery.city}` : '';
  return `Load ${load.reference}${load.brokerName ? ` · ${load.brokerName}` : ''}${lane}`;
}

export function NewInvoiceScreen() {
  const { loadId: preselected } = useSearch({ from: '/pay/new' });
  const role = useSession()?.role;
  const navigate = useNavigate();
  const loads = useInvoiceableLoads();
  const generate = useGenerateInvoice();

  const [loadId, setLoadId] = useState('');
  const [rows, setRows] = useState<DraftLineItem[]>([blankRow()]);
  // What the linehaul was filled with, so picking a different load can
  // replace it, but an amount someone typed is never overwritten.
  const [filled, setFilled] = useState<string | null>(null);
  const [triedPreselect, setTriedPreselect] = useState(false);

  const options = loads.data ?? [];

  function pickLoad(id: string) {
    setLoadId(id);
    const load = options.find((l) => l.id === id);
    const first = rows[0];
    if (!load || load.rateAmount === null || !first || first.code !== 'linehaul') return;
    if (first.amount !== '' && first.amount !== filled) return;
    const amount = centsToInput(load.rateAmount);
    setFilled(amount);
    setRows((prev) => prev.map((row, i) => (i === 0 ? { ...row, amount } : row)));
  }

  // Preselect once the list arrives, the same way a pick would. Set during
  // render, guarded, so there is no empty frame first.
  if (preselected && loads.isSuccess && !triedPreselect) {
    setTriedPreselect(true);
    if (options.some((l) => l.id === preselected)) pickLoad(preselected);
  }

  const setRow = (i: number, patch: Partial<DraftLineItem>) =>
    setRows((prev) => prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const body = lineItemsBody(rows);
  const total = 'items' in body ? body.items.reduce((sum, i) => sum + i.amountCents, 0) : null;
  const ready = loadId !== '' && 'items' in body;

  if (!canWritePay(role)) return null;

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-6">
      <Link to="/pay" className="text-sm text-brand">
        ‹ Pay
      </Link>
      <h1 className="text-2xl">New invoice</h1>

      <Card title="Load">
        {loads.isError && <ErrorNote error={loads.error} />}
        {loads.isLoading && <p className="text-sm text-mute">Loading loads…</p>}
        {loads.isSuccess && options.length === 0 && (
          <Note>No delivered loads are waiting on an invoice. A load shows up here once it's marked delivered.</Note>
        )}
        {preselected && loads.isSuccess && !options.some((l) => l.id === preselected) && (
          <div className="mb-3">
            <Note>That load already has an invoice, or isn't delivered yet.</Note>
          </div>
        )}
        {options.length > 0 && (
          <Field label="Which load">
            <select className="hq-input" value={loadId} onChange={(e) => pickLoad(e.target.value)}>
              <option value="">Choose a delivered load…</option>
              {options.map((l) => (
                <option key={l.id} value={l.id}>
                  {loadLabel(l)}
                </option>
              ))}
            </select>
          </Field>
        )}
      </Card>

      <Card title="Charges">
        <ul className="space-y-4">
          {rows.map((row, i) => {
            const bad = 'invalidRow' in body && body.invalidRow === i;
            return (
              <li key={i} className={`space-y-2 ${i > 0 ? 'border-t border-line pt-4' : ''}`}>
                <div className="grid grid-cols-[1fr_7.5rem] gap-2">
                  <Field label="Description">
                    <input className="hq-input" value={row.description} onChange={(e) => setRow(i, { description: e.target.value })} />
                  </Field>
                  <Field label="Amount ($)">
                    <input
                      className={`hq-input num ${bad ? 'ring-2 ring-bad' : ''}`}
                      inputMode="decimal"
                      value={row.amount}
                      onChange={(e) => setRow(i, { amount: e.target.value })}
                    />
                  </Field>
                </div>
                {bad && <p className="text-sm text-bad">This charge needs a description and an amount above zero.</p>}
                {rows.length > 1 && (
                  <button type="button" className="text-sm text-mute underline" onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}>
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        <p className="field-label mt-5">Add a charge</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {LINE_ITEM_PRESETS.filter((p) => p.code !== 'linehaul').map((p) => (
            <button
              key={p.code}
              type="button"
              className="hq-pill bg-wash px-3 py-1.5 text-[0.8125rem] text-slate"
              onClick={() => setRows((prev) => [...prev, blankRow(p.code, p.description)])}
            >
              + {p.description || 'Other'}
            </button>
          ))}
        </div>
      </Card>

      <div className="hq-card flex items-baseline justify-between px-4 py-3.5">
        <span className="font-semibold">Total</span>
        <span className="num text-xl font-semibold">{total !== null ? formatMoney(total) : '—'}</span>
      </div>

      <button
        type="button"
        className="hq-btn hq-btn-brand w-full"
        disabled={!ready || generate.isPending}
        onClick={() => {
          if (!('items' in body)) return;
          generate.mutate(
            { loadId, lineItems: body.items },
            {
              onSuccess: (invoice) => {
                successFeedback();
                void navigate({ to: '/pay/$invoiceId', params: { invoiceId: invoice.id }, replace: true });
              },
            },
          );
        }}
      >
        {generate.isPending ? 'Creating…' : 'Create invoice'}
      </button>
      <p className="text-center text-xs text-mute">
        It starts as not sent. The due date comes from the broker's payment terms.
      </p>
      <ErrorNote error={generate.error} />
    </div>
  );
}
