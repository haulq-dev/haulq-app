import type { Load, LoadsPage } from '@haulq/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const session = { current: { userId: 'u', orgId: 'o', orgName: 'Acme Freight', role: 'dispatcher' as string } };

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, request: vi.fn() };
});
vi.mock('../components/AuthGate.tsx', () => ({ useSession: () => session.current }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { request } from '../lib/api.ts';
import { aLoad, answerRequests, renderScreen } from '../test-utils.tsx';
import { LoadsScreen } from './Loads.tsx';

const page = (items: Load[], counts: Record<string, number> = { booked: items.length }): LoadsPage => ({
  items,
  counts,
  nextCursor: null,
});

describe('LoadsScreen', () => {
  beforeEach(() => {
    (request as Mock).mockReset();
    session.current = { ...session.current, role: 'dispatcher' };
  });

  it('leads with rate per total mile, deadhead included, and flags a thin one', async () => {
    answerRequests({ '/v1/loads': page([aLoad()]) });
    renderScreen(<LoadsScreen />);

    expect(await screen.findByText('Load 1042')).toBeInTheDocument();
    expect(screen.getByText('Kansas City, MO', { exact: false })).toBeInTheDocument();
    // $400 over 127 + 176 miles = $1.32, under the $1.50 line.
    const total = screen.getByText('$1.32');
    expect(total).toHaveClass('text-warn');
    expect(screen.getByText('$3.15 loaded')).toBeInTheDocument();
  });

  it("won't assume zero deadhead", async () => {
    answerRequests({ '/v1/loads': page([aLoad({ expectedDeadheadMiles: null })]) });
    renderScreen(<LoadsScreen />);
    expect(await screen.findByText('no deadhead recorded')).toBeInTheDocument();
  });

  it('filters by status from org-wide counts', async () => {
    answerRequests({ '/v1/loads': page([aLoad()], { booked: 3, delivered: 2 }) });
    renderScreen(<LoadsScreen />);

    const delivered = await screen.findByRole('tab', { name: /delivered 2/i });
    expect(screen.getByRole('tab', { name: /all 5/i })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(delivered);

    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining('status=delivered'), undefined));
  });

  it('searches after a pause, not on every keystroke', async () => {
    answerRequests({ '/v1/loads': page([aLoad()]) });
    renderScreen(<LoadsScreen />);
    await screen.findByText('Load 1042');

    await userEvent.type(screen.getByRole('searchbox'), 'TQL');
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining('search=TQL'), undefined));
    expect((request as Mock).mock.calls.some(([p]) => String(p).includes('search=T&') || String(p).endsWith('search=T'))).toBe(false);
  });

  it('offers Add to dispatchers, not accountants', async () => {
    answerRequests({ '/v1/loads': page([]) });
    const { unmount } = renderScreen(<LoadsScreen />);
    expect(await screen.findByRole('link', { name: 'Add a load' })).toBeInTheDocument();
    unmount();

    session.current = { ...session.current, role: 'accountant' };
    renderScreen(<LoadsScreen />);
    await screen.findByText('No loads yet.');
    expect(screen.queryByRole('link', { name: 'Add a load' })).not.toBeInTheDocument();
  });
});
