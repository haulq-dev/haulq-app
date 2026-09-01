import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('caps a long queue at 5 rows and offers to show the rest, worst first', async () => {
    const deliveredNotInvoiced = Array.from({ length: 12 }, (_, i) => ({
      loadId: `load-${i}`,
      reference: i,
      brokerName: null,
      // Reverse order on purpose: item 0 is the least urgent, so the
      // component — not fixture order — has to be what sorts worst-first.
      daysSinceDelivered: i + 1,
    }));
    vi.mocked(request).mockResolvedValue(
      aResponse({ actionQueue: { deliveredNotInvoiced, overdueInvoices: [] } }),
    );
    const user = userEvent.setup();

    renderScreen();
    await screen.findByText('Needs attention');

    // The count badge names the true total, not just what's visible.
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText(/delivered 12 days ago/)).toBeInTheDocument();
    expect(screen.queryByText(/delivered 1 days ago/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 7 more' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show 7 more' }));

    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByText(/delivered 1 days ago/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show fewer' }));

    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('does not show an expand toggle when everything already fits', async () => {
    vi.mocked(request).mockResolvedValue(
      aResponse({
        actionQueue: {
          deliveredNotInvoiced: [
            { loadId: 'load-1', reference: 1, brokerName: null, daysSinceDelivered: 8 },
          ],
          overdueInvoices: [],
        },
      }),
    );
    renderScreen();

    await screen.findByText('Needs attention');
    expect(screen.queryByRole('button', { name: /Show/ })).not.toBeInTheDocument();
  });
});
