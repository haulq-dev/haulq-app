/**
 * The API client.
 *
 * Simpler than `apps/web`'s: nothing here signs in. The check-in token in
 * the URL is the whole authorization — see `repositories/track.ts`'s module
 * note on why a driver holding this link writes as an `integration` actor
 * rather than a `user`. There is no session to attach and no tenant header
 * to send; the token alone is what every one of these requests carries.
 */

import type { ApiError } from '@haulq/contracts';

const BASE = import.meta.env['VITE_API_URL'] ?? '/api';

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
  const headers: Record<string, string> = {};
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
    throw new ApiRequestError(response.status, (parsed ?? {}) as Partial<ApiError>);
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
