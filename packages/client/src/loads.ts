/**
 * Loads: the shapes `GET /v1/loads` and its sub-resources return, and the
 * small pure rules both front ends apply to them.
 *
 * Copied from `apps/web/src/routes/Loads.tsx` and `LoadDetail.tsx` for the
 * mobile port (MOBILE_PARITY_PLAN.md M1). Web still declares its own copies.
 * Move web onto these once its uncommitted `?search=` work in `Loads.tsx` has
 * landed, so the two changes don't collide.
 */

import type { LoadStatus } from '@haulq/contracts';

export interface Stop {
  id: string;
  seq: number;
  type: 'pickup' | 'delivery';
  city: string;
  state: string;
  facilityName: string | null;
  addressLine1: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  windowStart: string | null;
  windowEnd: string | null;
}

export interface Load {
  id: string;
  reference: number;
  status: LoadStatus;
  source: string;
  brokerId: string | null;
  brokerName: string | null;
  /** Null means the broker has no override, and the tracking page falls back to a two-hour default. */
  brokerDetentionFreeMinutes: number | null;
  brokerLoadNumber: string | null;
  equipment: string;
  commodity: string | null;
  weightLbs: number | null;
  rateAmount: number | null;
  rateCurrency: string | null;
  rateIsLinehaul: boolean;
  expectedDeadheadMiles: number | null;
  expectedLoadedMiles: number | null;
  truckId: string | null;
  truckLabel: string | null;
  driverId: string | null;
  driverName: string | null;
  cancelledReason: string | null;
  stops: Stop[];
}

export interface LoadsPage {
  items: Load[];
  /** Org-wide, per status. The same on every page. */
  counts: Record<string, number>;
  nextCursor: string | null;
}

export interface LoadMargin {
  reference: number;
  revenueCents: number | null;
  loadedMiles: number | null;
  deadheadMiles: number | null;
  revenuePerTotalMileCents: number | null;
  revenuePerLoadedMileCents: number | null;
  basis: 'actual' | 'expected';
  invoiceStatus: string | null;
  invoiceTotalCents: number | null;
}

export interface TrackingStopView {
  seq: number;
  type: string;
  city: string;
  state: string;
  facilityName: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  arrivedAt: string | null;
  loadingStartedAt: string | null;
  loadingEndedAt: string | null;
  departedAt: string | null;
  detentionMinutes: number | null;
  stillOnSite: boolean;
}

export interface LoadTrackingView {
  orgName: string;
  loadReference: number;
  status: string;
  equipment: string;
  truck: {
    label: string | null;
    currentCity: string | null;
    currentState: string | null;
    currentLat: number | null;
    currentLng: number | null;
    positionAt: string | null;
  } | null;
  stops: TrackingStopView[];
  eta: { stopSeq: number; milesRemaining: number; arrivalAt: string } | null;
}

export interface BrokerVerification {
  mcNumber: string | null;
  usdotNumber: string | null;
  verification: {
    source: string;
    operatingStatus: string | null;
    checkedAt: string;
  } | null;
  recheckEnabled: boolean;
  nextRecheckDue: string | null;
}

export interface BrokerDocumentHistory {
  consideredCount: number;
  manualCount: number;
}

export interface GeocodeCandidate {
  label: string;
  lat: number;
  lng: number;
  score: number;
}

export const LOAD_STATUS_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = {
  delivered: 'ok',
  invoiced: 'ok',
  paid: 'ok',
  cancelled: 'warn',
};

/** `in_transit` → `in transit`. */
export const prettyStatus = (s: string) => s.replace(/_/g, ' ');

export const formatMoney = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

/**
 * Rate per total mile and per loaded mile, in cents per mile.
 *
 * Returns null when deadhead is unknown rather than assuming zero. Assuming
 * zero gives the flattering number by default. A $400 load over 127 loaded
 * miles reads as $3.15/mi, but with 176 deadhead miles to reach it, it's
 * $1.32/mi. That gap is why the total-mile figure is the headline everywhere.
 */
export function ratePerMile(load: Pick<Load, 'rateAmount' | 'expectedLoadedMiles' | 'expectedDeadheadMiles'>): {
  total: number;
  loaded: number;
} | null {
  if (!load.rateAmount || !load.expectedLoadedMiles) return null;
  if (load.expectedDeadheadMiles === null) return null;
  const totalMiles = load.expectedLoadedMiles + load.expectedDeadheadMiles;
  return { total: load.rateAmount / totalMiles, loaded: load.rateAmount / load.expectedLoadedMiles };
}

/** Under roughly $1.50 per total mile. */
export const THIN_RATE_CENTS_PER_MILE = 150;

/** The lane's two ends: the first pickup and the last delivery. */
export function laneEnds(stops: Stop[]): { pickup: Stop | undefined; delivery: Stop | undefined } {
  return {
    pickup: stops.find((s) => s.type === 'pickup'),
    delivery: [...stops].reverse().find((s) => s.type === 'delivery'),
  };
}

/** "3 hrs ago", "just now". A freshness signal, not a clock. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** 135 → "2h 15m". */
export function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

/**
 * `<input type="datetime-local">` wants local time with no timezone marker.
 * The reverse, `new Date(value).toISOString()`, is correct as-is, because
 * `Date` parses a bare local string as local time.
 */
export function toDatetimeLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Whether a geocode's top match is safe to use without showing the others.
 * The coordinates always fill in from the top match either way; this only
 * decides whether the alternates stay visible as a correction list.
 */
export function isClearGeocodeWinner(candidates: GeocodeCandidate[]): boolean {
  const [top, runnerUp] = candidates;
  if (!top) return false;
  return top.score >= 0.7 && (!runnerUp || top.score - runnerUp.score >= 0.15);
}
