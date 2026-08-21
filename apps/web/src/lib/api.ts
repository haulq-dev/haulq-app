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

import type { ApiError } from '@haulq/contracts';
import { currentToken, usingClerk } from './auth.ts';

const BASE = import.meta.env['VITE_API_URL'] ?? '/api';

export interface Session {
  userId: string;
  /**
   * Written `?: string | undefined` rather than `?: string` because the
   * workspace runs with `exactOptionalPropertyTypes`, and clearing the selected
   * carrier means assigning undefined rather than deleting the key.
   */
  orgId?: string | undefined;
  orgName?: string | undefined;
}

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

/**
 * A failed request, carrying the API's own explanation.
 *
 * The API guarantees an `explanation` on every error — guardrail 6 applies to
 * failures too. So the UI never has to invent prose from a status code, and
 * this class exists to make that guarantee reach the component that renders it.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly explanation: string;

  constructor(status: number, body: Partial<ApiError>) {
    const explanation =
      body.explanation ?? 'Something went wrong. Please try again.';
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
  /** Sent as-is with the given content type, for the CSV upload. */
  raw?: { body: BodyInit; contentType: string };
  session?: Session | null;
}

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const session = options.session !== undefined ? options.session : readSession();

  const headers: Record<string, string> = { ...(await authHeaders(session)) };
  let body: BodyInit | undefined;

  if (options.raw) {
    headers['Content-Type'] = options.raw.contentType;
    body = options.raw.body;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? (body ? 'POST' : 'GET'),
    headers,
    // Spread rather than `body,` — under exactOptionalPropertyTypes an explicit
    // `body: undefined` is not the same as omitting it, and RequestInit says
    // omitted.
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

/**
 * Fetch bytes rather than JSON.
 *
 * A document preview cannot be an `<img src>` pointing at the API: the request
 * needs the tenant header and, under Clerk, a bearer token, and neither travels
 * on a plain element load. So the bytes come through here and the caller turns
 * them into an object URL.
 *
 * Errors still arrive as JSON — the API's envelope applies to failures on this
 * endpoint too — so a non-OK response is parsed as one rather than handed back
 * as a blob nobody can read.
 */
export async function requestBlob(
  path: string,
  options: { session?: Session | null } = {},
): Promise<Blob> {
  const session = options.session !== undefined ? options.session : readSession();
  const response = await fetch(`${BASE}${path}`, {
    headers: await authHeaders(session),
  });

  if (!response.ok) {
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as Partial<ApiError>) : {};
    throw new ApiRequestError(response.status, parsed);
  }

  return response.blob();
}

// ---------------------------------------------------------------------------
// Shapes the API returns
// ---------------------------------------------------------------------------

export interface OnboardingStep {
  id: string;
  title: string;
  done: boolean;
  required: boolean;
  unlocks: string;
  consequence?: string;
}

export interface OnboardingStatus {
  steps: OnboardingStep[];
  completedRequired: number;
  totalRequired: number;
  ready: boolean;
  factsReconciled: boolean;
}

export interface Truck {
  id: string;
  label: string;
  equipment: string;
  maxWeightLbs: number | null;
  capabilities: Record<string, boolean>;
  shortHaulExempt: boolean;
}

export interface CarrierProfile {
  legalName: string;
  dbaName: string | null;
  mcNumber: string | null;
  usdotNumber: string | null;
  city: string | null;
  state: string | null;
  operatingFactsReconciledAt: string | null;
  /** From `orgs.slug`. `docs+{slug}@docs.haulq.ai` is this org's inbound address. */
  slug: string | null;
}

export interface FactIssue {
  field: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface OperatingFactsResponse {
  facts: Record<string, number>;
  issues: FactIssue[];
  completeForScoring: boolean;
  reconciledAt: string | null;
}

export interface ImportBatch {
  id: string;
  status: string;
  filename: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  committedRows: number;
}

export interface MappingGuess {
  header: string;
  field: string | null;
  confidence: number;
}

export interface UploadResponse {
  batch: ImportBatch;
  headers: string[];
  suggestedMapping: MappingGuess[];
  sampleRows: Record<string, string>[];
}

export interface ImportRow {
  rowNumber: number;
  status: string;
  raw: Record<string, string>;
  errors: Array<{ field: string; severity: string; message: string }>;
}

export interface HistorySummary {
  loadCount: number;
  periodDays: number;
  earliest: string | null;
  latest: string | null;
  totalRevenueCents: number;
  totalMiles: number;
  revenuePerMileCents: number | null;
}

/**
 * Roles, in the order they are offered.
 *
 * The repository enforces two rules this UI can only reflect, never replace:
 * an org always keeps at least one owner, and only an owner can create one.
 * Disabling a control is a courtesy; the API is what actually refuses.
 */
export const ROLES = ['owner', 'dispatcher', 'driver', 'accountant'] as const;
export type Role = (typeof ROLES)[number];

export interface Member {
  userId: string;
  email: string;
  fullName: string | null;
  role: Role;
  acceptedAt: string | null;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  invitedByUserId: string | null;
}

export interface MembersResponse {
  members: Member[];
  invitations: Invitation[];
}

/**
 * True for an address the API minted rather than received.
 *
 * Duplicated from `identity.ts` rather than imported: `@haulq/db` is a server
 * package and must not reach the browser bundle. Fourteen characters of
 * duplication is a better trade than a dependency edge from web to db.
 */
export function isPlaceholderEmail(email: string): boolean {
  return email.endsWith('@users.clerk.invalid');
}

export const ENDORSEMENTS = [
  'hazmat',
  'tanker',
  'doubles_triples',
  'twic',
  'passenger',
] as const;
export type Endorsement = (typeof ENDORSEMENTS)[number];

export interface Driver {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  cdlNumber: string | null;
  cdlState: string | null;
  /** ISO 8601. Null when the carrier has not recorded one. */
  cdlExpiresAt: string | null;
  medicalCardExpiresAt: string | null;
  endorsements: string[];
  defaultTruckId: string | null;
}

export interface ExpiringCredential {
  driverId: string;
  driverName: string;
  what: 'cdl' | 'medical_card';
  expiresAt: string;
}
export interface TimelineEntry {
  seq: string;
  occurredAt: string;
  verb: string;
  subjectType: string;
  explanation: string;
  actorType: string;
  actorId: string | null;
}
