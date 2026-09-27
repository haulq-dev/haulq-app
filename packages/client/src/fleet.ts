/**
 * Trucks and drivers: labels, form rules and the Motive matching sums both
 * front ends need. Copied out of `apps/web/src/routes/Trucks.tsx` and
 * `Drivers.tsx` for the mobile port (MOBILE_PARITY_PLAN.md M4). Web still
 * declares its own copy.
 */

import type { Driver, Endorsement, ExpiringCredential, MotiveMatchSuggestion, MotiveVehicle, Truck } from './types.ts';

/**
 * What a truck can do. The hints come from web, which lifted them from the
 * dispatcher's settings: every one of these fails silently. A missing
 * liftgate flag hides every load that mentions one, and nothing says so.
 */
export const TRUCK_CAPABILITIES = [
  { key: 'liftgate', label: 'Liftgate', hint: 'Loads requiring one are hidden without this' },
  { key: 'palletJack', label: 'Pallet jack', hint: 'Carried on the truck, not at the dock' },
  { key: 'driverAssist', label: 'Driver helps load', hint: 'Hand-unload, lumper work' },
  { key: 'twicCard', label: 'TWIC card', hint: 'Ports and secure facilities' },
  { key: 'hazmatEndorsement', label: 'Hazmat', hint: 'Placarded freight' },
  { key: 'securementGear', label: 'Straps and load bars', hint: 'Most trucks have these' },
  { key: 'dockHigh', label: 'Dock high', hint: 'Straight trucks often are not' },
  { key: 'teamDrivers', label: 'Team drivers', hint: 'Two drivers available' },
] as const;

/** The capability labels switched on for a truck, in `TRUCK_CAPABILITIES` order. */
export function capabilityLabels(capabilities: Record<string, boolean> | null | undefined): string[] {
  const on = capabilities ?? {};
  return TRUCK_CAPABILITIES.filter((c) => on[c.key]).map((c) => c.label);
}

export interface TruckFormValues {
  label: string;
  equipment: string;
  maxWeightLbs: string;
  maxLengthFt: string;
  boxHeightIn: string;
  boxWidthIn: string;
  shortHaulExempt: boolean;
  capabilities: Record<string, boolean>;
}

export const EMPTY_TRUCK_FORM: TruckFormValues = {
  label: '',
  equipment: 'STRAIGHT_BOX',
  maxWeightLbs: '',
  maxLengthFt: '',
  boxHeightIn: '',
  boxWidthIn: '',
  shortHaulExempt: false,
  capabilities: {},
};

export function truckToForm(truck: Truck): TruckFormValues {
  const str = (n: number | null) => (n === null ? '' : String(n));
  return {
    label: truck.label,
    equipment: truck.equipment,
    maxWeightLbs: str(truck.maxWeightLbs),
    maxLengthFt: str(truck.maxLengthFt),
    boxHeightIn: str(truck.boxHeightIn),
    boxWidthIn: str(truck.boxWidthIn),
    shortHaulExempt: truck.shortHaulExempt,
    capabilities: { ...(truck.capabilities ?? {}) },
  };
}

/** A whole positive number as typed (`26,000` is fine), `null` for blank, `undefined` for anything else. */
export function parseWholeNumber(input: string): number | null | undefined {
  const cleaned = input.trim().replace(/,/g, '');
  if (cleaned === '') return null;
  if (!/^\d+$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return n > 0 ? n : undefined;
}

const TRUCK_NUMBER_FIELDS = [
  ['maxWeightLbs', 'Max weight'],
  ['maxLengthFt', 'Max length'],
  ['boxHeightIn', 'Box height'],
  ['boxWidthIn', 'Box width'],
] as const;

/**
 * The form as `POST /v1/trucks` (`create`) or `PATCH /v1/trucks/:id`
 * (`update`) wants it. On update a blank number is sent as `null`, which
 * clears it; on create it is left out. A number that isn't a whole positive
 * number is named, rather than sent to bounce off the schema.
 */
export function truckBody(
  values: TruckFormValues,
  mode: 'create' | 'update',
): { body: Record<string, unknown> } | { invalid: string } {
  if (!values.label.trim()) return { invalid: 'Label' };
  const body: Record<string, unknown> = {
    label: values.label.trim(),
    equipment: values.equipment,
    shortHaulExempt: values.shortHaulExempt,
    capabilities: values.capabilities,
  };
  for (const [key, label] of TRUCK_NUMBER_FIELDS) {
    const n = parseWholeNumber(values[key]);
    if (n === undefined) return { invalid: label };
    if (n !== null) body[key] = n;
    else if (mode === 'update') body[key] = null;
  }
  return { body };
}

/**
 * Motive vehicles nothing in HaulQ claims yet: not a truck's current match
 * and not already offered as a suggestion (that one has its own confirm).
 */
export function unmatchedMotiveVehicles(
  vehicles: readonly MotiveVehicle[],
  trucks: readonly Pick<Truck, 'motiveVehicleId'>[],
  suggestions: readonly Pick<MotiveMatchSuggestion, 'motiveVehicleId'>[],
): MotiveVehicle[] {
  const claimed = new Set<number>();
  for (const t of trucks) if (t.motiveVehicleId !== null) claimed.add(t.motiveVehicleId);
  for (const s of suggestions) claimed.add(s.motiveVehicleId);
  return vehicles.filter((v) => !claimed.has(v.id));
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

export const ENDORSEMENT_LABEL: Record<Endorsement, string> = {
  hazmat: 'Hazmat',
  tanker: 'Tanker',
  doubles_triples: 'Doubles / triples',
  twic: 'TWIC',
  passenger: 'Passenger',
};

export const CREDENTIAL_LABEL: Record<ExpiringCredential['what'], string> = {
  cdl: 'CDL',
  medical_card: 'Medical card',
};

/** Warn this many days out. Matches web's strip and the API's default. */
export const CREDENTIAL_WARN_DAYS = 30;

/**
 * Where a credential date stands. An expired CDL or medical card puts the
 * driver out of service; that is a load that can't be covered, not a filing
 * task, so it is `bad`, not `warn`.
 */
export function credentialState(
  iso: string | null,
  now: number = Date.now(),
): { tone: 'bad' | 'warn' | 'ok' | 'none'; daysLeft: number | null } {
  if (!iso) return { tone: 'none', daysLeft: null };
  const daysLeft = Math.ceil((new Date(iso).getTime() - now) / 86_400_000);
  return { tone: daysLeft < 0 ? 'bad' : daysLeft <= CREDENTIAL_WARN_DAYS ? 'warn' : 'ok', daysLeft };
}

/** The worst of a driver's two credentials, for a list row. */
export function driverCredentialTone(driver: Pick<Driver, 'cdlExpiresAt' | 'medicalCardExpiresAt'>, now: number = Date.now()) {
  const tones = [credentialState(driver.cdlExpiresAt, now).tone, credentialState(driver.medicalCardExpiresAt, now).tone];
  return tones.includes('bad') ? 'bad' : tones.includes('warn') ? 'warn' : 'ok';
}

/**
 * A date input's `YYYY-MM-DD` as the API's datetime, at noon UTC, the same
 * convention web's driver form writes. Noon so a US time zone never shows it
 * as the day before.
 */
export function credentialDateToIso(value: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`).toISOString() : null;
}

/** The reverse, for filling the form: the UTC calendar date. */
export function isoToCredentialDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

export interface DriverFormValues {
  fullName: string;
  phone: string;
  email: string;
  cdlNumber: string;
  cdlState: string;
  cdlExpiresAt: string;
  medicalCardExpiresAt: string;
  endorsements: Endorsement[];
  defaultTruckId: string;
}

export const EMPTY_DRIVER_FORM: DriverFormValues = {
  fullName: '',
  phone: '',
  email: '',
  cdlNumber: '',
  cdlState: '',
  cdlExpiresAt: '',
  medicalCardExpiresAt: '',
  endorsements: [],
  defaultTruckId: '',
};

export function driverToForm(driver: Driver): DriverFormValues {
  return {
    fullName: driver.fullName,
    phone: driver.phone ?? '',
    email: driver.email ?? '',
    cdlNumber: driver.cdlNumber ?? '',
    cdlState: driver.cdlState ?? '',
    cdlExpiresAt: isoToCredentialDate(driver.cdlExpiresAt),
    medicalCardExpiresAt: isoToCredentialDate(driver.medicalCardExpiresAt),
    endorsements: driver.endorsements as Endorsement[],
    defaultTruckId: driver.defaultTruckId ?? '',
  };
}

/**
 * The form as `POST /v1/drivers` (`create`) or `PATCH /v1/drivers/:id`
 * (`update`) wants it. On update, a field emptied is sent as `null`, which
 * clears it; on create it is left out. Only obvious mistakes are caught here
 * (a state that isn't two letters); the API validates the rest.
 */
export function driverBody(
  values: DriverFormValues,
  mode: 'create' | 'update',
): { body: Record<string, unknown> } | { invalid: string } {
  if (!values.fullName.trim()) return { invalid: 'Full name' };
  const state = values.cdlState.trim().toUpperCase();
  if (state && !/^[A-Z]{2}$/.test(state)) return { invalid: 'State' };

  const body: Record<string, unknown> = { fullName: values.fullName.trim(), endorsements: values.endorsements };
  const put = (key: string, value: string | null) => {
    if (value) body[key] = value;
    else if (mode === 'update') body[key] = null;
  };
  put('phone', values.phone.trim() || null);
  put('email', values.email.trim() || null);
  put('cdlNumber', values.cdlNumber.trim() || null);
  put('cdlState', state || null);
  put('cdlExpiresAt', credentialDateToIso(values.cdlExpiresAt));
  put('medicalCardExpiresAt', credentialDateToIso(values.medicalCardExpiresAt));
  put('defaultTruckId', values.defaultTruckId || null);
  return { body };
}
