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

import type { ApiError } from '@haulq/contracts';
import { currentToken } from './auth.ts';

const BASE = import.meta.env['VITE_API_URL'] ?? '/api';

export interface Session {
  userId: string;
  /** `?: string | undefined`, not `?: string` — `exactOptionalPropertyTypes` is on, and clearing the org means assigning `undefined`, not deleting the key. */
  orgId?: string | undefined;
  orgName?: string | undefined;
  /** This login's role in `orgId` — owner/dispatcher/driver/accountant. Lets the UI hide owner/dispatcher-only actions from a driver; the API's own `requireRole` is what actually enforces it. */
  role?: string | undefined;
}

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

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly explanation: string;

  constructor(status: number, body: Partial<ApiError>) {
    const explanation = body.explanation ?? 'Something went wrong. Please try again.';
    super(explanation);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.code ?? 'unknown';
    this.explanation = explanation;
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = readSession();
  const headers: Record<string, string> = { ...(await authHeaders(session)) };
  let body: BodyInit | undefined;

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? (body ? 'POST' : 'GET'),
    headers,
    ...(body !== undefined ? { body } : {}),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    const errorBody = (parsed ?? {}) as Partial<ApiError>;

    // Same self-heal web's client does: an org that no longer resolves for
    // this login drops just the org, not the whole session, so the next
    // render can recover rather than 401ing forever.
    if (errorBody.code === 'unauthenticated' && session?.orgId) {
      writeSession({ userId: session.userId });
    }

    throw new ApiRequestError(response.status, errorBody);
  }

  return parsed as T;
}

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
