import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { request } from '../lib/api.ts';
import { InsightsScreen } from './Insights.tsx';

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, request: vi.fn() };
});

// A real RouterProvider is overkill for testing one screen's content — the
// action queue's links just need to render as something with the right
// destination, not actually navigate anywhere.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

const baseSummary = {
  loadCount: 5,
  measurableCount: 5,
  revenueCents: 500000,
  loadedMiles: 1000,
  deadheadMiles: 100,
  revenuePerTotalMileCents: 450,
  revenuePerLoadedMileCents: 500,
  deadheadRatio: 0.1,
  costPerMileCents: 300,
  factsReconciledAt: null,
  periodDays: 90,
};

function aResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    summary: baseSummary,
    byBroker: [],
    byLane: [],
    byTruck: [],
    payment: {
      paidInvoiceCount: 0,
      avgDaysToPayment: null,
      lateCount: 0,
      exceptionRate: null,
      factoringRejectedCount: 0,
      periodDays: 90,
    },
    actionQueue: { deliveredNotInvoiced: [], overdueInvoices: [] },
    ...overrides,
  };
}

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InsightsScreen />
    </QueryClientProvider>,
  );
}

describe('InsightsScreen — action queue', () => {
  it('shows nothing when the queue is empty', async () => {
    vi.mocked(request).mockResolvedValue(aResponse());
    renderScreen();

    await screen.findByText(/Revenue/);
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('lists a stale unbilled load with a link into Loads', async () => {
    vi.mocked(request).mockResolvedValue(
      aResponse({
        actionQueue: {
          deliveredNotInvoiced: [
            { loadId: 'load-1', reference: 42, brokerName: 'Prairie Freight', daysSinceDelivered: 12 },
          ],
          overdueInvoices: [],
        },
      }),
    );
    renderScreen();

    await screen.findByText('Needs attention');
    expect(screen.getByText(/Load 42 \(Prairie Freight\) delivered 12 days ago/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Loads' })).toHaveAttribute('href', '/loads');
  });

  it('lists an overdue invoice with the amount and a link into Pay', async () => {
    vi.mocked(request).mockResolvedValue(
      aResponse({
        actionQueue: {
          deliveredNotInvoiced: [],
          overdueInvoices: [
            {
              invoiceId: 'inv-1',
              reference: 7,
              loadReference: 99,
              brokerName: 'Acme Logistics',
              totalCents: 150000,
              daysOverdue: 5,
            },
          ],
        },
      }),
    );
    renderScreen();

    await screen.findByText('Needs attention');
    expect(
      screen.getByText(/Invoice 7 for load 99 \(Acme Logistics\) is \$1,500, 5 days past due/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Pay' })).toHaveAttribute('href', '/pay');
  });

  it('lists both kinds together', async () => {
    vi.mocked(request).mockResolvedValue(
      aResponse({
        actionQueue: {
          deliveredNotInvoiced: [
            { loadId: 'load-1', reference: 1, brokerName: null, daysSinceDelivered: 8 },
          ],
          overdueInvoices: [
            {
              invoiceId: 'inv-1',
              reference: 1,
              loadReference: 2,
              brokerName: null,
              totalCents: 1000,
              daysOverdue: 1,
            },
          ],
        },
      }),
    );
    renderScreen();

    await waitFor(() => {
      expect(screen.getAllByRole('link')).toHaveLength(2);
    });
  });
});
