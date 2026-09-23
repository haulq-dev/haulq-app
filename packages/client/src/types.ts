/**
 * Shapes the API returns, shared by both front ends.
 *
 * Moved here from `apps/web/src/lib/api.ts` as-is, so the two apps stop
 * re-declaring the same interfaces screen by screen. Where a shape already
 * exists as a Zod schema in `@haulq/contracts`, prefer importing that type
 * over adding a hand-written copy here.
 */

/**
 * Who is signed in and which carrier they are working in. Each app stores it
 * under its own key; this is only the shape.
 */
export interface Session {
  userId: string;
  /**
   * Written `?: string | undefined` rather than `?: string` because the
   * workspace runs with `exactOptionalPropertyTypes`, and clearing the selected
   * carrier means assigning undefined rather than deleting the key.
   */
  orgId?: string | undefined;
  orgName?: string | undefined;
  /** This login's role in `orgId`. For hiding controls only; the API's `requireRole` enforces. */
  role?: string | undefined;
}

export type OrgStatus = 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled';
export type OrgPlan = 'carrier' | 'fleet';

/** One row of `GET /v1/orgs`: an account this login can act in. */
export interface OrgSummary {
  id: string;
  name: string;
  role: string;
  /** Anything but `'active'` means no confirmed subscription. See `access.ts`. */
  status: OrgStatus;
  plan: OrgPlan | null;
}

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
  maxLengthFt: number | null;
  boxHeightIn: number | null;
  boxWidthIn: number | null;
  capabilities: Record<string, boolean>;
  shortHaulExempt: boolean;
  /** Set once a carrier matches this truck to a vehicle in Motive. Null until then. */
  motiveVehicleId: number | null;
  /** False once taken out of service — see `setTruckActive`. Still referenced by its history. */
  active: boolean;
}

export interface MotiveVehicle {
  id: number;
  /** The fleet's own identifier — "12", "Unit 12" — not Motive's internal id. */
  number: string;
  vin: string | null;
}

export interface MotiveMatchSuggestion {
  truckId: string;
  truckLabel: string;
  motiveVehicleId: number;
  motiveVehicleNumber: string;
}

export interface MotiveVehiclesResponse {
  vehicles: MotiveVehicle[];
  suggestions: MotiveMatchSuggestion[];
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
  /** What the carrier hands out to brokers instead, forwarding into the address above. */
  customDocsEmail: string | null;
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
  /** True when `suggestedMapping` came from a prior confirmed import with this exact header set, not a fresh guess. */
  rememberedMapping: boolean;
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
  driverId: string | null;
  expiresAt: string;
  createdAt: string;
  invitedByUserId: string | null;
}

/**
 * True for an address the API minted rather than received.
 *
 * Duplicated from `identity.ts` rather than imported: `@haulq/db` is a server
 * package and must not reach a front-end bundle. Fourteen characters of
 * duplication is a better trade than a dependency edge from a front end to db.
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
