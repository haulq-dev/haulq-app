/**
 * Mapping a carrier's columns onto HaulQ's fields.
 *
 * The guessing here is a convenience, not a decision. Every guess is proposed
 * to the operator with a confidence, and nothing commits until a human confirms
 * the mapping. That is deliberate: a column called "Rate" might be the linehaul
 * or the all-in, and a wrong guess produces an import that looks perfect and is
 * wrong by the fuel surcharge on every load.
 */

import { z } from 'zod';
import {
  coerceDate,
  coerceInteger,
  coerceMoneyCents,
  coercePlace,
  coerceState,
} from './coerce.ts';

/** The fields an imported load can populate. */
export const IMPORT_FIELDS = [
  'reference',
  'brokerName',
  'brokerLoadNumber',
  'originCity',
  'originState',
  'origin',
  'destCity',
  'destState',
  'destination',
  'pickupDate',
  'deliveryDate',
  'rate',
  'loadedMiles',
  'deadheadMiles',
  'weightLbs',
  'commodity',
  'truckLabel',
  'notes',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** `{ "Pickup City": "originCity" }`. A header may map to nothing. */
export const ColumnMappingSchema = z.record(z.string(), z.enum(IMPORT_FIELDS).nullable());
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

/**
 * Header patterns, most specific first.
 *
 * Order matters: "delivery date" must beat "date", and "origin city" must beat
 * "city". Matching is on a normalized header — lower case, punctuation and
 * spacing collapsed — so "Pick-up City", "PICKUP_CITY" and "Pickup City" all
 * land on the same rule.
 */
const PATTERNS: Array<{ field: ImportField; test: RegExp; confidence: number }> = [
  { field: 'brokerLoadNumber', test: /^(broker|customer)?\s*(load|order|pro)\s*(number|no|#|id)$/, confidence: 0.9 },
  { field: 'reference', test: /^(load|trip|invoice)?\s*(number|no|#|id|ref(erence)?)$/, confidence: 0.7 },

  { field: 'brokerName', test: /^(broker|customer|shipper|company|bill\s*to)( name)?$/, confidence: 0.9 },

  { field: 'originCity', test: /^(origin|pick\s*up|pu|from|ship)\s*city$/, confidence: 0.95 },
  { field: 'originState', test: /^(origin|pick\s*up|pu|from|ship)\s*(state|st)$/, confidence: 0.95 },
  { field: 'origin', test: /^(origin|pick\s*up|pu|from|shipper|ship\s*from)( location| address)?$/, confidence: 0.8 },

  { field: 'destCity', test: /^(dest(ination)?|delivery|drop|do|to|consignee)\s*city$/, confidence: 0.95 },
  { field: 'destState', test: /^(dest(ination)?|delivery|drop|do|to|consignee)\s*(state|st)$/, confidence: 0.95 },
  { field: 'destination', test: /^(dest(ination)?|delivery|drop|do|to|consignee|ship\s*to)( location| address)?$/, confidence: 0.8 },

  { field: 'pickupDate', test: /^(pick\s*up|pu|origin|ship)\s*date$/, confidence: 0.95 },
  { field: 'deliveryDate', test: /^(deliver(y|ed)?|drop|do|dest(ination)?)\s*date$/, confidence: 0.95 },
  { field: 'deliveryDate', test: /^date\s*deliver(ed|y)$/, confidence: 0.9 },
  { field: 'pickupDate', test: /^date$/, confidence: 0.4 },

  { field: 'rate', test: /^(gross\s*)?(rate|revenue|amount|pay|linehaul|total|charge)( amount)?$/, confidence: 0.8 },
  { field: 'rate', test: /^(all\s*in|agreed)\s*rate$/, confidence: 0.95 },

  { field: 'loadedMiles', test: /^(loaded|billable|trip|total)?\s*miles?$/, confidence: 0.8 },
  { field: 'deadheadMiles', test: /^(dead\s*head|dh|empty)\s*miles?$/, confidence: 0.95 },

  { field: 'weightLbs', test: /^(weight|wt)(\s*(lbs?|pounds?))?$/, confidence: 0.9 },
  { field: 'commodity', test: /^(commodity|freight|product|description)$/, confidence: 0.8 },
  { field: 'truckLabel', test: /^(truck|unit|tractor|vehicle)(\s*(number|no|#|id))?$/, confidence: 0.8 },
  { field: 'notes', test: /^(notes?|comments?|remarks?|instructions?)$/, confidence: 0.9 },
];

function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/[^a-z0-9 #]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MappingGuess {
  header: string;
  field: ImportField | null;
  confidence: number;
}

/**
 * Propose a mapping.
 *
 * Each field is claimed by at most one header — the highest-confidence match.
 * Without that, a file with both "Miles" and "Loaded Miles" maps both to
 * `loadedMiles` and one silently wins.
 */
export function guessMapping(headers: string[]): MappingGuess[] {
  const guesses: MappingGuess[] = headers.map((header) => {
    const normalized = normalizeHeader(header);
    for (const p of PATTERNS) {
      if (p.test.test(normalized)) {
        return { header, field: p.field, confidence: p.confidence };
      }
    }
    return { header, field: null, confidence: 0 };
  });

  const bestPerField = new Map<ImportField, MappingGuess>();
  for (const g of guesses) {
    if (!g.field) continue;
    const held = bestPerField.get(g.field);
    if (!held || g.confidence > held.confidence) bestPerField.set(g.field, g);
  }

  return guesses.map((g) =>
    g.field && bestPerField.get(g.field) !== g
      ? { header: g.header, field: null, confidence: 0 }
      : g,
  );
}

// ---------------------------------------------------------------------------
// Applying a mapping to a row
// ---------------------------------------------------------------------------

export interface ParsedLoadRow {
  reference?: number;
  brokerName?: string;
  brokerLoadNumber?: string;
  originCity?: string;
  originState?: string;
  destCity?: string;
  destState?: string;
  pickupDate?: string;
  deliveryDate?: string;
  rateAmount?: number;
  loadedMiles?: number;
  deadheadMiles?: number;
  weightLbs?: number;
  commodity?: string;
  truckLabel?: string;
  notes?: string;
}

export interface RowIssue {
  field: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface CoercedRow {
  parsed: ParsedLoadRow;
  issues: RowIssue[];
}

/**
 * Coerce one row.
 *
 * Every issue is collected rather than thrown, so a carrier reviewing an import
 * sees all of a row's problems at once. Severity decides whether the row can be
 * committed: an unreadable delivery date is an error because it is the anchor
 * for every margin-over-time figure, while an unreadable weight is a warning
 * because nothing in Phase 0 divides by it.
 */
export function coerceRow(
  cells: Record<string, string>,
  mapping: ColumnMapping,
): CoercedRow {
  const issues: RowIssue[] = [];
  const parsed: ParsedLoadRow = {};

  const cellFor = (field: ImportField): string | undefined => {
    for (const [header, mapped] of Object.entries(mapping)) {
      if (mapped === field) return cells[header];
    }
    return undefined;
  };

  const note = (field: string, severity: 'error' | 'warning', message?: string) => {
    if (message) issues.push({ field, severity, message });
  };

  // --- identity ------------------------------------------------------------

  const reference = coerceInteger(cellFor('reference'), {
    label: 'Load number',
    min: 1,
  });
  note('reference', 'warning', reference.issue);
  if (reference.value !== undefined) parsed.reference = reference.value;

  const broker = cellFor('brokerName')?.trim();
  if (broker) parsed.brokerName = broker;
  else {
    issues.push({
      field: 'brokerName',
      severity: 'warning',
      message: 'No broker named. This load will not appear in broker profitability.',
    });
  }

  const brokerLoad = cellFor('brokerLoadNumber')?.trim();
  if (brokerLoad) parsed.brokerLoadNumber = brokerLoad;

  // --- places --------------------------------------------------------------

  const origin = coercePlace(
    cellFor('origin'),
    cellFor('originCity'),
    cellFor('originState'),
  );
  note('origin', 'error', origin.issue);
  if (origin.value?.city) parsed.originCity = origin.value.city;
  if (origin.value?.state) parsed.originState = origin.value.state;

  const dest = coercePlace(
    cellFor('destination'),
    cellFor('destCity'),
    cellFor('destState'),
  );
  note('destination', 'error', dest.issue);
  if (dest.value?.city) parsed.destCity = dest.value.city;
  if (dest.value?.state) parsed.destState = dest.value.state;

  if (!parsed.originCity && !parsed.destCity) {
    issues.push({
      field: 'origin',
      severity: 'error',
      message: 'A load needs at least one location. Neither origin nor destination could be read.',
    });
  }

  // --- dates ---------------------------------------------------------------

  const pickup = coerceDate(cellFor('pickupDate'));
  note('pickupDate', 'warning', pickup.issue);
  if (pickup.value) parsed.pickupDate = pickup.value;

  const delivery = coerceDate(cellFor('deliveryDate'));
  // An error, not a warning: the delivery date anchors every margin-by-period
  // figure the import exists to produce.
  note('deliveryDate', 'error', delivery.issue);
  if (delivery.value) parsed.deliveryDate = delivery.value;

  if (parsed.pickupDate && parsed.deliveryDate && parsed.deliveryDate < parsed.pickupDate) {
    issues.push({
      field: 'deliveryDate',
      severity: 'error',
      message: 'Delivery is before pickup. Usually a day/month swap in one of the two columns.',
    });
  }

  // --- money and distance --------------------------------------------------

  const rate = coerceMoneyCents(cellFor('rate'));
  // An error rather than a warning, deliberately. A silent zero here is
  // invisible in a list of ninety loads and drags measured revenue per mile
  // down until someone happens to investigate.
  note('rate', 'error', rate.issue);
  if (rate.value !== undefined) {
    if (rate.value < 0) {
      issues.push({
        field: 'rate',
        severity: 'error',
        message: 'A negative rate is not a load. If this row is a credit or adjustment, leave it out.',
      });
    } else {
      parsed.rateAmount = rate.value;
    }
  }

  const loaded = coerceInteger(cellFor('loadedMiles'), { label: 'Loaded miles', min: 0, max: 10_000 });
  note('loadedMiles', 'warning', loaded.issue);
  if (loaded.value !== undefined) parsed.loadedMiles = loaded.value;

  const deadhead = coerceInteger(cellFor('deadheadMiles'), { label: 'Deadhead miles', min: 0, max: 5_000 });
  note('deadheadMiles', 'warning', deadhead.issue);
  if (deadhead.value !== undefined) parsed.deadheadMiles = deadhead.value;

  const weight = coerceInteger(cellFor('weightLbs'), { label: 'Weight', min: 0, max: 100_000 });
  note('weightLbs', 'warning', weight.issue);
  if (weight.value !== undefined) parsed.weightLbs = weight.value;

  // --- free text -----------------------------------------------------------

  const commodity = cellFor('commodity')?.trim();
  if (commodity) parsed.commodity = commodity;

  const truck = cellFor('truckLabel')?.trim();
  if (truck) parsed.truckLabel = truck;

  const notes = cellFor('notes')?.trim();
  if (notes) parsed.notes = notes;

  // --- plausibility --------------------------------------------------------
  //
  // Not a parse failure — every field read cleanly — but a combination worth
  // flagging. $12/mi on a 400-mile run is a decimal in the wrong place or a
  // rate entered for the whole month.

  if (parsed.rateAmount !== undefined && parsed.loadedMiles) {
    const perMile = parsed.rateAmount / parsed.loadedMiles;
    if (perMile > 1500) {
      issues.push({
        field: 'rate',
        severity: 'warning',
        message: `$${(perMile / 100).toFixed(2)}/mi is far above market. Check the rate and miles columns.`,
      });
    } else if (perMile > 0 && perMile < 50) {
      issues.push({
        field: 'rate',
        severity: 'warning',
        message: `$${(perMile / 100).toFixed(2)}/mi is far below market. Check whether the rate column is the full amount.`,
      });
    }
  }

  return { parsed, issues };
}

export function rowHasErrors(issues: RowIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

// ---------------------------------------------------------------------------
// Broker name matching
// ---------------------------------------------------------------------------

const ENTITY_SUFFIXES =
  /\b(inc|incorporated|llc|l\.?l\.?c|ltd|limited|co|corp|corporation|company|group|logistics|transport(ation)?|freight|lines?|services?|solutions?)\b/g;

/**
 * A key for matching broker names that differ only cosmetically.
 *
 * "Acme Logistics", "ACME LOGISTICS, INC." and "Acme  Logistics LLC" are one
 * broker in a carrier's head and should be one row in the database. Without
 * this, ninety days of history produces three Acmes and broker profitability —
 * the thing the import exists to enable — is split three ways.
 *
 * Entity suffixes are stripped rather than compared because they are the most
 * common cosmetic difference and the least meaningful. The risk is collapsing
 * two genuinely different companies whose names differ only by suffix; that is
 * rare, and a carrier can split them, whereas the alternative leaves them
 * merging duplicates by hand across an entire import.
 */
export function brokerMatchKey(name: string): string {
  const stripped = name
    .toLowerCase()
    .replace(/[.,'"&()]/g, ' ')
    .replace(ENTITY_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // If suffix-stripping ate the whole name — a broker literally called
  // "Logistics Company" — fall back to the punctuation-stripped form rather
  // than returning an empty key that would match every other such broker.
  return stripped || name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
