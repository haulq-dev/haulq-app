import type { InsightsResponse } from '@haulq/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const session = { current: { userId: 'me', orgId: 'o', orgName: 'Acme', role: 'owner' as string } };

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts');
  return { ...actual, request: vi.fn() };
});
vi.mock('../../lib/haptics.ts', () => ({ tapFeedback: vi.fn(), successFeedback: vi.fn() }));
vi.mock('../../lib/share.ts', () => ({ shareOrCopy: vi.fn().mockResolvedValue('copied'), WEB_ORIGIN: 'https://app.haulq.ai' }));
vi.mock('../../components/AuthGate.tsx', () => ({ useSession: () => session.current }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, search }: { children: React.ReactNode; to: string; search?: Record<string, string> }) => (
    <a href={search ? `${to}?${new URLSearchParams(search)}` : to}>{children}</a>
  ),
}));

import { request } from '../../lib/api.ts';
import { answerRequests, renderScreen } from '../../test-utils.tsx';
import { ActivityScreen } from './ActivityScreen.tsx';
import { CarrierScreen } from './CarrierScreen.tsx';
import { InsightsScreen } from './InsightsScreen.tsx';

const row = (key: string, label: string, revenueCents: number, perMile: number | null) => ({
  key, label, loadCount: 3, revenueCents, totalMiles: 1000, revenuePerTotalMileCents: perMile, basis: 'actual' as const,
});

function insights(overrides: Partial<InsightsResponse> = {}): InsightsResponse {
  return {
    summary: {
      loadCount: 12, measurableCount: 10, revenueCents: 2_400_000, loadedMiles: 9000, deadheadMiles: 3000,
      revenuePerTotalMileCents: 180, revenuePerLoadedMileCents: 267, deadheadRatio: 0.25, costPerMileCents: 160,
      factsReconciledAt: null, periodDays: 90,
    },
    byBroker: [row('b1', 'TQL', 1_500_000, 190), row('b2', 'Echo', 900_000, 140)],
    byLane: [row('l1', 'Kansas City → St. Louis', 800_000, 200)],
    byTruck: [],
    payment: { paidInvoiceCount: 8, avgDaysToPayment: 31.5, lateCount: 2, exceptionRate: 0.25, factoringRejectedCount: 0, periodDays: 90 },
    actionQueue: {
      deliveredNotInvoiced: [{ loadId: 'L1', reference: 1042, brokerName: 'TQL', daysSinceDelivered: 4 }],
      overdueInvoices: [{ invoiceId: 'I1', reference: 1001, loadReference: 1030, brokerName: 'Echo', totalCents: 240_000, daysOverdue: 9 }],
    },
    ...overrides,
  };
}

beforeEach(() => {
  (request as Mock).mockReset();
  session.current = { ...session.current, role: 'owner' };
});

describe('InsightsScreen', () => {
  it('leads with what needs doing, each linked straight to the fix, worst first', async () => {
    answerRequests({ '/v1/insights': insights(), '/v1/imports/history-summary': { loadCount: 0 } });
    renderScreen(<InsightsScreen />);

    const card = (await screen.findByText('Needs attention · 2')).closest('section')!;
    const links = within(card).getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '/pay/$invoiceId');
    expect(links[0]).toHaveTextContent('9 days past due');
    expect(links[1]).toHaveAttribute('href', '/pay/new?loadId=L1');
  });

  it('says above or below cost in words, not colour alone, and flags loads left out', async () => {
    answerRequests({ '/v1/insights': insights(), '/v1/imports/history-summary': { loadCount: 0 } });
    renderScreen(<InsightsScreen />);

    expect(await screen.findByText('above your $1.60 cost')).toBeInTheDocument();
    expect(screen.getByText('above cost by $0.30')).toBeInTheDocument();
    expect(screen.getByText('below cost by $0.20')).toBeInTheDocument();
    expect(screen.getByText(/2 of 12 loads have no deadhead recorded/)).toBeInTheDocument();
    expect(screen.getByText(/hasn't been checked against real loads/)).toBeInTheDocument();
  });

  it('switches the breakdown and the period', async () => {
    answerRequests({ '/v1/insights': () => insights(), '/v1/imports/history-summary': { loadCount: 0 } });
    renderScreen(<InsightsScreen />);

    await userEvent.click(await screen.findByRole('tab', { name: 'Lane' }));
    expect(screen.getByText('Kansas City → St. Louis')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Truck' }));
    expect(screen.getByText('No trucks on these loads.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: '30 days' }));
    await waitFor(() =>
      expect((request as Mock).mock.calls.some(([p]) => String(p) === '/v1/insights?days=30')).toBe(true),
    );
  });

  it('shows the imported history when there is one', async () => {
    answerRequests({
      '/v1/insights': insights(),
      '/v1/imports/history-summary': { loadCount: 310, periodDays: 365, earliest: null, latest: null, totalRevenueCents: 60_000_000, totalMiles: 300_000, revenuePerMileCents: 200 },
    });
    renderScreen(<InsightsScreen />);
    expect(await screen.findByText('Your imported history')).toBeInTheDocument();
    expect(screen.getByText('310')).toBeInTheDocument();
  });
});

describe('ActivityScreen', () => {
  it('groups by day and never lets HaulQ’s own actions read as a person’s', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    answerRequests({
      '/v1/timeline': {
        items: [
          { seq: '3', occurredAt: now.toISOString(), verb: 'x', subjectType: 'load', explanation: 'Drafted an invoice email for load 1042.', actorType: 'agent', actorId: 'claude' },
          { seq: '2', occurredAt: yesterday.toISOString(), verb: 'x', subjectType: 'load', explanation: 'Booked load 1042.', actorType: 'user', actorId: 'u' },
        ],
        nextCursor: '2',
      },
    });
    renderScreen(<ActivityScreen />);

    expect(await screen.findByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    const drafted = screen.getByText('Drafted an invoice email for load 1042.').closest('li')!;
    expect(within(drafted).getByText('HaulQ')).toBeInTheDocument();
    // A short page is the last one.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('CarrierScreen', () => {
  const PROFILE = {
    legalName: 'Acme Freight LLC', dbaName: null, mcNumber: '123456', usdotNumber: null, city: 'Wichita', state: 'KS',
    operatingFactsReconciledAt: null, slug: 'acme', customDocsEmail: null,
  };
  const FACTS = { facts: { costPerMileCents: 135, fixedWeeklyCostCents: 90_000 }, issues: [], completeForScoring: true, reconciledAt: null };
  const USAGE = { monthStart: '2026-09-01T00:00:00Z', documentsReceived: 42, invoicesGenerated: 7, trackCheckins: 30, brokerChecks: 2 };

  it('saves only what changed, and clears an emptied field', async () => {
    const bodies: unknown[] = [];
    answerRequests({
      '/v1/org/profile': (o: { method?: string; body?: unknown } | undefined) => {
        if (o?.method === 'PATCH') {
          bodies.push(o.body);
          return { ...PROFILE, dbaName: 'Acme', city: null };
        }
        return PROFILE;
      },
      '/v1/org/operating-facts': FACTS,
      '/v1/usage': USAGE,
    });
    renderScreen(<CarrierScreen />);

    await userEvent.type(await screen.findByLabelText('Doing business as'), 'Acme');
    await userEvent.clear(screen.getByLabelText('City'));
    await userEvent.click(screen.getByRole('button', { name: 'Save carrier' }));
    await waitFor(() => expect(bodies).toEqual([{ dbaName: 'Acme', city: null }]));
  });

  it('checks costs live with the API’s own validator, and blocks a value that is not a number', async () => {
    const bodies: unknown[] = [];
    answerRequests({
      '/v1/org/profile': PROFILE,
      '/v1/org/operating-facts': (o: { method?: string; body?: unknown } | undefined) => {
        if (o?.method === 'PUT') {
          bodies.push(o.body);
          return { saved: true };
        }
        return FACTS;
      },
      '/v1/usage': USAGE,
    });
    renderScreen(<CarrierScreen />);

    const cost = await screen.findByLabelText('Cost per mile ($)');
    expect(cost).toHaveValue('1.35');
    await userEvent.clear(cost);
    await userEvent.type(cost, '1.3.5');
    expect(screen.getByText("That isn't a number.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save costs' })).toBeDisabled();

    await userEvent.clear(cost);
    await userEvent.type(cost, '1.42');
    await userEvent.click(screen.getByRole('button', { name: 'Save costs' }));
    await waitFor(() => expect(bodies).toEqual([{ costPerMileCents: 142, fixedWeeklyCostCents: 90_000 }]));
  });

  it('lets a dispatcher see costs but not change them, and never offers billing', async () => {
    session.current = { ...session.current, role: 'dispatcher' };
    answerRequests({ '/v1/org/profile': PROFILE, '/v1/org/operating-facts': FACTS, '/v1/usage': USAGE });
    const { container } = renderScreen(<CarrierScreen />);

    expect(await screen.findByText('Only an owner or accountant can change these.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save costs' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save carrier' })).toBeInTheDocument();
    await screen.findByText('Documents received');
    expect(container.textContent).not.toMatch(/billing|subscri|stripe|upgrade|pricing/i);
  });

  it('sets the carrier’s own forwarding address', async () => {
    const bodies: unknown[] = [];
    answerRequests({
      '/v1/org/profile': (o: { method?: string; body?: unknown } | undefined) => {
        if (o?.method === 'PATCH') {
          bodies.push(o.body);
          return { ...PROFILE, customDocsEmail: 'docs@acme.com' };
        }
        return PROFILE;
      },
      '/v1/org/operating-facts': FACTS,
      '/v1/usage': USAGE,
    });
    renderScreen(<CarrierScreen />);

    expect(await screen.findByText('docs+acme@docs.haulq.ai')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Use your own address instead' }));
    await userEvent.type(screen.getByLabelText('Your address'), 'docs@acme.com');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toEqual([{ customDocsEmail: 'docs@acme.com' }]));
  });
});
