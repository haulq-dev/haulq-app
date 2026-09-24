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

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NearbyMechanicsResponse, NearbyStopsResponse } from '@haulq/contracts';
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
import type { DocumentsPage, DocumentRow } from './documents.ts';
import type { MechanicSearch } from './places.ts';
import { modeForPosition, type ActionPosition, type MailboxStatus, type OutboundEvidenceResponse, type OutboundMessage, type OutboundSettingsResponse } from './outbound.ts';
import type { CarrierProfile, Driver, OrgSummary, Truck } from './types.ts';

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
  nearbyStops: (id: string, radiusMiles?: number) => ['nearby-stops', id, radiusMiles ?? null] as const,
  mechanics: (search: MechanicSearch | null) => ['mechanics', search] as const,
  trucks: ['trucks'] as const,
  drivers: ['drivers'] as const,
  brokerVerification: (id: string) => ['broker-verification', id] as const,
  brokerDocumentHistory: (id: string) => ['broker-document-history', id] as const,
  /** A prefix: invalidating it refreshes every document list, count and detail. */
  documents: ['documents'] as const,
  documentList: (scope: string) => ['documents', 'list', scope] as const,
  documentCounts: ['documents', 'counts'] as const,
  document: (id: string) => ['documents', 'one', id] as const,
  profile: ['profile'] as const,
  /** A prefix: invalidating it refreshes settings, every message list and the waiting count. */
  outbound: ['outbound'] as const,
  outboundSettings: ['outbound', 'settings'] as const,
  outboundMessages: ['outbound', 'messages'] as const,
  outboundPending: ['outbound', 'pending'] as const,
  outboundEvidence: ['outbound', 'evidence'] as const,
  mailbox: ['mailbox'] as const,
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

/**
 * Repair shops near a point, live from Yelp. Idle until there is a search:
 * each one is a Yelp call, so it runs when someone asks, not as they type.
 */
export function useNearbyMechanics(search: MechanicSearch | null) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.mechanics(search),
    queryFn: () => {
      const s = search!;
      return client.request<NearbyMechanicsResponse>(
        `/v1/mechanics/nearby?${new URLSearchParams({
          lat: String(s.lat),
          lng: String(s.lng),
          radiusMiles: String(s.radiusMiles),
          query: s.query,
          ...(s.categories ? { categories: s.categories } : {}),
        })}`,
      );
    },
    enabled: search !== null,
    staleTime: 10 * 60_000,
  });
}

/** On demand only (`enabled`), because each call is a live HERE lookup per stop. */
export function useNearbyStops(id: string, enabled: boolean, radiusMiles?: number) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.nearbyStops(id, radiusMiles),
    queryFn: () =>
      client.request<NearbyStopsResponse>(
        `/v1/loads/${id}/nearby-stops${radiusMiles ? `?radiusMiles=${radiusMiles}` : ''}`,
      ),
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

/**
 * Documents, a page at a time. `view` is the office's inbox (`unattached`) or
 * everything. `loadId` narrows to one load's paperwork, which is the only
 * list a driver may read.
 */
export function useDocuments(filter: { view: 'inbox' | 'all' } | { loadId: string }, options: { enabled?: boolean } = {}) {
  const client = useApiClient();
  const scope = 'loadId' in filter ? `load:${filter.loadId}` : filter.view;
  return useInfiniteQuery({
    queryKey: queryKeys.documentList(scope),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request<DocumentsPage>(
        `/v1/documents?${new URLSearchParams({
          ...('loadId' in filter ? { loadId: filter.loadId } : filter.view === 'inbox' ? { unattached: 'true' } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options.enabled ?? true,
  });
}

/** Account-wide counts by status. Office roles only; the API refuses drivers. */
export function useDocumentCounts(options: { enabled?: boolean } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.documentCounts,
    queryFn: () => client.request<{ counts: Record<string, number> }>('/v1/documents/counts'),
    enabled: options.enabled ?? true,
  });
}

export function useDocument(id: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.document(id),
    queryFn: async () => (await client.request<{ document: DocumentRow }>(`/v1/documents/${id}`)).document,
  });
}

/** The carrier's profile. Its `slug` is what the inbound email address is built from. */
export function useCarrierProfile(options: { enabled?: boolean } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.profile,
    queryFn: () => client.request<CarrierProfile>('/v1/org/profile'),
    enabled: options.enabled ?? true,
  });
}

// --- Autopilot (FEATURE_REQUESTS_PLAN.md section 9) --------------------------------

/** How freely the system may send, per action, and whether the loop is running at all. */
export function useOutboundSettings(options: { enabled?: boolean } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.outboundSettings,
    queryFn: () => client.request<OutboundSettingsResponse>('/v1/outbound/settings'),
    enabled: options.enabled ?? true,
  });
}

/**
 * Everything drafted, held, sent or failed, newest first (the API caps it at
 * 100). `refetchMs` keeps an open screen current without a manual refresh.
 */
export function useOutboundMessages(options: { enabled?: boolean; refetchMs?: number } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.outboundMessages,
    queryFn: async () => (await client.request<{ messages: OutboundMessage[] }>('/v1/outbound/messages')).messages,
    enabled: options.enabled ?? true,
    ...(options.refetchMs ? { refetchInterval: options.refetchMs } : {}),
  });
}

/**
 * How many drafts are waiting on a person. Cheap and polled, because it drives
 * the badge that tells someone there is something to approve.
 */
export function usePendingApprovalCount(options: { enabled?: boolean; refetchMs?: number } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.outboundPending,
    queryFn: async () =>
      (await client.request<{ messages: OutboundMessage[] }>('/v1/outbound/messages?status=pending_approval')).messages.length,
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchMs ?? 60_000,
  });
}

/** Approving sends it now, so the result is the message as it ended up: sent, or failed with a reason. */
export function useApproveOutbound() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.request<OutboundMessage>(`/v1/outbound/messages/${id}/approve`, { method: 'POST' }),
    // Settled, not success: a refused approval (too old, sending switched off)
    // changes what the list should show just as much as a good one.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.outbound }),
  });
}

export function useRejectOutbound() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.request<OutboundMessage>(`/v1/outbound/messages/${id}/reject`, { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.outbound }),
  });
}

/** The master switch. */
export function useSetSendingEnabled() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sendingEnabled: boolean) =>
      client.request<{ ok: true }>('/v1/outbound/settings', { method: 'PUT', body: { sendingEnabled } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.outbound }),
  });
}

/** Move one action to a position. Off removes the setting; the others set a mode. */
export function useSetActionPosition() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ actionType, position }: { actionType: string; position: ActionPosition }) => {
      const mode = modeForPosition(position);
      if (mode === null) {
        await client.request(`/v1/outbound/settings/${actionType}`, { method: 'DELETE' });
      } else {
        await client.request('/v1/outbound/settings', { method: 'PUT', body: { modes: { [actionType]: mode } } });
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.outbound }),
  });
}

/** Send the owner themselves a message through the same path everything else uses. */
export function useSendTestMessage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.request<{ message: OutboundMessage; sent: boolean }>('/v1/outbound/test', { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.outbound }),
  });
}

/**
 * What the carrier's own history says about each action: their marks on
 * previews and what they did with held drafts. Drives the "ready to move up?"
 * prompt. Refetched with everything else under `outbound`.
 */
export function useOutboundEvidence(options: { enabled?: boolean } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.outboundEvidence,
    queryFn: async () => (await client.request<OutboundEvidenceResponse>('/v1/outbound/evidence')).actions,
    enabled: options.enabled ?? true,
  });
}

/** Was this preview what they would have wanted sent? Marking again replaces the earlier verdict. */
export function useMarkOutbound() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, verdict, note }: { id: string; verdict: 'right' | 'wrong'; note?: string }) =>
      client.request<OutboundMessage>(`/v1/outbound/messages/${id}/mark`, {
        method: 'POST',
        body: { verdict, ...(note ? { note } : {}) },
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.outbound }),
  });
}

/**
 * The mailbox. `refetchMs` is for the moment after coming back from the
 * provider: it confirms the account by a separate server call that can land
 * after the browser returns, so the first read may still say "pending".
 */
export function useMailbox(options: { enabled?: boolean; refetchMs?: number | false } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.mailbox,
    queryFn: () => client.request<MailboxStatus>('/v1/mailbox'),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchMs ?? false,
  });
}

/** Returns the provider's URL; the caller sends the browser (or the in-app browser) there. */
export function useConnectMailbox() {
  const client = useApiClient();
  return useMutation({ mutationFn: () => client.request<{ url: string }>('/v1/mailbox/connect', { method: 'POST' }) });
}

export function useDisconnectMailbox() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.request('/v1/mailbox', { method: 'DELETE' }),
    // Disconnecting also turns sending off server-side, so settings change too.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.mailbox }),
        queryClient.invalidateQueries({ queryKey: queryKeys.outbound }),
      ]),
  });
}
