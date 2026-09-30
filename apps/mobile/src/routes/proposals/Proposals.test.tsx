import type { LoadProposalView } from '@haulq/client';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const session = { current: { userId: 'me', orgId: 'o', orgName: 'Acme', role: 'owner' as string } };
const navigate = vi.fn();

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts');
  return { ...actual, request: vi.fn(), requestBlob: vi.fn().mockResolvedValue(new Blob(['x'], { type: 'image/jpeg' })) };
});
vi.mock('../../lib/haptics.ts', () => ({ tapFeedback: vi.fn(), successFeedback: vi.fn() }));
vi.mock('../../components/AuthGate.tsx', () => ({ useSession: () => session.current }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params?: Record<string, string> }) => (
    <a href={params ? to.replace(/\$(\w+)/g, (_, k: string) => params[k] ?? '') : to}>{children}</a>
  ),
  useParams: () => ({ proposalId: 'P1' }),
  useNavigate: () => navigate,
}));

import { ApiRequestError, request } from '../../lib/api.ts';
import { answerRequests, renderScreen } from '../../test-utils.tsx';
import { ProposalScreen } from './ProposalScreen.tsx';
import { ProposalsBanner, ProposalsScreen, RateConfirmationAction } from './ProposalsScreen.tsx';

URL.createObjectURL = vi.fn(() => 'blob:x');
URL.revokeObjectURL = vi.fn();

function aProposal(overrides: Partial<LoadProposalView> = {}): LoadProposalView {
  return {
    id: 'P1',
    documentId: 'D1',
    status: 'pending',
    filename: 'TQL-ratecon-88213.pdf',
    receivedAt: '2026-09-29T15:00:00Z',
    receivedFrom: 'loads@tql.com',
    load: {
      brokerName: 'TQL',
      brokerLoadNumber: '88213',
      rateAmount: 240_000,
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO', appointmentText: 'FCFS 8-3' },
      ],
    },
    evidence: { rate: 'Total Carrier Pay: $2,400.00' },
    notes: [],
    gaps: ['equipment'],
    canCreate: true,
    matchedLoad: null,
    createdLoadId: null,
    createdAt: '2026-09-29T15:00:00Z',
    ...overrides,
  } as LoadProposalView;
}

beforeEach(() => {
  (request as Mock).mockReset();
  navigate.mockReset();
  session.current = { ...session.current, role: 'owner' };
});

describe('ProposalsScreen and banner', () => {
  it('lists what is waiting, with the lane, rate and what could not be found', async () => {
    answerRequests({
      '/v1/load-proposals?status=pending': { items: [aProposal()] },
      '/v1/load-proposals?status=unreadable': { items: [] },
    });
    renderScreen(<ProposalsScreen />);

    expect(await screen.findByText('Wichita, KS to Denver, CO')).toBeInTheDocument();
    expect(screen.getByText(/\$2,400\.00 · TQL/)).toBeInTheDocument();
    expect(screen.getByText('Could not find the equipment.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /TQL-ratecon/ })).toHaveAttribute('href', '/proposals/P1');
  });

  it('shows the banner on Loads only when something waits, and never to an accountant', async () => {
    answerRequests({ '/v1/load-proposals?status=pending': { items: [aProposal(), aProposal({ id: 'P2' })] } });
    renderScreen(<ProposalsBanner />);
    expect(await screen.findByText(/2 rate confirmations are ready to become loads/)).toBeInTheDocument();

    session.current = { ...session.current, role: 'accountant' };
    (request as Mock).mockClear();
    const { container } = renderScreen(<ProposalsBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('ProposalScreen', () => {
  it('will not create until equipment is chosen, then creates from the form and opens the load', async () => {
    const bodies: unknown[] = [];
    answerRequests({
      '/v1/load-proposals/P1': aProposal(),
      '/v1/load-proposals/P1/create': (o: { body?: unknown }) => {
        bodies.push(o.body);
        return { load: { id: 'L9', reference: 1050 }, proposal: null };
      },
    });
    renderScreen(<ProposalScreen />);

    expect(await screen.findByText('From the document: “Total Carrier Pay: $2,400.00”')).toBeInTheDocument();
    expect(screen.getByText(/Choose the equipment/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create load' })).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText('Equipment'), 'DRY_VAN');
    await userEvent.clear(screen.getByLabelText('Rate (USD)'));
    await userEvent.type(screen.getByLabelText('Rate (USD)'), '2,450.00');
    await userEvent.click(screen.getByRole('button', { name: 'Create load' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ equipment: 'DRY_VAN', brokerName: 'TQL', rate: { amount: 245_000, currency: 'USD' } });
    // The appointment the reader could not turn into a window rides in the comments.
    expect((bodies[0] as { comments: string }).comments).toMatch(/Delivery, Denver, CO: FCFS 8-3/);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { loadId: 'L9' } })));
  });

  it('offers attaching to the load that already has this number, first', async () => {
    const attached: unknown[] = [];
    answerRequests({
      '/v1/load-proposals/P1': aProposal({ matchedLoad: { id: 'L1', reference: 1042 } }),
      '/v1/load-proposals/P1/attach': (o: { body?: unknown }) => {
        attached.push(o.body);
        return { load: { id: 'L1', reference: 1042 }, validation: null };
      },
    });
    renderScreen(<ProposalScreen />);

    await userEvent.click(await screen.findByRole('button', { name: 'Attach to Load 1042' }));
    await waitFor(() => expect(attached).toEqual([{ loadId: 'L1' }]));
  });

  it('on a duplicate number, offers attaching instead or creating anyway', async () => {
    const bodies: { confirmDuplicate?: boolean }[] = [];
    answerRequests({
      '/v1/load-proposals/P1': aProposal({ gaps: [], load: { ...aProposal().load, equipment: 'DRY_VAN' } }),
      '/v1/load-proposals/P1/create': (o: { body: { confirmDuplicate?: boolean } }) => {
        bodies.push(o.body);
        if (!o.body.confirmDuplicate) {
          throw new ApiRequestError(409, { code: 'duplicate_load_number', explanation: 'Load 1042 already has broker load number 88213.' });
        }
        return { load: { id: 'L9', reference: 1050 }, proposal: null };
      },
    });
    renderScreen(<ProposalScreen />);

    await userEvent.click(await screen.findByRole('button', { name: 'Create load' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already has broker load number 88213');
    await userEvent.click(screen.getByRole('button', { name: 'Create a new load anyway' }));
    await waitFor(() => expect(bodies.map((b) => b.confirmDuplicate ?? false)).toEqual([false, true]));
  });

  it('says what became of one already dealt with', async () => {
    answerRequests({ '/v1/load-proposals/P1': aProposal({ status: 'created', createdLoadId: 'L9' }) });
    renderScreen(<ProposalScreen />);
    expect(await screen.findByRole('link', { name: 'Open the load' })).toHaveAttribute('href', '/loads/L9');
    expect(screen.queryByRole('button', { name: 'Create load' })).not.toBeInTheDocument();
  });

  it('tells a dispatcher-less role it is not theirs', () => {
    session.current = { ...session.current, role: 'accountant' };
    renderScreen(<ProposalScreen />);
    expect(screen.getByText(/for owners and dispatchers/)).toBeInTheDocument();
  });
});

describe('RateConfirmationAction', () => {
  it('reads an unattached rate confirmation as a load, and opens the review', async () => {
    answerRequests({
      '/v1/load-proposals?status=pending': { items: [] },
      '/v1/documents/D7/propose-load': aProposal({ id: 'P7' }),
    });
    renderScreen(<RateConfirmationAction documentId="D7" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Read as a load' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { proposalId: 'P7' } })));
  });

  it('links straight to the review when one is already waiting', async () => {
    answerRequests({ '/v1/load-proposals?status=pending': { items: [aProposal({ documentId: 'D7' })] } });
    renderScreen(<RateConfirmationAction documentId="D7" />);
    expect(await screen.findByRole('link', { name: 'Review as a load' })).toHaveAttribute('href', '/proposals/P1');
  });
});
