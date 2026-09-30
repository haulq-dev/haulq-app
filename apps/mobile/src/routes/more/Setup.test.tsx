import type { OnboardingStatus } from '@haulq/client';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const session = { current: { userId: 'me', orgId: 'o', orgName: 'Acme', role: 'owner' as string } };

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts');
  return { ...actual, request: vi.fn() };
});
vi.mock('../../components/AuthGate.tsx', () => ({ useSession: () => session.current }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { request } from '../../lib/api.ts';
import { answerRequests, renderScreen } from '../../test-utils.tsx';
import { SetupCard, SetupScreen } from './SetupScreen.tsx';

function status(over: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    steps: [
      { id: 'identity', title: 'Carrier name and authority', done: true, required: true, unlocks: 'Lets HaulQ check broker authority.' },
      {
        id: 'truck',
        title: 'At least one truck',
        done: false,
        required: true,
        unlocks: 'Loads can be matched against the truck.',
        consequence: 'Nothing can be matched or assigned until a truck exists.',
      },
      { id: 'capabilities', title: 'What each truck can do', done: false, required: false, unlocks: 'Equipment is matched.', consequence: 'Loads may be hidden.' },
      { id: 'operating_facts', title: 'What it costs you to run a mile', done: false, required: true, unlocks: 'Real margins.', consequence: 'Margins are estimates.' },
      { id: 'reconcile', title: 'Check those costs against your own loads', done: false, required: false, unlocks: 'Verified costs.', consequence: 'Unverified.' },
    ],
    completedRequired: 1,
    totalRequired: 3,
    ready: false,
    factsReconciled: false,
    ...over,
  };
}

beforeEach(() => {
  (request as Mock).mockReset();
  session.current = { ...session.current, role: 'owner' };
});

describe('SetupScreen', () => {
  it('says what each gap is costing, and sends each step to the screen that does it', async () => {
    answerRequests({ '/v1/onboarding': status() });
    renderScreen(<SetupScreen />);

    expect(await screen.findByText('1 of 3 essentials')).toBeInTheDocument();
    expect(screen.getByText('Nothing can be matched or assigned until a truck exists.')).toBeInTheDocument();

    const truck = screen.getByText('At least one truck').closest('li')!;
    expect(within(truck).getByRole('link', { name: 'Set up' })).toHaveAttribute('href', '/trucks/new');
    const costs = screen.getByText('What it costs you to run a mile').closest('li')!;
    expect(within(costs).getByRole('link', { name: 'Set up' })).toHaveAttribute('href', '/carrier');
    // Done steps offer nothing to do.
    const identity = screen.getByText('Carrier name and authority').closest('li')!;
    expect(within(identity).queryByRole('link')).not.toBeInTheDocument();
  });

  it('says the import is done on the web, without a link out', async () => {
    answerRequests({ '/v1/onboarding': status() });
    renderScreen(<SetupScreen />);
    const reconcile = (await screen.findByText('Check those costs against your own loads')).closest('li')!;
    expect(within(reconcile).getByText(/from HaulQ on the web/)).toBeInTheDocument();
    expect(within(reconcile).queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('SetupCard', () => {
  it('nudges from Loads while an essential is left, naming the next one', async () => {
    answerRequests({ '/v1/onboarding': status() });
    renderScreen(<SetupCard />);
    expect(await screen.findByText('Setting up: 1 of 3 essentials done')).toBeInTheDocument();
    expect(screen.getByText('Next: at least one truck.')).toBeInTheDocument();
  });

  it('disappears once the essentials are in, and never shows to an accountant', async () => {
    answerRequests({ '/v1/onboarding': status({ ready: true, completedRequired: 3 }) });
    const { container } = renderScreen(<SetupCard />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();

    session.current = { ...session.current, role: 'accountant' };
    (request as Mock).mockClear();
    const other = renderScreen(<SetupCard />);
    await new Promise((r) => setTimeout(r, 20));
    expect(other.container).toBeEmptyDOMElement();
    expect(request).not.toHaveBeenCalled();
  });
});
