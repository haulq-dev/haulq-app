import type { Driver, Truck } from '@haulq/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const session = { current: { userId: 'me', orgId: 'o', orgName: 'Acme', role: 'owner' as string } };
const params = { current: {} as Record<string, string> };
const navigate = vi.fn();

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts');
  return { ...actual, request: vi.fn() };
});
vi.mock('../../lib/haptics.ts', () => ({ tapFeedback: vi.fn(), successFeedback: vi.fn() }));
vi.mock('../../lib/share.ts', () => ({ shareOrCopy: vi.fn().mockResolvedValue('shared'), WEB_ORIGIN: 'https://app.haulq.ai' }));
vi.mock('../../components/AuthGate.tsx', () => ({
  useSession: () => session.current,
  // The real user id, which the session may not carry under Clerk.
  useOrgs: () => ({ data: { items: [], userId: 'me' } }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useParams: () => params.current,
  useNavigate: () => navigate,
}));

import { ApiRequestError, request } from '../../lib/api.ts';
import { shareOrCopy } from '../../lib/share.ts';
import { answerRequests, renderScreen } from '../../test-utils.tsx';
import { DriverScreen, NewDriverScreen } from './DriverScreen.tsx';
import { DriversScreen } from './DriversScreen.tsx';
import { PeopleScreen } from './PeopleScreen.tsx';
import { TruckScreen } from './TruckScreen.tsx';
import { TrucksScreen } from './TrucksScreen.tsx';

function aTruck(overrides: Partial<Truck> = {}): Truck {
  return {
    id: 'T1', label: 'Unit 12', equipment: 'STRAIGHT_BOX', maxWeightLbs: 10_000, maxLengthFt: 26, boxHeightIn: null,
    boxWidthIn: null, capabilities: { liftgate: true }, shortHaulExempt: false, motiveVehicleId: null, active: true,
    ...overrides,
  };
}

function aDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    id: 'D1', fullName: 'Rosa Diaz', phone: '555-0100', email: 'rosa@example.com', cdlNumber: 'K123', cdlState: 'KS',
    cdlExpiresAt: '2030-01-01T12:00:00.000Z', medicalCardExpiresAt: '2020-01-01T12:00:00.000Z', endorsements: [],
    defaultTruckId: null, userId: null,
    ...overrides,
  };
}

const notConnected = () => {
  throw new ApiRequestError(409, { code: 'not_connected', explanation: 'Connect Motive before matching trucks to vehicles.' });
};

beforeEach(() => {
  (request as Mock).mockReset();
  navigate.mockReset();
  session.current = { ...session.current, role: 'owner' };
  params.current = {};
});

describe('TrucksScreen', () => {
  it('offers Motive matches to confirm and Motive vehicles to create, and confirms one', async () => {
    const matched: unknown[] = [];
    answerRequests({
      '/v1/trucks': { items: [aTruck()], nextCursor: null },
      '/v1/integrations/motive/vehicles': {
        vehicles: [
          { id: 7, number: '12', vin: null },
          { id: 8, number: '44', vin: '1FTXX000000123456' },
        ],
        suggestions: [{ truckId: 'T1', truckLabel: 'Unit 12', motiveVehicleId: 7, motiveVehicleNumber: '12' }],
      },
      '/v1/trucks/T1/motive-vehicle': (o: { body?: unknown }) => {
        matched.push(o.body);
        return aTruck({ motiveVehicleId: 7 });
      },
    });
    renderScreen(<TrucksScreen />);

    expect(await screen.findByText('Motive matches to review')).toBeInTheDocument();
    // Vehicle 7 is already suggested, so only 44 is offered to create.
    expect(screen.getByText('Motive 44')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Create truck' })).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(matched).toEqual([{ motiveVehicleId: 7 }]));
  });

  it('says nothing about Motive to a carrier without it, and warns about a truck with no capabilities', async () => {
    answerRequests({
      '/v1/trucks': { items: [aTruck({ capabilities: {} })], nextCursor: null },
      '/v1/integrations/motive/vehicles': notConnected,
    });
    renderScreen(<TrucksScreen />);

    expect(await screen.findByText(/Loads needing equipment may be hidden/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Motive/)).not.toBeInTheDocument();
  });
});

describe('TruckScreen', () => {
  it('saves an edit, clearing a number that was emptied', async () => {
    params.current = { truckId: 'T1' };
    const bodies: unknown[] = [];
    answerRequests({
      '/v1/trucks': { items: [aTruck()], nextCursor: null },
      '/v1/integrations/motive/vehicles': notConnected,
      '/v1/trucks/T1': (o: { body?: unknown }) => {
        bodies.push(o.body);
        return aTruck();
      },
    });
    renderScreen(<TruckScreen />);

    await userEvent.clear(await screen.findByLabelText('Max length (ft)'));
    await userEvent.click(screen.getByRole('checkbox', { name: /Dock high/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ label: 'Unit 12', maxLengthFt: null, maxWeightLbs: 10_000, capabilities: { liftgate: true, dockHigh: true } });
  });

  it('asks before taking a truck out of service', async () => {
    params.current = { truckId: 'T1' };
    const bodies: unknown[] = [];
    answerRequests({
      '/v1/trucks': { items: [aTruck()], nextCursor: null },
      '/v1/integrations/motive/vehicles': notConnected,
      '/v1/trucks/T1/active': (o: { body?: unknown }) => {
        bodies.push(o.body);
        return aTruck({ active: false });
      },
    });
    renderScreen(<TruckScreen />);

    await userEvent.click(await screen.findByRole('button', { name: 'Take out of service' }));
    expect(bodies).toHaveLength(0);
    await userEvent.type(screen.getByLabelText('Why (optional)'), 'Sold');
    await userEvent.click(screen.getByRole('button', { name: 'Take it out' }));
    await waitFor(() => expect(bodies).toEqual([{ active: false, reason: 'Sold' }]));
  });

  it('gives an accountant no edit controls', async () => {
    session.current = { ...session.current, role: 'accountant' };
    params.current = { truckId: 'T1' };
    answerRequests({ '/v1/trucks': { items: [aTruck()], nextCursor: null } });
    renderScreen(<TruckScreen />);

    expect(await screen.findByText(/Only an owner or dispatcher/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });
});

describe('DriversScreen', () => {
  it('leads with who is out of service, linked to the driver to fix it', async () => {
    answerRequests({
      '/v1/drivers/expiring': { items: [{ driverId: 'D1', driverName: 'Rosa Diaz', what: 'medical_card', expiresAt: '2020-01-01T12:00:00.000Z' }] },
      '/v1/drivers': { items: [aDriver()], nextCursor: null },
    });
    renderScreen(<DriversScreen />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Out of service');
    expect(alert).toHaveTextContent('Medical card expired Jan 1, 2020');
    expect(screen.getByText('out of service')).toBeInTheDocument();
  });
});

describe('DriverScreen', () => {
  function answerDriver(extra: Record<string, unknown> = {}) {
    answerRequests({
      '/v1/drivers': { items: [aDriver()], nextCursor: null },
      '/v1/trucks': { items: [aTruck()], nextCursor: null },
      ...extra,
    });
  }

  it('records a renewed medical card', async () => {
    params.current = { driverId: 'D1' };
    const bodies: unknown[] = [];
    answerDriver({
      '/v1/drivers/D1': (o: { body?: unknown }) => {
        bodies.push(o.body);
        return aDriver();
      },
    });
    renderScreen(<DriverScreen />);

    expect(await screen.findByText('Expired Jan 1, 2020')).toBeInTheDocument();
    const medical = screen.getByLabelText('Medical card expires');
    await userEvent.clear(medical);
    await userEvent.type(medical, '2028-05-01');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ medicalCardExpiresAt: '2028-05-01T12:00:00.000Z', fullName: 'Rosa Diaz' });
  });

  it('invites them to the app with a link for their own roster row', async () => {
    params.current = { driverId: 'D1' };
    const bodies: unknown[] = [];
    answerDriver({
      '/v1/members/invites': (o: { body?: unknown }) => {
        bodies.push(o.body);
        return { invitation: { id: 'I1', email: 'rosa@example.com', role: 'driver' }, token: 'tok123' };
      },
    });
    renderScreen(<DriverScreen />);

    await userEvent.click(await screen.findByRole('button', { name: 'Create invite link' }));
    await waitFor(() => expect(bodies).toEqual([{ email: 'rosa@example.com', role: 'driver', driverId: 'D1' }]));
    await userEvent.click(await screen.findByRole('button', { name: 'Share the link' }));
    expect(shareOrCopy).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://app.haulq.ai/invite/tok123' }));
  });

  it("shows the API's reason when a driver on an active load can't be removed", async () => {
    params.current = { driverId: 'D1' };
    answerDriver({
      '/v1/drivers/D1': () => {
        throw new ApiRequestError(409, { code: 'on_active_load', explanation: 'Rosa Diaz is on load 1042. Reassign that load first.' });
      },
    });
    renderScreen(<DriverScreen />);

    await userEvent.click(await screen.findByRole('button', { name: 'Take off the roster' }));
    await userEvent.click(screen.getByRole('button', { name: 'Take off' }));
    expect(await screen.findByText(/on load 1042/)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('NewDriverScreen', () => {
  it('adds a driver and opens them', async () => {
    const bodies: unknown[] = [];
    answerRequests({
      '/v1/trucks': { items: [], nextCursor: null },
      '/v1/drivers': (o: { method?: string; body?: unknown }) => {
        bodies.push(o.body);
        return aDriver({ id: 'D9' });
      },
    });
    renderScreen(<NewDriverScreen />);

    await userEvent.type(screen.getByLabelText('Full name'), 'Sam Ortiz');
    await userEvent.type(screen.getByLabelText('State'), 'ks');
    await userEvent.click(screen.getByRole('button', { name: 'Add driver' }));

    await waitFor(() => expect(bodies).toEqual([{ fullName: 'Sam Ortiz', endorsements: [], cdlState: 'KS' }]));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { driverId: 'D9' } })));
  });
});

describe('PeopleScreen', () => {
  const members = (list: unknown[]) => ({
    members: { items: list, nextCursor: null },
    invitations: { items: [{ id: 'V1', email: 'new@example.com', role: 'dispatcher', driverId: null, expiresAt: '2099-01-01T00:00:00Z', createdAt: '2026-09-20T00:00:00Z', invitedByUserId: null }], nextCursor: null },
  });

  it('protects the last owner and lets an owner change someone else’s role', async () => {
    const bodies: unknown[] = [];
    answerRequests({
      '/v1/members': members([
        { userId: 'me', email: 'me@example.com', fullName: 'Me Owner', role: 'owner', acceptedAt: null },
        { userId: 'u2', email: 'd@example.com', fullName: 'Dee Dispatch', role: 'dispatcher', acceptedAt: null },
      ]),
      '/v1/members/u2': (o: { body?: unknown }) => {
        bodies.push(o.body);
        return {};
      },
      '/v1/drivers': { items: [], nextCursor: null },
    });
    renderScreen(<PeopleScreen />);

    expect(await screen.findByText(/The only owner/)).toBeInTheDocument();
    expect(screen.getByText('new@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Role for Me Owner/ })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Role for Dee Dispatch/ }), 'accountant');
    await waitFor(() => expect(bodies).toEqual([{ role: 'accountant' }]));
    // Only one "Remove" offered: Dee's. Never the last owner, never yourself.
    expect(screen.getAllByRole('button', { name: 'Remove from the account' })).toHaveLength(1);
  });

  it('does not let a dispatcher invite an owner or change roles', async () => {
    session.current = { ...session.current, role: 'dispatcher' };
    answerRequests({
      '/v1/members': members([
        { userId: 'o1', email: 'o@example.com', fullName: 'Olive Owner', role: 'owner', acceptedAt: null },
        { userId: 'me', email: 'me@example.com', fullName: 'Me Dispatch', role: 'dispatcher', acceptedAt: null },
      ]),
      '/v1/drivers': { items: [], nextCursor: null },
    });
    renderScreen(<PeopleScreen />);

    await screen.findByText('Olive Owner');
    expect(screen.queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Role for/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
  });
});
