import type { Invoice } from '@haulq/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const session = { current: { userId: 'u', orgId: 'o', orgName: 'Acme', role: 'owner' as string } };
const search = { current: {} as { loadId?: string } };
const navigate = vi.fn();

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts');
  return { ...actual, request: vi.fn(), requestBlob: vi.fn() };
});
vi.mock('../../lib/haptics.ts', () => ({ tapFeedback: vi.fn(), successFeedback: vi.fn() }));
vi.mock('../../components/AuthGate.tsx', () => ({ useSession: () => session.current }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ invoiceId: 'I1' }),
  useSearch: () => search.current,
  useNavigate: () => navigate,
}));

import { request } from '../../lib/api.ts';
import { aLoad, answerRequests, renderScreen } from '../../test-utils.tsx';
import { InvoiceScreen } from './InvoiceScreen.tsx';
import { NewInvoiceScreen } from './NewInvoiceScreen.tsx';
import { PayScreen } from './PayScreen.tsx';

function anInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'I1', loadId: 'L1', reference: 1001, status: 'sent', sourceDocumentId: null,
    lineItems: [
      { code: 'linehaul', description: 'Linehaul', amountCents: 220_000, currency: 'USD' },
      { code: 'detention', description: 'Detention', amountCents: 20_000, currency: 'USD' },
    ],
    totalAmount: 240_000, totalCurrency: 'USD', dueAt: '2099-10-20T12:00:00Z', sentAt: '2026-09-20T12:00:00Z',
    paidAt: null, voidedAt: null, voidReason: null,
    ...overrides,
  };
}

const AGING = {
  buckets: [
    { bucket: 'current', count: 1, totalCents: 240_000 },
    { bucket: 'past_1_30', count: 1, totalCents: 150_000 },
    { bucket: 'past_31_60', count: 0, totalCents: 0 },
    { bucket: 'past_61_90', count: 0, totalCents: 0 },
    { bucket: 'past_over_90', count: 0, totalCents: 0 },
  ],
};

function answerInvoice(invoice: Invoice, extra: Record<string, unknown> = {}) {
  answerRequests({
    '/v1/invoices/I1': { invoice },
    '/v1/invoices/I1/payments': { items: [] },
    '/v1/factoring-packets?invoiceId=I1': { items: [] },
    '/v1/factoring-companies': { items: [], nextCursor: null },
    '/v1/loads/L1': aLoad({ status: 'invoiced' }),
    ...extra,
  });
}

beforeEach(() => {
  (request as Mock).mockReset();
  navigate.mockReset();
  session.current = { ...session.current, role: 'owner' };
  search.current = {};
});

describe('PayScreen', () => {
  it('leads with what is owed and what of it is late, then the invoices', async () => {
    answerRequests({
      '/v1/invoices/receivables-aging': AGING,
      '/v1/invoices?': {
        items: [anInvoice(), anInvoice({ id: 'I2', reference: 1002, status: 'sent', dueAt: '2026-09-01T12:00:00Z' })],
        counts: { sent: 2, paid: 3 },
        nextCursor: null,
      },
    });
    renderScreen(<PayScreen />);

    expect(await screen.findByText('$3,900.00')).toBeInTheDocument();
    expect(screen.getByText('2 invoices awaiting payment')).toBeInTheDocument();
    expect(screen.getByText(/is late/)).toHaveTextContent('$1,500.00 is late');
    expect(screen.getByText('1–30 days late')).toBeInTheDocument();
    // Only the late buckets with something in them, not a row of zeros.
    expect(screen.queryByText('31–60 days late')).not.toBeInTheDocument();

    expect(await screen.findByText('Invoice 1002')).toBeInTheDocument();
    expect(screen.getByText(/^\d+ days late$/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /awaiting payment/ })).toBeInTheDocument();
  });

  it("never talks about HaulQ's own plan or billing, only the carrier's invoices", async () => {
    answerRequests({
      '/v1/invoices/receivables-aging': AGING,
      '/v1/invoices?': { items: [anInvoice()], counts: { sent: 1 }, nextCursor: null },
    });
    const { container } = renderScreen(<PayScreen />);
    await screen.findByText('Invoice 1001');
    expect(container.textContent).not.toMatch(/subscri|upgrade|stripe|pricing|\bplan\b/i);
  });
});

describe('InvoiceScreen', () => {
  it('records a payment for what is still owed after a partial one, dated and referenced', async () => {
    const posted: unknown[] = [];
    answerInvoice(anInvoice(), {
      '/v1/invoices/I1/payments': (o: { method?: string; body?: unknown } | undefined) => {
        if (o?.method === 'POST') {
          posted.push(o.body);
          return { ok: true };
        }
        return {
          items: [{ id: 'P1', invoiceId: 'I1', paymentAmount: 100_000, paymentCurrency: 'USD', source: 'broker_direct', receivedAt: '2026-09-22T12:00:00Z', reference: null, notes: null, factoringPacketId: null }],
        };
      },
    });
    renderScreen(<InvoiceScreen />);

    expect(await screen.findByText('Still owed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Record a payment' }));
    expect(screen.getByLabelText('Amount ($)')).toHaveValue('1400.00');
    await userEvent.type(screen.getByLabelText('Reference'), 'CHK 5521');
    await userEvent.click(screen.getByRole('button', { name: 'Save payment' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      amount: { amount: 140_000, currency: 'USD' },
      source: 'broker_direct',
      reference: 'CHK 5521',
      receivedAt: expect.any(String),
    });
  });

  it('refuses an amount it would have to guess at', async () => {
    answerInvoice(anInvoice());
    renderScreen(<InvoiceScreen />);
    await userEvent.click(await screen.findByRole('button', { name: 'Record a payment' }));
    const amount = screen.getByLabelText('Amount ($)');
    await userEvent.clear(amount);
    await userEvent.type(amount, '12.345');
    expect(screen.getByRole('button', { name: 'Save payment' })).toBeDisabled();
    expect(screen.getByText(/isn't an amount/)).toBeInTheDocument();
  });

  it('marks a draft sent, and says plainly that it emails nothing', async () => {
    const sent: string[] = [];
    answerInvoice(anInvoice({ status: 'draft', sentAt: null }), {
      '/v1/invoices/I1/send': () => {
        sent.push('I1');
        return anInvoice();
      },
    });
    renderScreen(<InvoiceScreen />);

    expect(await screen.findByText(/doesn't email it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record a payment' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mark as sent' }));
    await waitFor(() => expect(sent).toEqual(['I1']));
  });

  it('gives a dispatcher no money controls', async () => {
    session.current = { ...session.current, role: 'dispatcher' };
    answerInvoice(anInvoice());
    renderScreen(<InvoiceScreen />);

    expect(await screen.findByText('What it bills')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record a payment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void this invoice' })).not.toBeInTheDocument();
  });

  it('does not offer Void on a paid invoice', async () => {
    answerInvoice(anInvoice({ status: 'paid', paidAt: '2026-09-25T12:00:00Z' }));
    renderScreen(<InvoiceScreen />);

    expect(await screen.findByText('What it bills')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Void this invoice' })).not.toBeInTheDocument();
  });

  it('voids with a reason', async () => {
    const bodies: unknown[] = [];
    answerInvoice(anInvoice(), {
      '/v1/invoices/I1/void': (o: { body?: unknown }) => {
        bodies.push(o.body);
        return anInvoice({ status: 'void' });
      },
    });
    renderScreen(<InvoiceScreen />);

    await userEvent.click(await screen.findByRole('button', { name: 'Void this invoice' }));
    expect(screen.getByRole('button', { name: 'Void it' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Why'), 'Wrong rate');
    await userEvent.click(screen.getByRole('button', { name: 'Void it' }));
    await waitFor(() => expect(bodies).toEqual([{ reason: 'Wrong rate' }]));
  });

  it('points at adding a factoring company when there is none to send to', async () => {
    answerInvoice(anInvoice());
    renderScreen(<InvoiceScreen />);
    expect(await screen.findByText('add your factoring company')).toHaveAttribute('href', '/pay/factoring');
  });
});

describe('NewInvoiceScreen', () => {
  it("opened from a load, fills the linehaul from the load's rate, adds a charge, and creates it", async () => {
    search.current = { loadId: 'L1' };
    const bodies: unknown[] = [];
    answerRequests({
      '/v1/loads?status=delivered,invoiced': { items: [aLoad({ status: 'delivered', rateAmount: 220_000 })], nextCursor: null, counts: {} },
      '/v1/invoices?status=draft,sent,paid': { items: [], counts: {}, nextCursor: null },
      '/v1/invoices': (o: { method?: string; body?: unknown }) => {
        bodies.push(o.body);
        return anInvoice({ id: 'I9', status: 'draft' });
      },
    });
    renderScreen(<NewInvoiceScreen />);

    await waitFor(() => expect(screen.getAllByLabelText('Amount ($)')[0]).toHaveValue('2200.00'));
    await userEvent.click(screen.getByRole('button', { name: '+ Lumper' }));
    await userEvent.type(screen.getAllByLabelText('Amount ($)')[1]!, '85');
    expect(screen.getByText('$2,285.00')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Create invoice' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      loadId: 'L1',
      lineItems: [
        { code: 'linehaul', description: 'Linehaul', amountCents: 220_000 },
        { code: 'lumper', description: 'Lumper', amountCents: 8_500 },
      ],
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { invoiceId: 'I9' } })));
  });

  it('does not offer a load that already has an open invoice', async () => {
    answerRequests({
      '/v1/loads?status=delivered,invoiced': { items: [aLoad({ status: 'invoiced' })], nextCursor: null, counts: {} },
      '/v1/invoices?status=draft,sent,paid': { items: [anInvoice()], counts: {}, nextCursor: null },
    });
    renderScreen(<NewInvoiceScreen />);
    expect(await screen.findByText(/No delivered loads are waiting on an invoice/)).toBeInTheDocument();
  });
});
