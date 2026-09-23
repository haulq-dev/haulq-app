/**
 * React Query hooks over the shared client.
 *
 * Each app hands its configured `ApiClient` to `ApiClientProvider` once, and
 * the hooks read it from context. That way a hook does not care whether it
 * runs in web or mobile. Screens gain a hook here as they are ported
 * (MOBILE_PARITY_PLAN.md, M1 onward).
 *
 * Query keys match the ones `apps/web` already uses, so if both ever share a
 * cache, or web moves onto these hooks, invalidation lines up.
 *
 * `.ts` rather than `.tsx`, using `createElement`, so this package's tests
 * run under Node's type stripping, which does not do JSX.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { NearbyStopsResponse } from '@haulq/contracts';
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { ApiClient } from './client.ts';
import type {
  BrokerDocumentHistory,
  BrokerVerification,
  Load,
  LoadMargin,
  LoadsPage,
  LoadTrackingView,
} from './loads.ts';
import type { Driver, OrgSummary, Truck } from './types.ts';

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
 * other screen reading the same data. `loads` is a prefix: invalidating it
 * refreshes every filtered and searched list at once.
 */
export const queryKeys = {
  orgs: ['orgs'] as const,
  loads: ['loads'] as const,
  loadList: (status: string, search: string) => ['loads', status, search] as const,
  load: (id: string) => ['load', id] as const,
  loadMargin: (id: string) => ['load-margin', id] as const,
  loadTracking: (id: string) => ['load-tracking', id] as const,
  nearbyStops: (id: string) => ['nearby-stops', id] as const,
  trucks: ['trucks'] as const,
  drivers: ['drivers'] as const,
  brokerVerification: (id: string) => ['broker-verification', id] as const,
  brokerDocumentHistory: (id: string) => ['broker-document-history', id] as const,
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

/**
 * The org's loads, a page at a time. `status` and `search` narrow it and
 * are part of the key. `search` needs the API's `?search=` support; an API
 * without it ignores the parameter and returns the unfiltered list.
 */
export function useLoads(filters: { status?: string; search?: string } = {}) {
  const client = useApiClient();
  const status = filters.status ?? '';
  const search = filters.search ?? '';
  return useInfiniteQuery({
    queryKey: queryKeys.loadList(status, search),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request<LoadsPage>(
        `/v1/loads?${new URLSearchParams({
          ...(status ? { status } : {}),
          ...(search ? { search } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useLoad(id: string) {
  const client = useApiClient();
  return useQuery({ queryKey: queryKeys.load(id), queryFn: () => client.request<Load>(`/v1/loads/${id}`) });
}

export function useLoadMargin(id: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.loadMargin(id),
    queryFn: () => client.request<LoadMargin>(`/v1/loads/${id}/margin`),
  });
}

export function useLoadTracking(id: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.loadTracking(id),
    queryFn: () => client.request<LoadTrackingView>(`/v1/loads/${id}/tracking`),
  });
}

/** On demand only (`enabled`), because each call is a live HERE lookup per stop. */
export function useNearbyStops(id: string, enabled: boolean) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.nearbyStops(id),
    queryFn: () => client.request<NearbyStopsResponse>(`/v1/loads/${id}/nearby-stops`),
    enabled,
    staleTime: 10 * 60_000,
  });
}

export function useTrucks() {
  const client = useApiClient();
  return useQuery({ queryKey: queryKeys.trucks, queryFn: () => client.request<{ items: Truck[] }>('/v1/trucks') });
}

export function useDrivers() {
  const client = useApiClient();
  return useQuery({ queryKey: queryKeys.drivers, queryFn: () => client.request<{ items: Driver[] }>('/v1/drivers') });
}

export function useBrokerVerification(brokerId: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.brokerVerification(brokerId),
    queryFn: () => client.request<BrokerVerification>(`/v1/brokers/${brokerId}/verification`),
  });
}

export function useBrokerDocumentHistory(brokerId: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.brokerDocumentHistory(brokerId),
    queryFn: () => client.request<BrokerDocumentHistory>(`/v1/brokers/${brokerId}/document-history`),
  });
}
