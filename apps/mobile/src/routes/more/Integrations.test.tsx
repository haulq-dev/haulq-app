import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const session = { current: { userId: 'me', orgId: 'o', orgName: 'Acme', role: 'owner' as string } };
const plan = { current: 'fleet' as string | null };

vi.mock('../../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api.ts')>('../../lib/api.ts');
  return { ...actual, request: vi.fn(), requestBlob: vi.fn() };
});
vi.mock('../../lib/haptics.ts', () => ({ tapFeedback: vi.fn(), successFeedback: vi.fn() }));
vi.mock('@capacitor/browser', () => ({ Browser: { open: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@capacitor/geolocation', () => ({
  Geolocation: { getCurrentPosition: vi.fn().mockResolvedValue({ coords: { latitude: 39.1, longitude: -94.6 } }) },
}));
vi.mock('../../components/AuthGate.tsx', () => ({ useSession: () => session.current }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { Browser } from '@capacitor/browser';
import { request } from '../../lib/api.ts';
import { answerRequests, renderScreen } from '../../test-utils.tsx';
import { RepairShops } from '../../components/RepairShops.tsx';
import { IntegrationsScreen } from './IntegrationsScreen.tsx';

const DEPLOYMENT = {
  azureDocumentIntelligence: { configured: true },
  anthropicModelPass: { configured: true },
  fmcsaVerify: { configured: true },
  hereRouting: { configured: true },
  motive: { configured: true },
};

function world(overrides: Record<string, unknown> = {}) {
  answerRequests({
    '/v1/orgs': { items: [{ id: 'o', name: 'Acme', role: session.current.role, status: 'active', plan: plan.current }] },
    '/v1/integrations': { items: [], deployment: DEPLOYMENT },
    '/v1/mailbox': { connected: false, status: 'not_connected', provider: null, connectedAt: null },
    ...overrides,
  });
}

beforeEach(() => {
  (request as Mock).mockReset();
  (Browser.open as Mock).mockClear();
  session.current = { ...session.current, role: 'owner' };
  plan.current = 'fleet';
  window.history.replaceState(null, '', '/integrations');
});

describe('IntegrationsScreen', () => {
  it('starts Motive from the app and opens it in the in-app browser, not the WebView', async () => {
    const paths: string[] = [];
    world({ '/v1/integrations/motive/connect': () => ({ url: 'https://api.gomotive.com/oauth/authorize?x=1' }) });
    const inner = (request as Mock).getMockImplementation()!;
    (request as Mock).mockImplementation(async (path: string, o: unknown) => {
      paths.push(path);
      return inner(path, o);
    });
    renderScreen(<IntegrationsScreen />);

    await userEvent.click(await screen.findByRole('button', { name: 'Connect Motive' }));
    await waitFor(() => expect(Browser.open).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://api.gomotive.com/oauth/authorize?x=1' })));
    expect(paths).toContain('/v1/integrations/motive/connect?client=app');
  });

  it('starts the mailbox from the app the same way', async () => {
    const calls: string[] = [];
    world({ '/v1/mailbox/connect': () => ({ url: 'https://account.unipile.com/link' }) });
    const inner = (request as Mock).getMockImplementation()!;
    (request as Mock).mockImplementation(async (path: string, o: unknown) => {
      calls.push(path);
      return inner(path, o);
    });
    renderScreen(<IntegrationsScreen />);

    await userEvent.click(await screen.findByRole('button', { name: 'Connect your mailbox' }));
    await waitFor(() => expect(Browser.open).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://account.unipile.com/link' })));
    expect(calls).toContain('/v1/mailbox/connect?client=app');
  });

  it('shows what the hand-back said, once', async () => {
    window.history.replaceState(null, '', '/integrations?motive=connected');
    world({ '/v1/integrations': { items: [{ id: 'c', board: 'motive', status: 'active', tokenExpiresAt: null, lastVerifiedAt: null, lastError: null }], deployment: DEPLOYMENT } });
    renderScreen(<IntegrationsScreen />);

    expect(await screen.findByRole('status')).toHaveTextContent('Motive is connected.');
    expect(await screen.findByRole('link', { name: 'Match trucks to Motive vehicles' })).toHaveAttribute('href', '/trucks');
    expect(window.location.search).toBe('');
  });

  it('tells a carrier whose plan lacks tracking, with no way to buy it', async () => {
    plan.current = 'carrier';
    world();
    const { container } = renderScreen(<IntegrationsScreen />);

    expect(await screen.findByText("Motive tracking isn't included in your carrier's HaulQ plan.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Motive' })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/upgrade|subscri|pricing|stripe/i);
  });

  it('gives a dispatcher status only', async () => {
    session.current = { ...session.current, role: 'dispatcher' };
    world();
    renderScreen(<IntegrationsScreen />);

    expect(await screen.findByText('Only an owner can connect or disconnect these.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
  });
});

describe('RepairShops', () => {
  const SHOP = {
    name: 'Big Rig Diesel',
    rating: 4.5,
    reviewCount: 88,
    address: '1 Main St, Kansas City, MO',
    phone: '(816) 555-0100',
    distanceMiles: 3.2,
    yelpUrl: 'https://www.yelp.com/biz/big-rig',
  };

  it('searches from where the driver is, only when asked, and shows results as Yelp requires', async () => {
    const searched: string[] = [];
    answerRequests({
      '/v1/mechanics/nearby': () => ({ mechanics: [SHOP] }),
    });
    const inner = (request as Mock).getMockImplementation()!;
    (request as Mock).mockImplementation(async (path: string, o: unknown) => {
      searched.push(path);
      return inner(path, o);
    });
    renderScreen(<RepairShops origins={[]} nearMe />);

    expect(searched).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Find shops' }));
    expect(await screen.findByText('Big Rig Diesel')).toBeInTheDocument();
    expect(searched[0]).toMatch(/lat=39\.1&lng=-94\.6/);

    expect(screen.getByAltText('4.5 out of 5 stars on Yelp')).toBeInTheDocument();
    expect(screen.getByText('88 reviews')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Reviews on/ })).toHaveAttribute('href', SHOP.yelpUrl);
    expect(screen.getByRole('link', { name: /Call/ })).toHaveAttribute('href', 'tel:8165550100');
    expect(screen.getAllByAltText('Yelp').length).toBeGreaterThanOrEqual(2);
  });

  it("reads the daily limit as a calm note with the API's own sentence", async () => {
    const { ApiRequestError } = await import('../../lib/api.ts');
    answerRequests({
      '/v1/mechanics/nearby': () => {
        throw new ApiRequestError(429, { code: 'search_limit_reached', explanation: 'Repair-shop search is used up for today. It starts over at midnight UTC.' });
      },
    });
    renderScreen(<RepairShops origins={[{ key: 'stop-1', label: 'Pickup: Kansas City, MO', lat: 39.1, lng: -94.6 }]} />);

    await userEvent.click(screen.getByRole('button', { name: 'Find shops' }));
    expect(await screen.findByText(/used up for today/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
