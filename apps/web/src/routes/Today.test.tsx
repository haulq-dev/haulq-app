/**
 * Home: setup until the essentials are in, then Today. And Today only shows
 * a section when there is something in it, to a role that can act on it.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const role = { current: 'owner' };

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, request: vi.fn() };
});
vi.mock('../components/AuthGate.tsx', () => ({
  useSession: () => ({ userId: 'me', orgId: 'o', orgName: 'Acme' }),
  useOrgs: () => ({
    isLoading: false,
    data: { userId: 'me', items: [{ id: 'o', name: 'Acme', role: role.current, status: 'active', plan: 'fleet' }] },
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params?: Record<string, string> }) => (
    <a href={params ? to.replace(/\$(\w+)/g, (_, k: string) => params[k] ?? '') : to}>{children}</a>
  ),
}));

import { answerRequests, renderScreen } from '../test-utils.tsx';
import { HomeScreen } from './Today.tsx';

const step = (id: string, done: boolean, required = true) => ({ id, title: id, done, required, unlocks: '', consequence: null });

const stop = (type: 'pickup' | 'delivery', city: string) => ({ id: city, seq: type === 'pickup' ? 1 : 2, type, city, state: 'TX' });

function world(overrides: Record<string, unknown> = {}) {
  answerRequests({
    '/v1/onboarding': { steps: [step('identity', true), step('driver', false, false)], completedRequired: 1, totalRequired: 1, ready: true, factsReconciled: false },
    '/v1/imports/history-summary': { loadCount: 0 },
    '/v1/load-proposals': { items: [] },
    '/v1/documents/counts': { counts: {}, unattached: 0 },
    '/v1/outbound/messages': { messages: [] },
    '/v1/loads': { items: [] },
    '/v1/insights': { actionQueue: { deliveredNotInvoiced: [], overdueInvoices: [] } },
    ...overrides,
  });
}

describe('home', () => {
  it('is the setup checklist until the essentials are in', async () => {
    world({ '/v1/onboarding': { steps: [step('identity', false)], completedRequired: 0, totalRequired: 1, ready: false, factsReconciled: false } });
    renderScreen(<HomeScreen />);
    expect(await screen.findByRole('heading', { name: 'Setting up' })).toBeInTheDocument();
  });

  it('becomes Today once they are, with the optional steps one link away', async () => {
    world();
    renderScreen(<HomeScreen />);
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '1 optional setup step left' })).toHaveAttribute('href', '/setup');
    expect(await screen.findByText(/Nothing needs you right now/)).toBeInTheDocument();
  });

  it('keeps the checklist for a driver, who has no Today', async () => {
    role.current = 'driver';
    world();
    renderScreen(<HomeScreen />);
    expect(await screen.findByRole('heading', { name: 'Setting up' })).toBeInTheDocument();
    role.current = 'owner';
  });
});

describe('Today', () => {
  it('lists loads missing a truck or driver, delivered loads to invoice, and late invoices, each linked', async () => {
    world({
      '/v1/loads': {
        items: [
          { id: 'L1', reference: 4417, status: 'booked', truckId: null, driverId: null, stops: [stop('pickup', 'Fort Worth'), stop('delivery', 'Dallas')] },
          { id: 'L2', reference: 4418, status: 'dispatched', truckId: 't', driverId: 'd', stops: [] },
        ],
      },
      '/v1/insights': {
        actionQueue: {
          deliveredNotInvoiced: [{ loadId: 'L9', reference: 4412, brokerName: 'Lakeshore', daysSinceDelivered: 3 }],
          overdueInvoices: [{ invoiceId: 'I1', reference: 1088, loadReference: 4398, brokerName: 'Redbud', totalCents: 110_000, daysOverdue: 36 }],
        },
      },
    });
    renderScreen(<HomeScreen />);

    expect(await screen.findByText('no truck or driver')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Assign' })).toHaveAttribute('href', '/loads/L1');
    // A load with both is not waiting on anyone.
    expect(screen.queryByText('Load 4418')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invoice it' })).toHaveAttribute('href', '/loads/L9');
    expect(screen.getByText('36 days past due')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing needs you right now/)).not.toBeInTheDocument();
  });

  it('does not count a rate confirmation twice: once as a proposal, again as paperwork', async () => {
    world({
      '/v1/load-proposals': {
        items: [{ id: 'P1', documentId: 'D1', filename: 'rc.pdf', receivedAt: '2026-10-05T00:00:00Z', receivedFrom: null, load: { brokerName: 'Gulfline', stops: [] }, gaps: [], matchedLoad: null }],
      },
      '/v1/documents/counts': { counts: {}, unattached: 3 },
    });
    renderScreen(<HomeScreen />);

    expect(await screen.findByText('Gulfline')).toBeInTheDocument();
    expect(screen.getByText(/aren’t on a load yet/).textContent).toContain('2 documents');
  });

  it('shows an accountant the money, not dispatch work', async () => {
    role.current = 'accountant';
    world({
      '/v1/loads': { items: [{ id: 'L1', reference: 4417, status: 'booked', truckId: null, driverId: null, stops: [] }] },
      '/v1/insights': { actionQueue: { deliveredNotInvoiced: [{ loadId: 'L9', reference: 4412, brokerName: null, daysSinceDelivered: 3 }], overdueInvoices: [] } },
    });
    renderScreen(<HomeScreen />);

    expect(await screen.findByRole('link', { name: 'Invoice it' })).toBeInTheDocument();
    expect(screen.queryByText('Loads nobody is running yet')).not.toBeInTheDocument();
    role.current = 'owner';
  });
});
