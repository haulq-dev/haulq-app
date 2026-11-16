import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../lib/api.ts';
import { PlansScreen } from './PlansScreen.tsx';

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, request: vi.fn() };
});

function renderPlans(pastDue?: boolean) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PlansScreen {...(pastDue === undefined ? {} : { pastDue })} />
    </QueryClientProvider>,
  );
}

function eligibility(canSubscribe: boolean) {
  vi.mocked(request).mockImplementation(async (path: string) => {
    if (path === '/v1/billing/eligibility') return { canSubscribe } as never;
    throw new Error(`unexpected request ${path}`);
  });
}

describe('PlansScreen', () => {
  beforeEach(() => {
    vi.mocked(request).mockReset();
  });

  it('tells a new carrier the price is pilot pricing they keep while subscribed', async () => {
    eligibility(true);
    renderPlans();
    expect(screen.getByRole('note')).toHaveTextContent(/pilot pricing/i);
    expect(screen.getByRole('note')).toHaveTextContent(/keep the price you sign up at/i);
    expect(await screen.findByRole('button', { name: 'Subscribe to Core' })).toBeEnabled();
  });

  it('leaves the pilot pitch off the payment-needs-attention screen', () => {
    eligibility(true);
    renderPlans(true);
    expect(screen.getByText('Your subscription needs attention')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('holds a carrier that is not approved yet, with both plans still visible', async () => {
    eligibility(false);
    renderPlans();
    expect(await screen.findByText('Your pilot application is in review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subscribe to Core' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Subscribe to Fleet' })).toBeDisabled();
  });
});
