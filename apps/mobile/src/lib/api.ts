/**
 * The API client.
 *
 * Two authorization shapes coexist in this file, for two different kinds of
 * driver:
 *
 *  - **A check-in token in the URL** — the original flow, still fully
 *    supported (`Checkin.tsx`). No session to attach and no tenant header
 *    to send; the token alone is what those specific requests carry, and
 *    `request()` sends nothing extra on top of it.
 *  - **A signed-in account** — `Session`/`authHeaders()` below, the same
 *    shape `apps/web`'s client uses (`Authorization: Bearer <token>` plus
 *    `X-HaulQ-Org-Id`), attached automatically once `AuthGate.tsx` has
 *    signed someone in. Harmless to send on a token-authenticated request
 *    too — those routes read only the token and ignore anything else.
 */

import { createApiClient, type RequestOptions, type Session } from '@haulq/client';
import { currentToken } from './auth.ts';

// Request/error handling, the shared response shapes and the role/plan rules
// live in `@haulq/client`, shared with `apps/web`. What stays here is only
// what is specific to this app: where the session is stored, and the
// check-in shapes nothing else uses.
export { ApiRequestError } from '@haulq/client';
export type { RequestOptions, Session };

const BASE = import.meta.env['VITE_API_URL'] ?? '/api';

// Kept as `haulq.driver.session` after the rename to apps/mobile, on purpose:
// changing it would sign every installed user out on the next update.
const SESSION_KEY = 'haulq.driver.session';

export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function writeSession(session: Session | null): void {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // Private mode or storage disabled — the session still works for this
    // run, it just will not survive a real app kill. Same trade `Checkin.tsx`
    // already accepts for its own stored token.
  }
  window.dispatchEvent(new Event('haulq:session'));
}

async function authHeaders(session: Session | null): Promise<Record<string, string>> {
  const org = session?.orgId ? { 'X-HaulQ-Org-Id': session.orgId } : {};
  const token = await currentToken();
  return { ...org, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export const apiClient = createApiClient({
  baseUrl: BASE,
  readSession,
  authHeaders,
  onOrgUnresolved: (session) => writeSession({ userId: session.userId }),
});

export const request = apiClient.request;
export const requestBlob = apiClient.requestBlob;

// ---------------------------------------------------------------------------
// Shapes the API returns
// ---------------------------------------------------------------------------

export type StopMilestone = 'arrived' | 'loading_started' | 'loading_ended' | 'departed';

export interface CheckinStop {
  id: string;
  seq: number;
  type: 'pickup' | 'delivery';
  city: string;
  state: string;
  facilityName: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  arrivedAt: string | null;
  loadingStartedAt: string | null;
  loadingEndedAt: string | null;
  departedAt: string | null;
}

export interface CheckinPreview {
  loadReference: number;
  status: string;
  truckLabel: string | null;
  stops: CheckinStop[];
}
