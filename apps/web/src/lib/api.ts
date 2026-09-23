/**
 * The API client.
 *
 * One place that knows how to talk to the API, so the two things every request
 * needs — the tenant header and the error envelope — are handled once rather
 * than at forty call sites.
 *
 * ---------------------------------------------------------------------------
 * The dev session
 * ---------------------------------------------------------------------------
 *
 * Two auth modes, decided at build time by whether a Clerk publishable key is
 * present:
 *
 *   clerk — `Authorization: Bearer <session token>`, plus the org header
 *   dev   — the user/org headers `DevAuthenticator` reads, from localStorage
 *
 * **`X-HaulQ-Org-Id` is sent in both.** Clerk answers "which person is this";
 * the tenant is always HaulQ's, resolved from `org_memberships`. That is why
 * switching modes touches this file and nothing else.
 */

import {
  createApiClient,
  type RequestOptions,
  type Session,
} from '@haulq/client';
import { currentToken, usingClerk } from './auth.ts';

// Request/error handling, the response shapes and the role/plan rules live in
// `@haulq/client`, shared with `apps/mobile`. What stays here is only what is
// specific to web: where the session is stored, and the dev-header auth mode.
export { ApiRequestError } from '@haulq/client';
export type { RequestOptions, Session };

const BASE = import.meta.env['VITE_API_URL'] ?? '/api';

const SESSION_KEY = 'haulq.devSession';

export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function writeSession(session: Session | null): void {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new Event('haulq:session'));
}

async function authHeaders(session: Session | null): Promise<Record<string, string>> {
  const org = session?.orgId ? { 'X-HaulQ-Org-Id': session.orgId } : {};

  if (usingClerk) {
    const token = await currentToken();
    return { ...org, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  if (!session) return {};
  return { 'X-HaulQ-User-Id': session.userId, ...org };
}

export const apiClient = createApiClient({
  baseUrl: BASE,
  readSession,
  authHeaders,
  // Drop just the org, never the whole session: dev mode's `userId` still has
  // to survive this. See `ApiClientConfig.onOrgUnresolved`.
  onOrgUnresolved: (session) => writeSession({ userId: session.userId }),
});

export const request = apiClient.request;
export const requestBlob = apiClient.requestBlob;

// ---------------------------------------------------------------------------
// Shapes the API returns. They live in `@haulq/client` now and are re-exported
// so that no screen's import had to change.
// ---------------------------------------------------------------------------

export {
  ENDORSEMENTS,
  ROLES,
  isPlaceholderEmail,
  type CarrierProfile,
  type Driver,
  type Endorsement,
  type ExpiringCredential,
  type FactIssue,
  type HistorySummary,
  type ImportBatch,
  type ImportRow,
  type Invitation,
  type MappingGuess,
  type Member,
  type MotiveMatchSuggestion,
  type MotiveVehicle,
  type MotiveVehiclesResponse,
  type OnboardingStatus,
  type OnboardingStep,
  type OperatingFactsResponse,
  type Role,
  type TimelineEntry,
  type Truck,
  type UploadResponse,
} from '@haulq/client';
