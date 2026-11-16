import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlansScreen } from './PlansScreen.tsx';

function renderPlans(pastDue?: boolean) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PlansScreen {...(pastDue === undefined ? {} : { pastDue })} />
    </QueryClientProvider>,
  );
}

describe('PlansScreen', () => {
  it('tells a new carrier the price is pilot pricing they keep while subscribed', () => {
    renderPlans();
    expect(screen.getByRole('note')).toHaveTextContent(/pilot pricing/i);
    expect(screen.getByRole('note')).toHaveTextContent(/keep the price you sign up at/i);
  });

  it('leaves the pilot pitch off the payment-needs-attention screen', () => {
    renderPlans(true);
    expect(screen.getByText('Your subscription needs attention')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
