/**
 * Rendering screens under test.
 *
 * Screens read data two ways: through `@haulq/client`'s hooks, which call
 * whatever client `ApiClientProvider` holds, and through `request` from
 * `lib/api.ts` directly, for mutations. A test mocks `lib/api.ts`'s `request`
 * once (`vi.mock`), and `renderScreen` points the provider's client at that
 * same mock. One fake then answers both paths.
 *
 * `routes` maps a path prefix to a response, so a test states what the API
 * returns without caring which path reads it.
 */

import { ApiClientProvider, type ApiClient, type Load } from '@haulq/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi, type Mock } from 'vitest';
import { request } from './lib/api.ts';

export function renderScreen(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const client: ApiClient = {
    request: ((path: string, options?: unknown) => (request as Mock)(path, options)) as ApiClient['request'],
    requestBlob: vi.fn(),
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={client}>{ui}</ApiClientProvider>
    </QueryClientProvider>,
  );
}

/**
 * Answer `request(path)` from a table of path-prefix → response. Longest
 * prefix wins, so `/v1/loads/L1/margin` can differ from `/v1/loads/L1`. A
 * response that is a function is called with the options, for mutations
 * that need to see their body. An unmatched path rejects loudly.
 */
export function answerRequests(routes: Record<string, unknown>) {
  (request as Mock).mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const key = Object.keys(routes)
      .filter((p) => path.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) throw new Error(`unexpected request ${options?.method ?? 'GET'} ${path}`);
    const value = routes[key];
    return typeof value === 'function' ? (value as (o: unknown) => unknown)(options) : value;
  });
}

/** A booked $400 Kansas City → St. Louis load, 127 loaded miles and 176 deadhead. */
export function aLoad(overrides: Partial<Load> = {}): Load {
  return {
    id: 'L1', reference: 1042, status: 'booked', source: 'manual', brokerId: 'B1', brokerName: 'TQL',
    brokerDetentionFreeMinutes: null, brokerLoadNumber: null, equipment: 'STRAIGHT_BOX', commodity: null,
    weightLbs: null, rateAmount: 40_000, rateCurrency: 'USD', rateIsLinehaul: false,
    expectedDeadheadMiles: 176, expectedLoadedMiles: 127, truckId: null, truckLabel: null, driverId: null,
    driverName: null, cancelledReason: null,
    stops: [
      { id: 's1', seq: 1, type: 'pickup', city: 'Kansas City', state: 'MO', facilityName: null, addressLine1: null, postalCode: null, lat: null, lng: null, windowStart: null, windowEnd: null },
      { id: 's2', seq: 2, type: 'delivery', city: 'St. Louis', state: 'MO', facilityName: null, addressLine1: null, postalCode: null, lat: null, lng: null, windowStart: null, windowEnd: null },
    ],
    ...overrides,
  };
}

