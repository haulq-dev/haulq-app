import {
  ApiClientProvider,
  ApiRequestError,
  type ApiClient,
  type Load,
  type LoadTrackingView,
  type NearbyMechanicsResponse,
  type NearbyStopsResponse,
} from '@haulq/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../lib/api.ts';
import { NearbyMechanicsCard, NearbyStopsCard } from './LoadPlaces.tsx';

// CoordinateLookup (used for "somewhere else") goes through the web app's own request.
vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, request: vi.fn() };
});

const stop = (over: Partial<Load['stops'][number]> = {}): Load['stops'][number] => ({
  id: 's1',
  seq: 1,
  type: 'pickup',
  city: 'Wichita',
  state: 'KS',
  facilityName: null,
  addressLine1: null,
  postalCode: null,
  lat: 37.7,
  lng: -97.3,
  windowStart: null,
  windowEnd: null,
  ...over,
});

const load = (stops: Load['stops']): Load =>
  ({
    id: 'L1',
    reference: 1042,
    status: 'booked',
    source: 'manual',
    brokerId: 'B1',
    brokerName: 'TQL',
    stops,
  }) as unknown as Load;

const twoStops = () => [stop(), stop({ id: 's2', seq: 2, type: 'delivery', city: 'Denver', state: 'CO', lat: 39.7, lng: -105 })];

const place = (name: string, category: string, categoryLabel: string, distanceMiles: number) => ({
  name,
  category,
  categoryLabel,
  lat: 37.7,
  lng: -97.3,
  distanceMiles,
  address: null,
});

const stopsAnswer = (): NearbyStopsResponse =>
  ({
    stops: [
      {
        seq: 1,
        city: 'Wichita',
        state: 'KS',
        places: [place('Weigh Station 1', 'weighStation', 'Weigh station', 3), place('Pilot #22', 'truckStop', 'Truck stop', 2.4), place('Shell', 'fuelStation', 'Fuel', 1.1)],
      },
      { seq: 2, city: 'Denver', state: 'CO', places: [] },
    ],
  }) as unknown as NearbyStopsResponse;

const shop = (over: Record<string, unknown> = {}) => ({
  name: 'Prairie Diesel',
  rating: 4.5,
  reviewCount: 123,
  address: '100 Main St, Salina, KS',
  phone: '(785) 555-0142',
  distanceMiles: 3.2,
  yelpUrl: 'https://www.yelp.com/biz/prairie-diesel',
  ...over,
});

const tracking = (truck: LoadTrackingView['truck']): LoadTrackingView =>
  ({ orgName: 'x', loadReference: 1042, status: 'in_transit', equipment: 'DRY_VAN', truck, stops: [], eta: null }) as LoadTrackingView;

interface World {
  stops?: NearbyStopsResponse | Error;
  mechanics?: NearbyMechanicsResponse | Error;
  tracking?: LoadTrackingView;
}

function renderCard(ui: React.ReactNode, world: World = {}) {
  const calls: string[] = [];
  const reply = (v: unknown) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  const client: ApiClient = {
    request: vi.fn(async (path: string) => {
      calls.push(path);
      if (path.startsWith('/v1/loads/L1/nearby-stops')) return reply(world.stops ?? { stops: [] });
      if (path.startsWith('/v1/mechanics/nearby')) return reply(world.mechanics ?? { mechanics: [] });
      if (path === '/v1/loads/L1/tracking') return reply(world.tracking ?? tracking(null));
      throw new Error('unexpected ' + path);
    }) as ApiClient['request'],
    requestBlob: vi.fn(),
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={client}>{ui}</ApiClientProvider>
    </QueryClientProvider>,
  );
  return { calls };
}

beforeEach(() => vi.mocked(request).mockReset());

describe('NearbyStopsCard', () => {
  it('looks up nothing until asked, then groups places by kind with distances', async () => {
    const { calls } = renderCard(<NearbyStopsCard load={load(twoStops())} />, { stops: stopsAnswer() });
    expect(calls.filter((c) => c.includes('nearby-stops'))).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));

    const pickup = await screen.findByRole('region', { name: 'Stop 1' });
    expect(calls).toContain('/v1/loads/L1/nearby-stops?radiusMiles=10');
    const headings = within(pickup).getAllByText(/Truck stops|Fuel|Weigh stations/).map((e) => e.textContent);
    expect(headings).toEqual(['Truck stops', 'Fuel', 'Weigh stations']);
    expect(within(pickup).getByText('Pilot #22')).toHaveAttribute('href', expect.stringContaining('google.com/maps'));
    expect(within(pickup).getByText('2.4 mi')).toBeInTheDocument();
    expect(screen.getByText(/Pickup: Wichita, KS/)).toBeInTheDocument();
  });

  it('asks again when the radius changes', async () => {
    const { calls } = renderCard(<NearbyStopsCard load={load(twoStops())} />, { stops: stopsAnswer() });
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await screen.findByRole('region', { name: 'Stop 1' });

    await userEvent.selectOptions(screen.getByLabelText('Search radius'), '25');

    await waitFor(() => expect(calls).toContain('/v1/loads/L1/nearby-stops?radiusMiles=25'));
  });

  it('says why a stop with nothing has nothing: no coordinates, or genuinely empty', async () => {
    renderCard(<NearbyStopsCard load={load([stop(), stop({ id: 's2', seq: 2, type: 'delivery', city: 'Denver', state: 'CO', lat: null, lng: null })])} />, {
      stops: { stops: [{ seq: 1, city: 'Wichita', state: 'KS', places: [] }, { seq: 2, city: 'Denver', state: 'CO', places: [] }] } as NearbyStopsResponse,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));

    expect(await within(await screen.findByRole('region', { name: 'Stop 1' })).findByText('Nothing found within 10 miles.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Stop 2' })).getByText(/no coordinates yet/)).toBeInTheDocument();
  });

  it('tells a Core carrier the plan, and an unconnected deployment, calmly rather than as an error', async () => {
    renderCard(<NearbyStopsCard load={load(twoStops())} />, {
      stops: new ApiRequestError(403, { code: 'not_entitled', explanation: 'Contact us to upgrade.' }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText(/part of HaulQ Routes, which is on the Fleet plan/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so when place search is not connected', async () => {
    renderCard(<NearbyStopsCard load={load(twoStops())} />, {
      stops: new ApiRequestError(503, { code: 'not_configured', explanation: 'HERE is not configured.' }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByText(/Place search is not connected on this deployment yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a real failure as an error', async () => {
    renderCard(<NearbyStopsCard load={load(twoStops())} />, {
      stops: new ApiRequestError(502, { code: 'places_provider_error', explanation: 'HERE could not look up nearby stops right now.' }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('HERE could not look up nearby stops right now.');
  });
});

describe('NearbyMechanicsCard', () => {
  const truckAt = { label: 'Truck 4', currentCity: 'Salina', currentState: 'KS', currentLat: 38.8, currentLng: -97.6, positionAt: null };

  it('starts from where the truck is, searches only when asked, and shows what Yelp says', async () => {
    const { calls } = renderCard(<NearbyMechanicsCard load={load(twoStops())} />, {
      tracking: tracking(truckAt),
      mechanics: { mechanics: [shop()] } as NearbyMechanicsResponse,
    });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Search near' })).toHaveTextContent(/Truck 4.*Salina, KS/));
    expect(calls.filter((c) => c.includes('mechanics'))).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Find shops' }));

    expect(await screen.findByText('Prairie Diesel')).toBeInTheDocument();
    const call = calls.find((c) => c.startsWith('/v1/mechanics/nearby'))!;
    const q = new URLSearchParams(call.split('?')[1]);
    expect([q.get('lat'), q.get('lng'), q.get('radiusMiles'), q.get('query')]).toEqual(['38.8', '-97.6', '15', 'diesel truck repair']);
    expect(screen.getByRole('img', { name: '4.5 out of 5 stars on Yelp' })).toBeInTheDocument();
    expect(screen.getByText('123 reviews')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '(785) 555-0142' })).toHaveAttribute('href', 'tel:7855550142');
    expect(screen.getByRole('link', { name: /Read reviews on/ })).toHaveAttribute('href', 'https://www.yelp.com/biz/prairie-diesel');
    expect(screen.getByText('3.2 mi')).toBeInTheDocument();
    expect(screen.getByText(/Ratings and reviews from/)).toBeInTheDocument();
  });

  it('offers each stop that has coordinates, and none that do not', async () => {
    renderCard(<NearbyMechanicsCard load={load([stop(), stop({ id: 's2', seq: 2, type: 'delivery', city: 'Denver', state: 'CO', lat: null, lng: null })])} />);
    const select = await screen.findByRole('combobox', { name: 'Search near' });
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Pickup: Wichita, KS', 'Somewhere else…']);
  });

  it('takes a different kind of shop and a wider radius', async () => {
    const { calls } = renderCard(<NearbyMechanicsCard load={load(twoStops())} />, { mechanics: { mechanics: [shop()] } as NearbyMechanicsResponse });
    await userEvent.click(await screen.findByRole('button', { name: 'Tires' }));
    await userEvent.selectOptions(screen.getByLabelText('Search radius'), '24');
    await userEvent.click(screen.getByRole('button', { name: 'Find shops' }));

    await screen.findByText('Prairie Diesel');
    const q = new URLSearchParams(calls.find((c) => c.startsWith('/v1/mechanics/nearby'))!.split('?')[1]);
    expect([q.get('radiusMiles'), q.get('query')]).toEqual(['24', 'truck tire']);
  });

  it('says so for a shop Yelp has not rated, and shows no phone link it cannot dial', async () => {
    renderCard(<NearbyMechanicsCard load={load(twoStops())} />, {
      mechanics: { mechanics: [shop({ rating: null, reviewCount: 0, phone: null })] } as NearbyMechanicsResponse,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Find shops' }));
    expect(await screen.findByText('Not rated on Yelp')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /out of 5 stars/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^\(/ })).not.toBeInTheDocument();
  });

  it('says when nothing was found', async () => {
    renderCard(<NearbyMechanicsCard load={load(twoStops())} />, { mechanics: { mechanics: [] } as NearbyMechanicsResponse });
    await userEvent.click(await screen.findByRole('button', { name: 'Find shops' }));
    expect(await screen.findByText(/No shops found within 15 miles/)).toBeInTheDocument();
  });

  it('sends the kind of business a shortcut means, and none once someone types their own search', async () => {
    const { calls } = renderCard(<NearbyMechanicsCard load={load(twoStops())} />, { mechanics: { mechanics: [shop()] } as NearbyMechanicsResponse });
    const asked = () => calls.filter((c) => c.startsWith('/v1/mechanics/nearby')).map((c) => new URLSearchParams(c.split('?')[1]));

    // The default is the diesel shortcut, with its categories.
    await userEvent.click(await screen.findByRole('button', { name: 'Find shops' }));
    await waitFor(() => expect(asked()).toHaveLength(1));
    expect(asked()[0]!.get('categories')).toBe('truckrepair,autorepair');

    await userEvent.click(screen.getByRole('button', { name: 'Towing' }));
    await userEvent.click(screen.getByRole('button', { name: 'Find shops' }));
    await waitFor(() => expect(asked()).toHaveLength(2));
    expect(asked()[1]!.get('categories')).toBe('towing');

    // Typing over the words means the words decide.
    await userEvent.type(screen.getByLabelText('Looking for'), ' near the interstate');
    await userEvent.click(screen.getByRole('button', { name: 'Find shops' }));
    await waitFor(() => expect(asked()).toHaveLength(3));
    expect(asked()[2]!.has('categories')).toBe(false);
    expect(asked()[2]!.get('query')).toBe('heavy duty towing near the interstate');
  });

  it('shows a daily limit as a note that says when it starts over, not as a failure', async () => {
    renderCard(<NearbyMechanicsCard load={load(twoStops())} />, {
      mechanics: new ApiRequestError(429, {
        code: 'org_search_limit_reached',
        explanation: 'Your carrier has used its 25 repair-shop searches for today. The count starts over at midnight UTC (7 pm Central).',
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Find shops' }));

    expect(await screen.findByText(/used its 25 repair-shop searches for today/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says the same when it is HaulQ’s own Yelp budget that ran out', async () => {
    renderCard(<NearbyMechanicsCard load={load(twoStops())} />, {
      mechanics: new ApiRequestError(429, {
        code: 'search_limit_reached',
        explanation: "HaulQ's repair-shop search has reached its daily limit. It starts over at midnight UTC (7 pm Central).",
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Find shops' }));
    expect(await screen.findByText(/reached its daily limit/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows Yelp as Yelp requires: its logo linking to Yelp, its branded stars beside the review count', async () => {
    renderCard(<NearbyMechanicsCard load={load(twoStops())} />, {
      mechanics: { mechanics: [shop({ rating: 4.5, reviewCount: 123 }), shop({ name: 'Second Shop', rating: 2.5, reviewCount: 1, yelpUrl: 'https://www.yelp.com/biz/second' })] } as NearbyMechanicsResponse,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Find shops' }));
    await screen.findByText('Prairie Diesel');

    // Yelp's own star image, chosen by the rating, with the count next to it.
    const stars = screen.getAllByRole('img', { name: /out of 5 stars on Yelp/ });
    expect(stars[0]).toHaveAttribute('src', '/yelp/stars/Review_Ribbon_medium_20_4_half@1x.png');
    expect(stars[0]).toHaveAttribute('srcset', expect.stringContaining('@2x.png 2x'));
    expect(stars[1]).toHaveAttribute('src', '/yelp/stars/Review_Ribbon_medium_20_2_half@1x.png');
    expect(screen.getByText('123 reviews')).toBeInTheDocument();
    expect(screen.getByText('1 review')).toBeInTheDocument();

    // Each shop links to its own Yelp page, with the logo in the link.
    const links = screen.getAllByRole('link', { name: /Read reviews on/ });
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['https://www.yelp.com/biz/prairie-diesel', 'https://www.yelp.com/biz/second']);
    for (const l of links) expect(within(l).getByRole('img', { name: 'Yelp' })).toHaveAttribute('src', '/yelp/yelp_logo.svg');

    // And the logo is prominent on the results as a whole, linking to Yelp.
    const footer = screen.getByText(/Ratings and reviews from/);
    expect(within(footer).getByRole('link')).toHaveAttribute('href', 'https://www.yelp.com');
  });

  it('never stretches Yelp\'s images: the logo is sized by height only', async () => {
    renderCard(<NearbyMechanicsCard load={load(twoStops())} />, { mechanics: { mechanics: [shop()] } as NearbyMechanicsResponse });
    await userEvent.click(await screen.findByRole('button', { name: 'Find shops' }));
    await screen.findByText('Prairie Diesel');
    for (const logo of screen.getAllByRole('img', { name: 'Yelp' })) expect(logo.style.width).toBe('auto');
  });

  it('is calm about Yelp not being connected here', async () => {
    renderCard(<NearbyMechanicsCard load={load(twoStops())} />, {
      mechanics: new ApiRequestError(503, { code: 'not_configured', explanation: 'Yelp is not configured.' }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Find shops' }));
    expect(await screen.findByText(/Repair-shop search is not connected on this deployment yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('will not search from "somewhere else" until it has found the place', async () => {
    renderCard(<NearbyMechanicsCard load={load([])} />);
    // No truck position and no stops: the only choice is somewhere else.
    expect(await screen.findByRole('combobox', { name: 'Search near' })).toHaveValue('elsewhere');
    expect(screen.getByRole('button', { name: 'Find shops' })).toBeDisabled();
    expect(screen.getByText(/Enter a city and state/)).toBeInTheDocument();
  });
});
