import { ApiRequestError, type OrgSummary, type Session } from '@haulq/client';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The gate reads the session and org list through AuthGate. Stubbed here so
// these tests need neither Clerk nor a network.
const state: { session: Session | null; orgs: { items: OrgSummary[] } | undefined; error: unknown } = {
  session: null,
  orgs: undefined,
  error: null,
};

vi.mock('./AuthGate.tsx', () => ({
  useSession: () => state.session,
  useOrgs: () => ({
    data: state.orgs,
    isSuccess: state.orgs !== undefined,
    isError: state.error !== null,
    error: state.error,
    isFetching: false,
    refetch: vi.fn(),
  }),
  SignOutLink: () => <span>Sign out</span>,
  SwitchAccountLink: () => <span>Switch account</span>,
  DeleteAccountLink: () => <span>Delete my account</span>,
}));
vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, writeSession: vi.fn() };
});

import { writeSession } from '../lib/api.ts';
import { showsTabBar, SubscriptionGate } from './Shell.tsx';
import { ErrorNote } from './ui.tsx';

function org(overrides: Partial<OrgSummary> = {}): OrgSummary {
  return { id: 'org-1', name: 'Acme Freight', role: 'dispatcher', status: 'active', plan: 'carrier', ...overrides };
}

function renderGate() {
  return render(
    <SubscriptionGate>
      <p>the app</p>
    </SubscriptionGate>,
  );
}

describe('SubscriptionGate', () => {
  beforeEach(() => {
    state.session = { userId: 'clerk', orgId: 'org-1', orgName: 'Acme Freight', role: 'dispatcher' };
    state.orgs = undefined;
    state.error = null;
    vi.mocked(writeSession).mockClear();
  });

  it('lets an active carrier through', () => {
    state.orgs = { items: [org()] };
    renderGate();
    expect(screen.getByText('the app')).toBeInTheDocument();
  });

  it('does not treat still-loading as paid', () => {
    renderGate();
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
    expect(screen.getByText(/checking your account/i)).toBeInTheDocument();
  });

  it.each(['trialing', 'past_due', 'paused', 'cancelled'] as const)(
    'blocks a %s carrier with no purchase path',
    (status) => {
      state.orgs = { items: [org({ status })] };
      renderGate();
      expect(screen.queryByText('the app')).not.toBeInTheDocument();
      expect(screen.getByText(/isn't active right now/)).toBeInTheDocument();
      // Guideline 3.1.1: nothing that reads as buying or managing a plan.
      const text = document.body.textContent ?? '';
      expect(text).not.toMatch(/subscribe|upgrade|pricing|billing|haulq\.ai|\$/i);
      expect(document.querySelectorAll('a[href]')).toHaveLength(0);
    },
  );

  it('points a non-owner at their owner, but not an owner at themselves', () => {
    state.orgs = { items: [org({ status: 'cancelled', role: 'driver' })] };
    const { unmount } = renderGate();
    expect(screen.getByText(/check with your carrier's owner/i)).toBeInTheDocument();
    unmount();

    state.orgs = { items: [org({ status: 'cancelled', role: 'owner' })] };
    renderGate();
    expect(screen.queryByText(/check with your carrier's owner/i)).not.toBeInTheDocument();
  });

  it('drops the org when the membership is gone', () => {
    state.orgs = { items: [org({ id: 'some-other-org' })] };
    renderGate();
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
    expect(writeSession).toHaveBeenCalledWith({ userId: 'clerk' });
  });

  it('syncs a role that changed on the server', () => {
    state.orgs = { items: [org({ role: 'owner' })] };
    renderGate();
    expect(writeSession).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', role: 'owner' }));
  });
});

describe('showsTabBar', () => {
  it('is for office roles, not drivers', () => {
    expect(showsTabBar('owner')).toBe(true);
    expect(showsTabBar('dispatcher')).toBe(true);
    expect(showsTabBar('accountant')).toBe(true);
    expect(showsTabBar('driver')).toBe(false);
    expect(showsTabBar(undefined)).toBe(false);
  });
});

describe('ErrorNote', () => {
  it("replaces the API's upgrade prompt with neutral text", () => {
    render(
      <ErrorNote
        error={new ApiRequestError(403, {
          code: 'not_entitled',
          explanation: 'Track needs the Fleet plan. Contact hello@haulq.ai to upgrade.',
        })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("This isn't included in your carrier's HaulQ plan.");
    expect(screen.getByRole('alert')).not.toHaveTextContent(/upgrade|hello@haulq\.ai/);
  });

  it("still shows the API's own explanation for everything else", () => {
    render(<ErrorNote error={new ApiRequestError(403, { code: 'forbidden', explanation: 'Needs owner access.' })} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Needs owner access.');
  });
});
