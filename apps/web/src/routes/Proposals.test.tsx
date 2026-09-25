import { ApiClientProvider, ApiRequestError, type ApiClient, type LoadProposalView } from '@haulq/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { request, writeSession } from '../lib/api.ts';
import { ProposalReviewScreen } from './ProposalReview.tsx';
import { ProposalsBanner, ProposalsScreen, RateConfirmationAction } from './Proposals.tsx';

// The org list (and so the role) still comes through the web app's own request.
vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, request: vi.fn() };
});

const navigate = vi.fn();
vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    Link: ({ children, to, params, className }: { children: React.ReactNode; to: string; params?: Record<string, string>; className?: string }) => (
      <a href={params ? to.replace(/\$(\w+)/g, (_, k: string) => params[k] ?? '') : to} className={className}>
        {children}
      </a>
    ),
    useNavigate: () => navigate,
    useParams: () => ({ proposalId: 'p1' }),
  };
});

const NOW = '2026-09-25T15:00:00.000Z';

const view = (over: Partial<LoadProposalView> = {}): LoadProposalView => ({
  id: 'p1',
  documentId: 'd1',
  status: 'pending',
  filename: 'ratecon.pdf',
  receivedAt: NOW,
  receivedFrom: 'dispatch@prairielogistics.example.com',
  load: {
    brokerName: 'Prairie Logistics LLC',
    brokerLoadNumber: '84213',
    rateAmount: 240_000,
    weightLbs: 42_000,
    equipment: 'DRY_VAN',
    commodity: 'Packaged food',
    stops: [
      { type: 'pickup', facilityName: 'Prairie Foods', addressLine1: '1200 Industrial Blvd', city: 'Wichita', state: 'KS', postalCode: '67202', appointmentText: '09/28/2026 08:00-12:00' },
      { type: 'delivery', city: 'Denver', state: 'CO', appointmentText: '09/30/2026 0800-1200', windowStart: '2026-09-30T14:00:00.000Z', windowEnd: '2026-09-30T18:00:00.000Z' },
    ],
  },
  evidence: { rate: '$2,400.00', 'broker.name': 'Prairie Logistics LLC', 'stops.0.city': 'Wichita', 'stops.1.city': 'Denver' },
  notes: ['The pickup in Wichita, KS has an appointment ("09/28/2026 08:00-12:00") that was not set as a window because its date, time or time zone was not certain.'],
  gaps: [],
  canCreate: true,
  matchedLoad: null,
  createdLoadId: null,
  createdAt: NOW,
  ...over,
});

interface World {
  role?: string;
  pending?: LoadProposalView[];
  unreadable?: LoadProposalView[];
  one?: LoadProposalView;
  /** Answer a mutation. Anything not listed answers ok. */
  answer?: Record<string, unknown | Error>;
}

function renderWith(ui: React.ReactNode, world: World = {}) {
  const w = { role: 'dispatcher', pending: [], unreadable: [], one: view(), answer: {}, ...world };
  writeSession({ userId: 'user-1', orgId: 'org-1' });
  vi.mocked(request).mockImplementation(async (path: string) => {
    if (path === '/v1/orgs') return { items: [{ id: 'org-1', name: 'Prairie Freight', role: w.role, status: 'active' }] };
    throw new Error(`unexpected web request: ${path}`);
  });
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const client: ApiClient = {
    request: vi.fn(async (path: string, options?: { method?: string; body?: unknown }) => {
      const method = options?.method ?? 'GET';
      calls.push({ path, method, body: options?.body });
      const scripted = w.answer[`${method} ${path}`];
      if (scripted instanceof Error) throw scripted;
      if (scripted !== undefined) return scripted;
      if (path === '/v1/load-proposals?status=pending') return { items: w.pending };
      if (path === '/v1/load-proposals?status=unreadable') return { items: w.unreadable };
      if (path.startsWith('/v1/load-proposals/') && method === 'GET') return w.one;
      return { ok: true };
    }) as ApiClient['request'],
    requestBlob: vi.fn(async () => new Blob(['%PDF-'], { type: 'application/pdf' })),
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const { unmount } = render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>{ui}</ApiClientProvider>
    </QueryClientProvider>,
  );
  return { calls, client, unmount };
}

const posted = (calls: Array<{ path: string; method: string; body: unknown }>, path: string) => calls.find((c) => c.method === 'POST' && c.path === path);

beforeEach(() => {
  vi.mocked(request).mockReset();
  navigate.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

describe('the list', () => {
  it('shows what was read, and links to review it', async () => {
    renderWith(<ProposalsScreen />, { pending: [view()] });

    expect(await screen.findByText('ratecon.pdf')).toBeInTheDocument();
    expect(screen.getByText('Wichita, KS to Denver, CO')).toBeInTheDocument();
    expect(screen.getByText(/\$2,400\.00 · Dry van · Prairie Logistics LLC/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/proposals/p1');
  });

  it('says what could not be found, and flags a load that already has the number', async () => {
    renderWith(<ProposalsScreen />, { pending: [view({ gaps: ['rate', 'equipment'], matchedLoad: { id: 'L1', reference: 1042 } })] });
    expect(await screen.findByText('Could not find the rate and the equipment.')).toBeInTheDocument();
    expect(screen.getByText('Load 1042 has this number')).toBeInTheDocument();
  });

  it('says so when nothing is waiting, and points at Documents for older ones', async () => {
    renderWith(<ProposalsScreen />);
    expect(await screen.findByText(/Nothing is waiting/)).toBeInTheDocument();
    expect(screen.getByText(/read from the\s+Documents screen/)).toBeInTheDocument();
  });

  it('lists the ones that could not be read, and lets someone try again', async () => {
    const { calls } = renderWith(<ProposalsScreen />, { unreadable: [view({ id: 'p9', documentId: 'd9', status: 'unreadable', filename: 'blurry.pdf' })] });
    expect(await screen.findByText('blurry.pdf')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(posted(calls, '/v1/documents/d9/propose-load')).toBeTruthy());
  });

  it('is for owners and dispatchers only, and asks the server for nothing otherwise', async () => {
    const { calls } = renderWith(<ProposalsScreen />, { role: 'accountant' });
    expect(await screen.findByText(/for owners and dispatchers/)).toBeInTheDocument();
    expect(calls.filter((c) => c.path.startsWith('/v1/load-proposals'))).toHaveLength(0);
  });
});

describe('the banner on Loads', () => {
  it('says how many are waiting, singular and plural', async () => {
    const { unmount } = render(<div />);
    unmount();
    renderWith(<ProposalsBanner />, { pending: [view()] });
    expect(await screen.findByText(/1 rate confirmation is ready to become a load/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/proposals');
  });

  it('says nothing when nothing is waiting, or to someone who cannot create a load', async () => {
    const { container } = render(<div />);
    container.remove();
    renderWith(<ProposalsBanner />, { pending: [view(), view({ id: 'p2' })], role: 'accountant' });
    await waitFor(() => expect(vi.mocked(request)).toHaveBeenCalled());
    expect(screen.queryByText(/ready to become/)).not.toBeInTheDocument();
  });
});

describe('the button on a rate confirmation in the inbox', () => {
  it('links to the review when there already is a proposal', async () => {
    renderWith(<RateConfirmationAction documentId="d1" />, { pending: [view()] });
    expect(await screen.findByRole('link', { name: 'Review as a load' })).toHaveAttribute('href', '/proposals/p1');
  });

  it('reads it now when there is not, and goes to the review', async () => {
    const { calls } = renderWith(<RateConfirmationAction documentId="d2" />, { answer: { 'POST /v1/documents/d2/propose-load': view({ id: 'p2', documentId: 'd2' }) } });

    await userEvent.click(await screen.findByRole('button', { name: 'Read as a load' }));

    await waitFor(() => expect(posted(calls, '/v1/documents/d2/propose-load')).toBeTruthy());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/proposals/$proposalId', params: { proposalId: 'p2' } }));
  });

  it('is calm about a deployment with no reader, and shows a real refusal as one', async () => {
    renderWith(<RateConfirmationAction documentId="d2" />, {
      answer: { 'POST /v1/documents/d2/propose-load': new ApiRequestError(503, { code: 'not_configured', explanation: 'x' }) },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Read as a load' }));
    expect(await screen.findByText(/not set up on this deployment yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows nothing to someone who cannot create a load', async () => {
    renderWith(<RateConfirmationAction documentId="d2" />, { role: 'accountant' });
    await waitFor(() => expect(vi.mocked(request)).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Read as a load' })).not.toBeInTheDocument();
  });
});

describe('reviewing one', () => {
  const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

  it('shows the document beside a form prefilled from what was read, with the text each value came from', async () => {
    const { client } = renderWith(<ProposalReviewScreen />, { one: view() });

    expect(await screen.findByDisplayValue('Prairie Logistics LLC')).toBeInTheDocument();
    expect(screen.getByDisplayValue('84213')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2400.00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Wichita')).toBeInTheDocument();
    expect(screen.getByText(/From the document: “\$2,400\.00”/)).toBeInTheDocument();
    await waitFor(() => expect(client.requestBlob).toHaveBeenCalledWith('/v1/documents/d1/content'));
    expect(screen.getByTitle('ratecon.pdf')).toBeInTheDocument();
  });

  it('says which appointments became windows and which did not, and keeps the latter in the comments', async () => {
    renderWith(<ProposalReviewScreen />, { one: view() });
    await screen.findByDisplayValue('Wichita');

    expect(screen.getByText(/Not set as a window; it is in the comments/)).toBeInTheDocument();
    expect(screen.getByText('Set as a window.')).toBeInTheDocument();
    expect((screen.getByLabelText('Comments') as HTMLTextAreaElement).value).toMatch(/Pickup, Wichita, KS: 09\/28\/2026 08:00-12:00/);
  });

  it('marks what could not be found, and will not create until equipment is chosen and both ends are there', async () => {
    const one = view({
      gaps: ['delivery', 'equipment', 'rate'],
      load: { stops: [{ type: 'pickup', city: 'Wichita', state: 'KS' }] },
      evidence: {},
    });
    renderWith(<ProposalReviewScreen />, { one });
    await screen.findByDisplayValue('Wichita');

    expect(screen.getByText('Could not find a delivery, the equipment and the rate.')).toBeInTheDocument();
    expect(screen.getAllByText(/Not found on the document/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Create load' })).toBeDisabled();
    const problems = within(screen.getByLabelText('What is left to fix'));
    expect(problems.getByText('Add a delivery.')).toBeInTheDocument();
    expect(problems.getByText(/Choose the equipment/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add a delivery' }));
    const delivery = screen.getByRole('group', { name: 'Delivery 2' });
    const [city, state] = within(delivery).getAllByRole('textbox').slice(2, 4) as HTMLInputElement[];
    await userEvent.type(city!, 'Denver');
    await userEvent.type(state!, 'co');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /Equipment/ }), 'REEFER');

    expect(screen.getByRole('button', { name: 'Create load' })).toBeEnabled();
  });

  it('creates the load from the form as the person left it, and goes to it', async () => {
    const { calls } = renderWith(<ProposalReviewScreen />, {
      one: view(),
      answer: { 'POST /v1/load-proposals/p1/create': { load: { id: 'L9', reference: 1077 }, proposal: null } },
    });
    await screen.findByDisplayValue('Wichita');
    await userEvent.clear(field('Broker'));
    await userEvent.type(field('Broker'), 'Corrected Broker Inc');

    await userEvent.click(screen.getByRole('button', { name: 'Create load' }));

    await waitFor(() => expect(posted(calls, '/v1/load-proposals/p1/create')).toBeTruthy());
    const body = posted(calls, '/v1/load-proposals/p1/create')!.body as Record<string, any>;
    expect(body['brokerName']).toBe('Corrected Broker Inc');
    expect(body['equipment']).toBe('DRY_VAN');
    expect(body['rate']).toEqual({ amount: 240_000, currency: 'USD' });
    expect(body['stops']).toHaveLength(2);
    expect(body['stops'][1].windowStart).toBe('2026-09-30T14:00:00.000Z');
    expect(body['source']).toBeUndefined();
    expect(body['confirmDuplicate']).toBeUndefined();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/loads/$loadId', params: { loadId: 'L9' } }));
  });

  it('offers to attach to the load that already has the number, first', async () => {
    const { calls } = renderWith(<ProposalReviewScreen />, {
      one: view({ matchedLoad: { id: 'L1', reference: 1042 } }),
      answer: { 'POST /v1/load-proposals/p1/attach': { load: { id: 'L1', reference: 1042 }, validation: null } },
    });
    expect(await screen.findByText('Load 1042 already has this broker load number.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Attach to Load 1042' }));

    await waitFor(() => expect(posted(calls, '/v1/load-proposals/p1/attach')?.body).toEqual({ loadId: 'L1' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/loads/$loadId', params: { loadId: 'L1' } }));
    expect(posted(calls, '/v1/load-proposals/p1/create')).toBeUndefined();
  });

  it('when the server refuses a duplicate number, says so and offers both ways out', async () => {
    const { calls } = renderWith(<ProposalReviewScreen />, {
      one: view({ matchedLoad: { id: 'L1', reference: 1042 } }),
      answer: {
        'POST /v1/load-proposals/p1/create': new ApiRequestError(409, {
          code: 'duplicate_load_number',
          explanation: 'Load 1042 already has the broker load number 84213.',
        }),
      },
    });
    await screen.findByDisplayValue('Wichita');

    await userEvent.click(screen.getByRole('button', { name: 'Create load' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Load 1042 already has the broker load number 84213.');
    expect(screen.getByRole('button', { name: 'Attach to Load 1042 instead' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Create a new load anyway' }));

    await waitFor(() => expect(calls.filter((c) => c.path === '/v1/load-proposals/p1/create')).toHaveLength(2));
    const second = calls.filter((c) => c.path === '/v1/load-proposals/p1/create')[1]!.body as Record<string, unknown>;
    expect(second['confirmDuplicate']).toBe(true);
  });

  it('dismisses one that is not a load, and goes back to the list', async () => {
    const { calls } = renderWith(<ProposalReviewScreen />, { one: view() });
    await screen.findByDisplayValue('Wichita');

    await userEvent.click(screen.getByRole('button', { name: 'This is not a load' }));

    await waitFor(() => expect(posted(calls, '/v1/load-proposals/p1/dismiss')).toBeTruthy());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/proposals' }));
  });

  it('removes a stop, and lets a stop be added', async () => {
    renderWith(<ProposalReviewScreen />, { one: view() });
    await screen.findByDisplayValue('Wichita');

    await userEvent.click(within(screen.getByRole('group', { name: 'Pickup 1' })).getByRole('button', { name: 'Remove' }));

    expect(screen.queryByDisplayValue('Wichita')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create load' })).toBeDisabled();
  });

  it('says what became of one that was already dealt with, instead of showing a form', async () => {
    const { unmount } = renderWith(<ProposalReviewScreen />, { one: view({ status: 'created', createdLoadId: 'L9' }) });
    expect(await screen.findByText('This rate confirmation has been dealt with')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the load' })).toHaveAttribute('href', '/loads/L9');
    expect(screen.queryByRole('button', { name: 'Create load' })).not.toBeInTheDocument();
    unmount();

    renderWith(<ProposalReviewScreen />, { one: view({ status: 'dismissed' }) });
    expect(await screen.findByText(/It was dismissed/)).toBeInTheDocument();
  });

  it('lets an unreadable one be read again', async () => {
    const { calls } = renderWith(<ProposalReviewScreen />, {
      one: view({ status: 'unreadable', load: { stops: [] } }),
      answer: { 'POST /v1/documents/d1/propose-load': view({ id: 'p3' }) },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Read it again' }));
    await waitFor(() => expect(posted(calls, '/v1/documents/d1/propose-load')).toBeTruthy());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/proposals/$proposalId', params: { proposalId: 'p3' } }));
  });

  it('is for owners and dispatchers only', async () => {
    const { calls } = renderWith(<ProposalReviewScreen />, { role: 'driver' });
    expect(await screen.findByText(/for owners and dispatchers/)).toBeInTheDocument();
    expect(calls.filter((c) => c.path.startsWith('/v1/load-proposals/p1'))).toHaveLength(0);
  });
});
