import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const session = { current: { userId: 'u', orgId: 'o', orgName: 'Acme', role: 'dispatcher' as string } };

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts');
  return { ...actual, request: vi.fn() };
});
vi.mock('../../lib/share.ts', () => ({ shareOrCopy: vi.fn().mockResolvedValue('shared'), WEB_ORIGIN: 'https://app.haulq.ai' }));
vi.mock('../../lib/haptics.ts', () => ({ tapFeedback: vi.fn(), successFeedback: vi.fn() }));
vi.mock('../../components/AuthGate.tsx', () => ({ useSession: () => session.current }));
vi.mock('../LoadDetail.tsx', () => ({ LoadDetailScreen: () => <p>driver milestone screen</p> }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => ({ loadId: 'L1' }),
}));

import { ApiRequestError, request } from '../../lib/api.ts';
import { shareOrCopy } from '../../lib/share.ts';
import { aLoad, answerRequests, renderScreen } from '../../test-utils.tsx';
import { LoadRoute } from './LoadScreen.tsx';

const TRUCKS = { items: [{ id: 'T1', label: 'Unit 12', active: true }, { id: 'T2', label: 'Unit 9', active: false }] };
const DRIVERS = { items: [{ id: 'D1', fullName: 'Rosa Diaz', phone: '555-0100' }] };

function answerLoad(overrides: Record<string, unknown> = {}) {
  answerRequests({
    '/v1/loads/L1': aLoad(),
    '/v1/loads/L1/tracking': { orgName: 'Acme', loadReference: 1042, status: 'booked', equipment: 'STRAIGHT_BOX', truck: null, stops: [], eta: null },
    '/v1/loads/L1/margin': { reference: 1042, revenueCents: 40_000, loadedMiles: 127, deadheadMiles: 176, revenuePerTotalMileCents: 132, revenuePerLoadedMileCents: 315, basis: 'expected', invoiceStatus: null, invoiceTotalCents: null },
    '/v1/trucks': TRUCKS,
    '/v1/drivers': DRIVERS,
    '/v1/brokers/B1/verification': { mcNumber: null, usdotNumber: null, verification: null, recheckEnabled: false, nextRecheckDue: null },
    '/v1/brokers/B1/document-history': { consideredCount: 0, manualCount: 0 },
    ...overrides,
  });
}

describe('LoadRoute', () => {
  beforeEach(() => {
    (request as Mock).mockReset();
    (shareOrCopy as Mock).mockClear();
    localStorage.clear();
    session.current = { ...session.current, role: 'dispatcher' };
  });

  it('gives a driver the milestone screen, not the office one', () => {
    session.current = { ...session.current, role: 'driver' };
    renderScreen(<LoadRoute />);
    expect(screen.getByText('driver milestone screen')).toBeInTheDocument();
  });

  it('shows an accountant what the load made, but no controls', async () => {
    session.current = { ...session.current, role: 'accountant' };
    answerLoad();
    renderScreen(<LoadRoute />);

    expect(await screen.findByText('What it made')).toBeInTheDocument();
    expect(screen.queryByText('Status and assignment')).not.toBeInTheDocument();
    expect(screen.queryByText('Broker tracking link')).not.toBeInTheDocument();
  });

  it('offers only the moves the status rules allow, and needs a reason to cancel', async () => {
    const patches: unknown[] = [];
    answerLoad({ '/v1/loads/L1/status': (o: { body: unknown }) => patches.push(o.body) });
    renderScreen(<LoadRoute />);

    await screen.findByText('Status and assignment');
    // booked can go forward to dispatched, never back to prospect.
    expect(screen.getByRole('button', { name: 'dispatched' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'prospect' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel…' }));
    const confirm = screen.getByRole('button', { name: 'Cancel load' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Why is this cancelled?'), 'Broker pulled it');
    await userEvent.click(confirm);

    await waitFor(() => expect(patches).toEqual([{ status: 'cancelled', reason: 'Broker pulled it' }]));
  });

  it('assigns truck and driver together, and hides out-of-service trucks', async () => {
    const bodies: unknown[] = [];
    answerLoad({ '/v1/loads/L1/assignment': (o: { body: unknown }) => bodies.push(o.body) });
    renderScreen(<LoadRoute />);

    const truck = await screen.findByLabelText('Truck', { selector: 'select' });
    await waitFor(() => expect(within(truck).getByRole('option', { name: 'Unit 12' })).toBeInTheDocument());
    expect(within(truck).queryByRole('option', { name: 'Unit 9' })).not.toBeInTheDocument();

    await userEvent.selectOptions(truck, 'T1');
    await waitFor(() => expect(bodies).toEqual([{ truckId: 'T1', driverId: null }]));

    await userEvent.selectOptions(screen.getByLabelText('Driver', { selector: 'select' }), 'D1');
    await waitFor(() => expect(bodies[1]).toEqual({ truckId: null, driverId: 'D1' }));
  });

  it("shares the broker's tracking link on the web app's origin, not the app's", async () => {
    answerLoad({ '/v1/loads/L1/visibility-links': { token: 'tok123' } });
    renderScreen(<LoadRoute />);

    await userEvent.click(await screen.findByText('Broker tracking link'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Create and share' })[0]!);

    await waitFor(() =>
      expect(shareOrCopy).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://app.haulq.ai/track/tok123' })),
    );
    expect(await screen.findByText('Sent')).toBeInTheDocument();
  });

  it('keeps an issued check-in code across a remount, and shares it', async () => {
    answerLoad({ '/v1/loads/L1/checkin-links': { token: 'ABC-123', link: { driverId: 'D1' } } });
    const { unmount } = renderScreen(<LoadRoute />);

    await userEvent.click(await screen.findByText('Driver check-in code'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Create and share' })[1]!);
    await waitFor(() => expect(shareOrCopy).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('ABC-123') })));
    unmount();

    renderScreen(<LoadRoute />);
    await userEvent.click(await screen.findByText('Driver check-in code'));
    expect(screen.getByText('ABC-123')).toBeInTheDocument();
  });

  it("replaces the API's upgrade prompt when the plan doesn't include tracking", async () => {
    answerLoad({
      '/v1/loads/L1/visibility-links': () => {
        throw new ApiRequestError(403, { code: 'not_entitled', explanation: 'Track needs the Fleet plan. Contact hello@haulq.ai to upgrade.' });
      },
    });
    renderScreen(<LoadRoute />);

    await userEvent.click(await screen.findByText('Broker tracking link'));
    await userEvent.click(screen.getAllByRole('button', { name: 'Create and share' })[0]!);

    expect(await screen.findByText("This isn't included in your carrier's HaulQ plan.")).toBeInTheDocument();
    expect(screen.queryByText(/hello@haulq\.ai|upgrade/i)).not.toBeInTheDocument();
  });
});
