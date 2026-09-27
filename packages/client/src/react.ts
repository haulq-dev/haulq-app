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
import type { NearbyMechanicsResponse, NearbyStopsResponse, OperatingFacts } from '@haulq/contracts';
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
import {
  invoiceableLoads,
  type AgingBucket,
  type FactoringCompaniesPage,
  type FactoringCompany,
  type FactoringPacket,
  type Invoice,
  type InvoicesPage,
  type Payment,
  type PaymentSource,
} from './pay.ts';
import type { LoadProposalStatus, LoadProposalView } from './proposals.ts';
import { modeForPosition, type ActionPosition, type MailboxStatus, type OutboundEvidenceResponse, type OutboundMessage, type OutboundSettingsResponse } from './outbound.ts';
import { ApiRequestError } from './client.ts';
import { CREDENTIAL_WARN_DAYS } from './fleet.ts';
import type { InsightsResponse, MonthlyUsage } from './insights.ts';
import type { CursorPage, MembersPage } from './members.ts';
import type {
  CarrierProfile,
  Driver,
  ExpiringCredential,
  HistorySummary,
  Invitation,
  MotiveVehicle,
  MotiveVehiclesResponse,
  OperatingFactsResponse,
  OrgSummary,
  Role,
  TimelineEntry,
  Truck,
} from './types.ts';

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
  /** A prefix: invalidating it refreshes every proposal list and detail. */
  proposals: ['proposals'] as const,
  proposalList: (status: string) => ['proposals', 'list', status] as const,
  proposal: (id: string) => ['proposals', 'one', id] as const,
  /** A prefix: every invoice list and single invoice. `['invoices', status]` matches web's `Pay.tsx`. */
  invoices: ['invoices'] as const,
  invoiceList: (status: string) => ['invoices', status] as const,
  invoice: (id: string) => ['invoices', 'one', id] as const,
  invoicesForLoad: (loadId: string) => ['invoices', 'load', loadId] as const,
  receivablesAging: ['receivables-aging'] as const,
  invoicePayments: (id: string) => ['invoice-payments', id] as const,
  factoringPackets: (invoiceId: string) => ['factoring-packets', invoiceId] as const,
  factoringCompanies: ['factoring-companies'] as const,
  truckList: ['trucks', 'list'] as const,
  motiveVehicles: ['motive-vehicles'] as const,
  driverList: ['drivers', 'list'] as const,
  expiringCredentials: ['drivers', 'expiring'] as const,
  /** A prefix: the member list and the invitation list. */
  members: ['members'] as const,
  memberList: ['members', 'list'] as const,
  invitationList: ['members', 'invitations'] as const,
  insights: (days: number) => ['insights', days] as const,
  historySummary: ['history-summary'] as const,
  timeline: ['timeline'] as const,
  usage: ['usage'] as const,
  operatingFacts: ['operating-facts'] as const,
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

// --- Rate confirmations read as loads (FEATURE_REQUESTS_PLAN.md section 12) ---------

/** The proposals in one state, newest first. `pending` is what is waiting for someone to look. */
export function useLoadProposals(status: LoadProposalStatus = 'pending', options: { enabled?: boolean; refetchMs?: number } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.proposalList(status),
    queryFn: async () => (await client.request<{ items: LoadProposalView[] }>(`/v1/load-proposals?status=${status}`)).items,
    enabled: options.enabled ?? true,
    ...(options.refetchMs ? { refetchInterval: options.refetchMs } : {}),
  });
}

/** One proposal, in any state: an email links straight to it, and it may already have been dealt with. */
export function useLoadProposal(id: string, options: { enabled?: boolean } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.proposal(id),
    queryFn: () => client.request<LoadProposalView>(`/v1/load-proposals/${id}`),
    enabled: options.enabled ?? true,
  });
}

/** Everything that changes when a proposal is handled: the lists, and the loads and documents it touched. */
function useInvalidateProposals() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.proposals }),
      queryClient.invalidateQueries({ queryKey: queryKeys.loads }),
      queryClient.invalidateQueries({ queryKey: queryKeys.documents }),
    ]);
}

/** Read a rate confirmation as a load now: for one that arrived before this existed, or whose first reading came back empty. */
export function useProposeLoad() {
  const client = useApiClient();
  const invalidate = useInvalidateProposals();
  return useMutation({
    mutationFn: (documentId: string) => client.request<LoadProposalView>(`/v1/documents/${documentId}/propose-load`, { method: 'POST' }),
    onSettled: invalidate,
  });
}

/** Make the load. `body` is `createBodyFromForm`; the result says which load it became. */
export function useCreateFromProposal() {
  const client = useApiClient();
  const invalidate = useInvalidateProposals();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      client.request<{ load: { id: string; reference: number }; proposal: LoadProposalView | null }>(`/v1/load-proposals/${id}/create`, {
        method: 'POST',
        body,
      }),
    onSettled: invalidate,
  });
}

/** This rate confirmation is the paperwork of a load that already exists. */
export function useAttachProposal() {
  const client = useApiClient();
  const invalidate = useInvalidateProposals();
  return useMutation({
    mutationFn: ({ id, loadId }: { id: string; loadId: string }) =>
      client.request<{ load: { id: string; reference: number }; validation: { outcome: string; reason: string } | null }>(
        `/v1/load-proposals/${id}/attach`,
        { method: 'POST', body: { loadId } },
      ),
    onSettled: invalidate,
  });
}

/** This is not a load to create. */
export function useDismissProposal() {
  const client = useApiClient();
  const invalidate = useInvalidateProposals();
  return useMutation({
    mutationFn: (id: string) => client.request<{ ok: true }>(`/v1/load-proposals/${id}/dismiss`, { method: 'POST' }),
    onSettled: invalidate,
  });
}

// --- Pay (MOBILE_PARITY_PLAN.md M3) -------------------------------------------------

/** Invoices, a page at a time. `status` is one status or none; the counts are org-wide either way. */
export function useInvoices(status: string = '') {
  const client = useApiClient();
  return useInfiniteQuery({
    queryKey: queryKeys.invoiceList(status),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request<InvoicesPage>(
        `/v1/invoices?${new URLSearchParams({
          ...(status ? { status } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        })}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useInvoice(id: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.invoice(id),
    queryFn: async () => (await client.request<{ invoice: Invoice }>(`/v1/invoices/${id}`)).invoice,
  });
}

/** Every invoice on one load, void ones included. */
export function useInvoicesForLoad(loadId: string, options: { enabled?: boolean } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.invoicesForLoad(loadId),
    queryFn: async () => (await client.request<InvoicesPage>(`/v1/invoices?loadId=${loadId}`)).items,
    enabled: options.enabled ?? true,
  });
}

export function useReceivablesAging() {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.receivablesAging,
    queryFn: async () => (await client.request<{ buckets: AgingBucket[] }>('/v1/invoices/receivables-aging')).buckets,
  });
}

export function useInvoicePayments(invoiceId: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.invoicePayments(invoiceId),
    queryFn: async () => (await client.request<{ items: Payment[] }>(`/v1/invoices/${invoiceId}/payments`)).items,
  });
}

export function useFactoringPackets(invoiceId: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.factoringPackets(invoiceId),
    queryFn: async () =>
      (await client.request<{ items: FactoringPacket[] }>(`/v1/factoring-packets?invoiceId=${invoiceId}`)).items,
  });
}

export function useFactoringCompanies() {
  const client = useApiClient();
  return useInfiniteQuery({
    queryKey: queryKeys.factoringCompanies,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request<FactoringCompaniesPage>(
        `/v1/factoring-companies${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * Loads that can take a new invoice (`invoiceableLoads`). Both lists at the
 * API's page maximum: a carrier with more than 200 delivered-but-unpaid
 * loads has a bigger problem than this picker, and the API still refuses a
 * duplicate if one slips through.
 */
export function useInvoiceableLoads() {
  const client = useApiClient();
  return useQuery({
    queryKey: [...queryKeys.invoices, 'invoiceable-loads'],
    queryFn: async () => {
      const [loads, open] = await Promise.all([
        client.request<LoadsPage>('/v1/loads?status=delivered,invoiced&limit=200'),
        client.request<InvoicesPage>('/v1/invoices?status=draft,sent,paid&limit=200'),
      ]);
      return invoiceableLoads(loads.items, open.items);
    },
  });
}

/**
 * Everything a Pay write can change. Sending moves the load to `invoiced`
 * and a full payment moves it to `paid`, so the load caches go too.
 */
function useInvalidatePay() {
  const queryClient = useQueryClient();
  const prefixes = new Set<unknown>([
    queryKeys.invoices[0],
    queryKeys.receivablesAging[0],
    'invoice-payments',
    'factoring-packets',
    queryKeys.factoringCompanies[0],
    queryKeys.loads[0],
    'load',
    'load-margin',
  ]);
  return () => queryClient.invalidateQueries({ predicate: (q) => prefixes.has(q.queryKey[0]) });
}

/** `lineItems` is `lineItemsBody`'s output. The result is the new draft invoice. */
export function useGenerateInvoice() {
  const client = useApiClient();
  const invalidate = useInvalidatePay();
  return useMutation({
    mutationFn: (body: { loadId: string; lineItems: { code: string; description: string; amountCents: number }[] }) =>
      client.request<Invoice>('/v1/invoices', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

/** Records that it went to the broker. Sends nothing itself; see `invoiceActions`. */
export function useMarkInvoiceSent() {
  const client = useApiClient();
  const invalidate = useInvalidatePay();
  return useMutation({
    mutationFn: (id: string) => client.request<Invoice>(`/v1/invoices/${id}/send`, { method: 'POST' }),
    onSettled: invalidate,
  });
}

export function useVoidInvoice() {
  const client = useApiClient();
  const invalidate = useInvalidatePay();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      client.request<Invoice>(`/v1/invoices/${id}/void`, { method: 'POST', body: { reason } }),
    onSettled: invalidate,
  });
}

export interface RecordPaymentInput {
  invoiceId: string;
  amountCents: number;
  currency: string;
  source: PaymentSource;
  receivedAt?: string;
  reference?: string;
  factoringPacketId?: string;
}

export function useRecordPayment() {
  const client = useApiClient();
  const invalidate = useInvalidatePay();
  return useMutation({
    mutationFn: (input: RecordPaymentInput) =>
      client.request(`/v1/invoices/${input.invoiceId}/payments`, {
        method: 'POST',
        body: {
          amount: { amount: input.amountCents, currency: input.currency },
          source: input.source,
          ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
          ...(input.reference ? { reference: input.reference } : {}),
          ...(input.factoringPacketId ? { factoringPacketId: input.factoringPacketId } : {}),
        },
      }),
    onSuccess: invalidate,
  });
}

export function useAddFactoringCompany() {
  const client = useApiClient();
  const invalidate = useInvalidatePay();
  return useMutation({
    mutationFn: (body: { name: string; email?: string; phone?: string }) =>
      client.request<FactoringCompany>('/v1/factoring-companies', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

/** Starts with no documents attached; the API treats that as a normal first step. */
export function useAssemblePacket() {
  const client = useApiClient();
  const invalidate = useInvalidatePay();
  return useMutation({
    mutationFn: (body: { invoiceId: string; factoringCompanyId: string }) =>
      client.request<FactoringPacket>('/v1/factoring-packets', { method: 'POST', body: { ...body, documentIds: [] } }),
    onSuccess: invalidate,
  });
}

export function useSubmitPacket() {
  const client = useApiClient();
  const invalidate = useInvalidatePay();
  return useMutation({
    mutationFn: (id: string) => client.request<FactoringPacket>(`/v1/factoring-packets/${id}/submit`, { method: 'POST' }),
    onSettled: invalidate,
  });
}

export function useRespondToPacket() {
  const client = useApiClient();
  const invalidate = useInvalidatePay();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; outcome: 'accepted' | 'rejected'; reason?: string }) =>
      client.request<FactoringPacket>(`/v1/factoring-packets/${id}/response`, { method: 'POST', body }),
    onSettled: invalidate,
  });
}

// --- Fleet and people (MOBILE_PARITY_PLAN.md M4) -----------------------------------

/**
 * Everything a truck or driver write can change: both lists, the expiring
 * strip, Motive suggestions, and the loads that show a truck or driver name.
 */
function useInvalidateFleet() {
  const queryClient = useQueryClient();
  const prefixes = new Set<unknown>(['trucks', 'drivers', 'motive-vehicles', 'loads', 'load']);
  return () => queryClient.invalidateQueries({ predicate: (q) => prefixes.has(q.queryKey[0]) });
}

/** Every truck, a page at a time, inactive ones included. `['trucks', 'list']` matches web. */
export function useTruckList() {
  const client = useApiClient();
  return useInfiniteQuery({
    queryKey: queryKeys.truckList,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request<CursorPage<Truck>>(`/v1/trucks${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/**
 * Motive's vehicles and suggested matches. A 409 `not_connected` is the
 * normal answer for a carrier without Motive, not a failure to retry
 * (`isMotiveNotConnected`).
 */
export function useMotiveVehicles(options: { enabled?: boolean } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.motiveVehicles,
    queryFn: () => client.request<MotiveVehiclesResponse>('/v1/integrations/motive/vehicles'),
    retry: false,
    enabled: options.enabled ?? true,
  });
}

export function isMotiveNotConnected(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'not_connected';
}

export function useCreateTruck() {
  const client = useApiClient();
  const invalidate = useInvalidateFleet();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => client.request<Truck>('/v1/trucks', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateTruck() {
  const client = useApiClient();
  const invalidate = useInvalidateFleet();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      client.request<Truck>(`/v1/trucks/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

/** Out of service or back in. Never a delete; see `SetTruckActiveSchema`. */
export function useSetTruckActive() {
  const client = useApiClient();
  const invalidate = useInvalidateFleet();
  return useMutation({
    mutationFn: ({ id, active, reason }: { id: string; active: boolean; reason?: string }) =>
      client.request<Truck>(`/v1/trucks/${id}/active`, { method: 'PATCH', body: { active, ...(reason ? { reason } : {}) } }),
    onSettled: invalidate,
  });
}

/** `null` unmatches. */
export function useSetMotiveVehicle() {
  const client = useApiClient();
  const invalidate = useInvalidateFleet();
  return useMutation({
    mutationFn: ({ truckId, motiveVehicleId }: { truckId: string; motiveVehicleId: number | null }) =>
      client.request<Truck>(`/v1/trucks/${truckId}/motive-vehicle`, { method: 'PATCH', body: { motiveVehicleId } }),
    onSettled: invalidate,
  });
}

/** A Motive vehicle with no HaulQ truck: create the truck under its number and match it, in one tap. */
export function useCreateTruckFromMotive() {
  const client = useApiClient();
  const invalidate = useInvalidateFleet();
  return useMutation({
    mutationFn: async (vehicle: MotiveVehicle) => {
      const truck = await client.request<Truck>('/v1/trucks', {
        method: 'POST',
        body: { label: vehicle.number, equipment: 'STRAIGHT_BOX', capabilities: {} },
      });
      return client.request<Truck>(`/v1/trucks/${truck.id}/motive-vehicle`, {
        method: 'PATCH',
        body: { motiveVehicleId: vehicle.id },
      });
    },
    onSettled: invalidate,
  });
}

/** Every driver on the roster, a page at a time. `['drivers', 'list']` matches web. */
export function useDriverList() {
  const client = useApiClient();
  return useInfiniteQuery({
    queryKey: queryKeys.driverList,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request<CursorPage<Driver>>(`/v1/drivers${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** CDLs and medical cards expired or expiring within `CREDENTIAL_WARN_DAYS`. */
export function useExpiringCredentials() {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.expiringCredentials,
    queryFn: async () =>
      (await client.request<{ items: ExpiringCredential[] }>(`/v1/drivers/expiring?days=${CREDENTIAL_WARN_DAYS}`)).items,
  });
}

export function useCreateDriver() {
  const client = useApiClient();
  const invalidate = useInvalidateFleet();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => client.request<Driver>('/v1/drivers', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateDriver() {
  const client = useApiClient();
  const invalidate = useInvalidateFleet();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      client.request<Driver>(`/v1/drivers/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

/** Off the roster. The API refuses while they're on a booked, dispatched or in-transit load. */
export function useRemoveDriver() {
  const client = useApiClient();
  const invalidate = useInvalidateFleet();
  return useMutation({
    mutationFn: (id: string) => client.request<void>(`/v1/drivers/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

/** Members, a page at a time. Invitations page separately (`useInvitations`). */
export function useMembers() {
  const client = useApiClient();
  return useInfiniteQuery({
    queryKey: queryKeys.memberList,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request<MembersPage>(`/v1/members${pageParam ? `?membersCursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.members.nextCursor ?? undefined,
  });
}

export function useInvitations() {
  const client = useApiClient();
  return useInfiniteQuery({
    queryKey: queryKeys.invitationList,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request<MembersPage>(`/v1/members${pageParam ? `?invitationsCursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.invitations.nextCursor ?? undefined,
  });
}

/**
 * Member writes change the lists, and can change the caller's own role
 * (the org list carries it) and which roster row a driver login controls.
 */
function useInvalidateMembers() {
  const queryClient = useQueryClient();
  const prefixes = new Set<unknown>([queryKeys.members[0], queryKeys.orgs[0], 'drivers']);
  return () => queryClient.invalidateQueries({ predicate: (q) => prefixes.has(q.queryKey[0]) });
}

/** The token comes back once; the database keeps only its hash. */
export function useInvite() {
  const client = useApiClient();
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: (body: { email: string; role: Role; driverId?: string }) =>
      client.request<{ invitation: Invitation; token: string }>('/v1/members/invites', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useRevokeInvitation() {
  const client = useApiClient();
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: (id: string) => client.request(`/v1/members/invites/${id}`, { method: 'DELETE' }),
    onSettled: invalidate,
  });
}

export function useChangeRole() {
  const client = useApiClient();
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      client.request(`/v1/members/${userId}`, { method: 'PATCH', body: { role } }),
    onSettled: invalidate,
  });
}

export function useRemoveMember() {
  const client = useApiClient();
  const invalidate = useInvalidateMembers();
  return useMutation({
    mutationFn: (userId: string) => client.request(`/v1/members/${userId}`, { method: 'DELETE' }),
    onSettled: invalidate,
  });
}

// --- Insights, activity, profile (MOBILE_PARITY_PLAN.md M5) ------------------------

/** The rollups for the last `days` days, plus the not-windowed "needs attention" queue. */
export function useInsights(days: number) {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.insights(days),
    queryFn: () => client.request<InsightsResponse>(`/v1/insights?days=${days}`),
  });
}

/** What the imported load history says. Zero loads for a carrier that never imported. */
export function useHistorySummary() {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.historySummary,
    queryFn: () => client.request<HistorySummary>('/v1/imports/history-summary'),
  });
}

/** The audit trail, newest first, 50 at a time. The cursor is the last `seq` seen. */
export function useTimeline() {
  const client = useApiClient();
  return useInfiniteQuery({
    queryKey: queryKeys.timeline,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.request<{ items: TimelineEntry[]; nextCursor: string | null }>(
        `/v1/timeline?${new URLSearchParams({ limit: '50', ...(pageParam ? { before: pageParam } : {}) })}`,
      ),
    initialPageParam: undefined as string | undefined,
    // A short page is the last one; the API returns a cursor whenever it returned anything.
    getNextPageParam: (last) => (last.items.length < 50 ? undefined : (last.nextCursor ?? undefined)),
  });
}

export function useUsage() {
  const client = useApiClient();
  return useQuery({ queryKey: queryKeys.usage, queryFn: () => client.request<MonthlyUsage>('/v1/usage') });
}

export function useOperatingFacts() {
  const client = useApiClient();
  return useQuery({
    queryKey: queryKeys.operatingFacts,
    queryFn: () => client.request<OperatingFactsResponse>('/v1/org/operating-facts'),
  });
}

/**
 * Saving costs changes every margin: insights, load margins, the profile's
 * "used for margins" state. The API answers a blocked save with 200 and
 * `saved: false`; that is surfaced as an error here so a screen can't show
 * "Saved" for it.
 */
export function useSaveOperatingFacts() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (facts: OperatingFacts) => {
      const res = await client.request<{ saved: boolean; explanation?: string }>('/v1/org/operating-facts', {
        method: 'PUT',
        body: facts,
      });
      if (!res.saved) throw new Error(res.explanation ?? 'Those costs could not be saved.');
      return res;
    },
    onSuccess: () => {
      const prefixes = new Set<unknown>([queryKeys.operatingFacts[0], 'insights', 'load-margin', queryKeys.profile[0]]);
      return queryClient.invalidateQueries({ predicate: (q) => prefixes.has(q.queryKey[0]) });
    },
  });
}

/** Only the fields given change; `null` clears one. */
export function useUpdateProfile() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, string | null>) =>
      client.request<CarrierProfile>('/v1/org/profile', { method: 'PATCH', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.profile }),
  });
}
