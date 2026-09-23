import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const navigate = vi.fn();

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, request: vi.fn() };
});
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
}));

import { request } from '../lib/api.ts';
import { answerRequests, renderScreen } from '../test-utils.tsx';
import { CreateLoadScreen } from './CreateLoad.tsx';

describe('CreateLoadScreen', () => {
  let created: unknown[];

  beforeEach(() => {
    (request as Mock).mockReset();
    navigate.mockReset();
    created = [];
    answerRequests({
      '/v1/trucks': { items: [{ id: 'T1', label: 'Unit 12', active: true }] },
      '/v1/drivers': { items: [{ id: 'D1', fullName: 'Rosa Diaz' }] },
      // No match, so the automatic coordinate lookup fills nothing in and
      // the body below has no coordinates to account for.
      '/v1/geocode': { candidates: [] },
      '/v1/loads': (o: { body: unknown }) => {
        created.push(o.body);
        return { id: 'NEW' };
      },
    });
  });

  it('needs only a city and state at each end', async () => {
    renderScreen(<CreateLoadScreen />);
    const add = screen.getByRole('button', { name: 'Add load' });
    expect(add).toBeDisabled();

    const [pickupCity, deliveryCity] = screen.getAllByLabelText('City');
    const [pickupState, deliveryState] = screen.getAllByLabelText('State');
    await userEvent.type(pickupCity!, 'Kansas City');
    await userEvent.type(pickupState!, 'mo');
    await userEvent.type(deliveryCity!, 'St. Louis');
    await userEvent.type(deliveryState!, 'mo');
    expect(add).toBeEnabled();
  });

  it('sends money in cents and only the fields that were filled, then opens the load', async () => {
    renderScreen(<CreateLoadScreen />);
    const [pickupCity, deliveryCity] = screen.getAllByLabelText('City');
    const [pickupState, deliveryState] = screen.getAllByLabelText('State');
    await userEvent.type(pickupCity!, 'Kansas City');
    await userEvent.type(pickupState!, 'MO');
    await userEvent.type(deliveryCity!, 'St. Louis');
    await userEvent.type(deliveryState!, 'MO');
    await userEvent.type(screen.getByLabelText('Rate ($)'), '1250.50');
    await userEvent.type(screen.getByLabelText('Deadhead miles'), '40');
    await userEvent.type(screen.getByLabelText('Broker'), 'TQL');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Rosa Diaz' })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText('Driver'), 'D1');

    await userEvent.click(screen.getByRole('button', { name: 'Add load' }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({
      source: 'manual',
      status: 'prospect',
      brokerName: 'TQL',
      rate: { amount: 125_050, currency: 'USD' },
      rateIsLinehaul: false,
      expectedDeadheadMiles: 40,
      driverId: 'D1',
      stops: [
        { type: 'pickup', city: 'Kansas City', state: 'MO' },
        { type: 'delivery', city: 'St. Louis', state: 'MO' },
      ],
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/loads/$loadId', params: { loadId: 'NEW' }, replace: true }),
    );
  });
});
