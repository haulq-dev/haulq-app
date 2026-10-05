/**
 * The web screens moved onto `@haulq/client` (Drivers, Pay, People, Trucks),
 * and the driver's nav. What each test pins is a behaviour a carrier would
 * notice if the move had broken it, plus driver editing, which is new on web.
 */

import type { Driver, Invoice, Truck } from '@haulq/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const session = { current: { userId: 'clerk', orgId: 'o', orgName: 'Acme' } };
const role = { current: 'owner' };

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, request: vi.fn() };
});
vi.mock('../components/AuthGate.tsx', () => ({
  useSession: () => session.current,
  useOrgs: () => ({
    isLoading: false,
    // `userId` is the real one; the session's is Clerk's placeholder, as in production.
    data: { userId: 'me', items: [{ id: 'o', name: 'Acme', role: role.current, status: 'active', plan: 'fleet' }] },
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  // Pay keeps its status filter in the URL; with no router, it's unfiltered.
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));

import { request } from '../lib/api.ts';
import { answerRequests, renderScreen } from '../test-utils.tsx';
import { navFor } from '../components/Shell.tsx';
import { DriversScreen } from './Drivers.tsx';
import { MembersScreen } from './Members.tsx';
import { PayScreen } from './Pay.tsx';
import { TrucksScreen } from './Trucks.tsx';

const aDriver = (over: Partial<Driver> = {}): Driver => ({
  id: 'D1', fullName: 'Rosa Diaz', phone: '555-0100', email: null, cdlNumber: 'K123', cdlState: 'KS',
  cdlExpiresAt: '2030-01-01T12:00:00.000Z', medicalCardExpiresAt: '2020-01-01T12:00:00.000Z', endorsements: [],
  defaultTruckId: null, userId: null, ...over,
});

const aTruck = (over: Partial<Truck> = {}): Truck => ({
  id: 'T1', label: 'Unit 12', equipment: 'STRAIGHT_BOX', maxWeightLbs: 10_000, maxLengthFt: 26, boxHeightIn: null,
  boxWidthIn: null, capabilities: { liftgate: true }, shortHaulExempt: false, motiveVehicleId: null, active: true, ...over,
});

const anInvoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: 'I1', loadId: 'L1', reference: 1001, status: 'sent', sourceDocumentId: null,
  lineItems: [{ code: 'linehaul', description: 'Linehaul', amountCents: 240_000, currency: 'USD' }],
  totalAmount: 240_000, totalCurrency: 'USD', dueAt: '2099-01-01T00:00:00Z', sentAt: '2026-09-20T00:00:00Z',
  paidAt: null, voidedAt: null, voidReason: null, ...over,
});

beforeEach(() => {
  (request as Mock).mockReset();
  role.current = 'owner';
});

describe('the nav', () => {
  it('gives a driver their loads and paperwork, and nothing account-wide', () => {
    const driver = navFor('driver');
    expect(driver.primary.map((i) => i.to)).toEqual(['/loads', '/documents']);
    expect(driver.fleet).toEqual([]);
    expect(driver.account).toEqual([]);

    for (const office of ['owner', 'dispatcher', 'accountant']) {
      const nav = navFor(office);
      expect(nav.primary.map((i) => i.to)).toContain('/insights');
      expect(nav.account.map((i) => i.to)).toContain('/timeline');
    }
  });
});

describe('Drivers (web)', () => {
  it('records a renewed medical card through the new edit form', async () => {
    const bodies: unknown[] = [];
    answerRequests({
      '/v1/drivers/expiring': { items: [] },
      '/v1/drivers': { items: [aDriver()], nextCursor: null },
      '/v1/trucks': { items: [] },
      '/v1/drivers/D1': (o: { body?: unknown }) => {
        bodies.push(o.body);
        return aDriver();
      },
    });
    renderScreen(<DriversScreen />);

    const row = (await screen.findByText('Rosa Diaz')).closest('tr')!;
    expect(within(row).getByText(/expired/)).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));

    const medical = screen.getByLabelText('Medical card expires');
    await userEvent.clear(medical);
    await userEvent.type(medical, '2028-05-01');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(bodies[0]).toMatchObject({ medicalCardExpiresAt: '2028-05-01T12:00:00.000Z' }));
  });

  it('gives an accountant no add or edit', async () => {
    role.current = 'accountant';
    answerRequests({ '/v1/drivers/expiring': { items: [] }, '/v1/drivers': { items: [aDriver()], nextCursor: null }, '/v1/trucks': { items: [] } });
    renderScreen(<DriversScreen />);
    await screen.findByText('Rosa Diaz');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a driver' })).not.toBeInTheDocument();
  });
});

describe('Pay (web)', () => {
  function world(invoice: Invoice, extra: Record<string, unknown> = {}) {
    answerRequests({
      '/v1/invoices?': { items: [invoice], counts: { [invoice.status]: 1 }, nextCursor: null },
      '/v1/invoices/receivables-aging': { buckets: [] },
      '/v1/factoring-companies': { items: [], nextCursor: null },
      '/v1/invoices/I1/payments': {
        items: [{ id: 'P1', invoiceId: 'I1', paymentAmount: 100_000, paymentCurrency: 'USD', source: 'broker_direct', receivedAt: '2026-09-22T00:00:00Z', reference: null, notes: null, factoringPacketId: null }],
      },
      '/v1/factoring-packets': { items: [] },
      ...extra,
    });
  }

  it('starts a payment at what is still owed, not the invoice total', async () => {
    world(anInvoice());
    renderScreen(<PayScreen />);
    await userEvent.click(await screen.findByRole('button', { name: '1001' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    expect(screen.getByLabelText('Amount ($)')).toHaveValue('1400.00');
  });

  it('never offers Void on a paid invoice, and says "Mark sent" for a draft', async () => {
    world(anInvoice({ status: 'paid', paidAt: '2026-09-25T00:00:00Z' }));
    const { unmount } = renderScreen(<PayScreen />);
    await screen.findByRole('button', { name: '1001' });
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
    unmount();

    world(anInvoice({ status: 'draft', sentAt: null }));
    renderScreen(<PayScreen />);
    expect(await screen.findByRole('button', { name: 'Mark sent' })).toBeInTheDocument();
  });
});

describe('People (web)', () => {
  it('never offers removing yourself, even when another owner exists', async () => {
    answerRequests({
      '/v1/members': {
        members: {
          items: [
            { userId: 'me', email: 'me@example.com', fullName: 'Me Owner', role: 'owner', acceptedAt: null },
            { userId: 'other', email: 'o@example.com', fullName: 'Other Owner', role: 'owner', acceptedAt: null },
          ],
          nextCursor: null,
        },
        invitations: { items: [], nextCursor: null },
      },
      '/v1/drivers': { items: [], nextCursor: null },
    });
    renderScreen(<MembersScreen />);

    const mine = (await screen.findByText('Me Owner')).closest('tr')!;
    expect(within(mine).getByText('you')).toBeInTheDocument();
    expect(within(mine).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    const theirs = screen.getByText('Other Owner').closest('tr')!;
    expect(within(theirs).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('protects the only owner, and hands out an invite link', async () => {
    answerRequests({
      '/v1/members': {
        members: { items: [{ userId: 'me', email: 'me@example.com', fullName: 'Me Owner', role: 'owner', acceptedAt: null }], nextCursor: null },
        invitations: { items: [], nextCursor: null },
      },
      '/v1/drivers': { items: [], nextCursor: null },
      '/v1/members/invites': { invitation: { id: 'V1', email: 'new@example.com', role: 'dispatcher' }, token: 'tok123' },
    });
    renderScreen(<MembersScreen />);

    expect(await screen.findByText(/The only owner/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email'), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByText(/\/invite\/tok123$/)).toBeInTheDocument();
  });
});

describe('Trucks (web)', () => {
  it('warns about a truck with no capabilities, and says nothing about Motive when it is not connected', async () => {
    const { ApiRequestError } = await import('../lib/api.ts');
    answerRequests({
      '/v1/trucks': { items: [aTruck({ capabilities: {} })], nextCursor: null },
      '/v1/integrations/motive/vehicles': () => {
        throw new ApiRequestError(409, { code: 'not_connected', explanation: 'Connect Motive first.' });
      },
    });
    renderScreen(<TrucksScreen />);
    expect(await screen.findByText(/Nothing set — loads needing equipment may be hidden/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
