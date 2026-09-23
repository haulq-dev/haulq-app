/**
 * React Query hooks over the shared client.
 *
 * Each app hands its configured `ApiClient` to `ApiClientProvider` once, and
 * the hooks read it from context. That way a hook does not care whether it
 * runs in web or mobile. Screens gain a hook here as they are ported
 * (MOBILE_PARITY_PLAN.md, M1 onward). This file only holds what more than one
 * screen needs.
 *
 * `.ts` rather than `.tsx`, using `createElement`, so this package's tests
 * run under Node's type stripping, which does not do JSX.
 */

import { useQuery } from '@tanstack/react-query';
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { ApiClient } from './client.ts';
import type { OrgSummary } from './types.ts';

const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return createElement(ApiClientContext.Provider, { value: client }, children);
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error('useApiClient needs an <ApiClientProvider> above it.');
  return client;
}

/**
 * Query keys, in one place so an invalidation in one screen reaches every
 * other screen reading the same data.
 */
export const queryKeys = {
  orgs: ['orgs'] as const,
};

/**
 * The accounts this login can act in, each with its subscription status and
 * plan. `GET /v1/orgs` is never subscription-gated, so this is also how
 * either app learns that the current org is unpaid.
 */
export function useOrgs(options: { enabled?: boolean } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.orgs,
    queryFn: () => client.request<{ items: OrgSummary[] }>('/v1/orgs'),
    enabled: options.enabled ?? true,
  });
}
