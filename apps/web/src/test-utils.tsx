/**
 * Rendering screens under test, the same helper the mobile app has.
 *
 * Screens built on `@haulq/client`'s hooks read through whatever client
 * `ApiClientProvider` holds. A test mocks `lib/api.ts`'s `request` once
 * (`vi.mock`), and `renderScreen` points the provider's client at that same
 * mock, so one fake answers both the shared hooks and any direct `request`.
 */

import { ApiClientProvider, type ApiClient } from '@haulq/client';
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
 * prefix wins. A function response is called with the options, for
 * mutations. An unmatched path rejects loudly.
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
