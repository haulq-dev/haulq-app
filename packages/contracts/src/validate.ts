/**
 * Comparing a document against the load it belongs to.
 *
 * This is the product. Everything before it — reading the bytes, deciding what
 * the document is, pulling the numbers off it — exists so this comparison can
 * happen. Extraction says "the model read $2,400 off this PDF"; validation says
 * "that is not what the broker agreed to", and only the second sentence is worth
 * paying for.
 *
 * Pure, and in contracts, for the same reason `summarizeValidation` is: the
 * disagreement screen has to reach the same conclusion the database recorded,
 * and `apps/web` cannot import `@haulq/db`. One implementation of the rule, or
 * the screen and the record eventually tell a carrier different things.
 *
 * ---------------------------------------------------------------------------
 * Severity is a claim about consequences, not about confidence
 * ---------------------------------------------------------------------------
 *
 *   error    money or identity. The rate disagrees, or the broker's load number
 *            says this paperwork belongs to a different load. Both stop a
 *            packet, because both end in an invoice that will not be paid.
 *   warning  a real difference somebody should see that does not stop an
 *            invoice: a weight outside scale tolerance, the wrong trailer type.
 *   info     one side has a value and the other does not. Not a conflict —
 *            usually the load record is thin and the document is filling it in.
 *
 * The threshold that turns severity into a verdict lives in
 * `summarizeValidation`, not here. This file decides what is true; that one
 * decides what to do about it.
 */

import { type DocumentKind } from './documents.ts';
import type { ExtractedField } from './extract.ts';
import type { ValidationFinding } from './documents.ts';

/** What a load says about itself, as far as any document can contradict it. */
export interface LoadFacts {
  /** Integer minor units. Null when the carrier has not recorded one. */
  rateAmount: number | null;
  rateCurrency: string | null;
  /** True when `rateAmount` is linehaul only rather than all-in. */
  rateIsLinehaul: boolean;
  brokerLoadNumber: string | null;
  weightLbs: number | null;
  equipment: string | null;
}

/**
 * Scale tolerance.
 *
 * A rate confirmation carries the shipper's estimate and a scale ticket carries
 * what the truck actually weighed; 42,000 against 42,380 is two honest numbers,
 * not a discrepancy. Two percent is the band inside which nobody in freight
 * would call it a disagreement — and outside it, a warning rather than an error,
 * because an overweight load is a conversation and not an unpayable invoice.
 */
const WEIGHT_TOLERANCE = 0.02;

export function formatMoney(minorUnits: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    minorUnits / 100,
  );
}

const formatCount = (n: number) => n.toLocaleString('en-US');

/**
 * Read one extracted field back out of the jsonb blob.
 *
 * The column is `unknown` by the time it returns from the database, and a
 * document extracted by an older version may not have the shape this code
 * expects. Anything that does not look like an `ExtractedField` is treated as
 * absent rather than coerced.
 */
function field(
  extracted: Record<string, unknown> | null,
  name: string,
): ExtractedField | null {
  const value = extracted?.[name];
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ExtractedField>;
  if (candidate.value === undefined || typeof candidate.raw !== 'string') return null;
  return candidate as ExtractedField;
}

/** Equipment is written a dozen ways. Compare on the shape of the word. */
function normalizeEquipment(raw: string): string {
  const lower = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (/^(dryvan|van|dv)$/.test(lower)) return 'DRY_VAN';
  if (/^(reefer|refrigerated|reef|r)$/.test(lower)) return 'REEFER';
  if (/^(flatbed|flat|fb)$/.test(lower)) return 'FLATBED';
  if (/^(straightbox|boxtruck|straighttruck|box)$/.test(lower)) return 'STRAIGHT_BOX';
  if (/^(poweronly|power)$/.test(lower)) return 'POWER_ONLY';
  return raw.toUpperCase().replace(/[^A-Z]+/g, '_');
}

/** A reference number, ignoring the punctuation different systems add. */
const normalizeRef = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Everything after the last `@`, lower-cased. Null for anything that isn't plainly an address. */
function emailDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at === -1 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase().trim();
}

interface Comparison {
  field: string;
  documentValue: string | null;
  loadValue: string | null;
  agrees: boolean;
  severity: ValidationFinding['severity'];
  note?: string;
}

/**
 * One side has it, the other does not.
 *
 * Recorded as a non-agreement at `info` rather than quietly dropped. A carrier
 * whose load record has no rate should see that the rate confirmation carries
 * one — that is the document filling in the load, which is useful — but it is
 * not a conflict and must never block a packet.
 */
function oneSided(
  name: string,
  documentValue: string | null,
  loadValue: string | null,
): Comparison {
  return {
    field: name,
    documentValue,
    loadValue,
    agrees: false,
    severity: 'info',
    note: loadValue === null
      ? 'The load has nothing recorded for this.'
      : 'The document does not mention this.',
  };
}

/**
 * Compare a document to its load.
 *
 * Returns an empty array when there is nothing comparable — an unread document,
 * or a kind with no fields that touch a load. An empty array validates, which is
 * correct: a signed POD with nothing to contradict is a POD that agrees.
 */
export function validateAgainstLoad(args: {
  kind: DocumentKind;
  extracted: Record<string, unknown> | null;
  load: LoadFacts;
  /** This document's sender address, for the senderDomain check below. Null for anything not email-sourced. */
  receivedFrom?: string | null;
  /** Addresses documents for this broker have arrived from before. Null or empty means no baseline yet. */
  priorSenders?: readonly string[] | null;
}): ValidationFinding[] {
  const { extracted, load, receivedFrom, priorSenders } = args;

  /**
   * Null is "never read", `{}` is "read and found nothing".
   *
   * The difference matters. For a document that has been read, "the load has a
   * rate the document does not mention" is a true and useful observation. For
   * one nobody has read, it is a claim about a page nothing has looked at.
   */
  if (extracted === null) return [];

  const out: Comparison[] = [];

  // --- money ---------------------------------------------------------------
  //
  // Which document figure to compare depends on what the load's rate means. A
  // load recorded as linehaul-only must be checked against the document's
  // linehaul, not its all-in total, or every load with a fuel surcharge reads
  // as a disagreement.
  const currency = load.rateCurrency ?? 'USD';
  const allIn = field(extracted, 'rateAmount') ?? field(extracted, 'invoiceAmount');
  const linehaul = field(extracted, 'linehaulAmount');
  const documentRate = load.rateIsLinehaul ? (linehaul ?? allIn) : allIn;

  if (documentRate && typeof documentRate.value === 'number') {
    if (load.rateAmount === null) {
      out.push(oneSided('rate', documentRate.raw, null));
    } else {
      const agrees = documentRate.value === load.rateAmount;
      out.push({
        field: 'rate',
        documentValue: documentRate.raw,
        loadValue: formatMoney(load.rateAmount, currency),
        agrees,
        severity: 'error',
        ...(agrees
          ? {}
          : {
              note: load.rateIsLinehaul
                ? 'The load rate is linehaul only, and this is the linehaul figure from the document.'
                : 'This is the figure an invoice will be built from.',
            }),
      });
    }
  } else if (load.rateAmount !== null) {
    out.push(oneSided('rate', null, formatMoney(load.rateAmount, currency)));
  }

  // --- identity ------------------------------------------------------------
  //
  // A broker load number that does not match is the strongest signal available
  // that this paperwork belongs to a different load. Error, not warning: acting
  // on it means detaching the document, and shipping an invoice built from
  // another load's rate confirmation is the failure this whole phase prevents.
  const documentRef = field(extracted, 'brokerLoadNumber');
  if (documentRef && typeof documentRef.value === 'string') {
    if (load.brokerLoadNumber === null) {
      out.push(oneSided('brokerLoadNumber', documentRef.raw, null));
    } else {
      const agrees =
        normalizeRef(String(documentRef.value)) === normalizeRef(load.brokerLoadNumber);
      out.push({
        field: 'brokerLoadNumber',
        documentValue: documentRef.raw,
        loadValue: load.brokerLoadNumber,
        agrees,
        severity: 'error',
        ...(agrees ? {} : { note: 'This document may belong to a different load.' }),
      });
    }
  }

  // --- weight --------------------------------------------------------------
  const documentWeight = field(extracted, 'weightLbs');
  if (documentWeight && typeof documentWeight.value === 'number') {
    if (load.weightLbs === null) {
      out.push(oneSided('weightLbs', documentWeight.raw, null));
    } else {
      const difference = Math.abs(documentWeight.value - load.weightLbs);
      const agrees = difference <= load.weightLbs * WEIGHT_TOLERANCE;
      out.push({
        field: 'weightLbs',
        documentValue: formatCount(documentWeight.value),
        loadValue: formatCount(load.weightLbs),
        agrees,
        severity: 'warning',
        ...(agrees
          ? {}
          : {
              note: `${formatCount(difference)} lb apart, outside the ${
                WEIGHT_TOLERANCE * 100
              }% scale tolerance.`,
            }),
      });
    }
  }

  // --- equipment -----------------------------------------------------------
  const documentEquipment = field(extracted, 'equipment');
  if (documentEquipment && typeof documentEquipment.value === 'string' && load.equipment) {
    const agrees =
      normalizeEquipment(String(documentEquipment.value)) ===
      normalizeEquipment(load.equipment);
    out.push({
      field: 'equipment',
      documentValue: documentEquipment.raw,
      loadValue: load.equipment,
      agrees,
      severity: 'warning',
      ...(agrees ? {} : { note: 'The trailer type on the document is not the one dispatched.' }),
    });
  }

  // --- sender domain ---------------------------------------------------------
  //
  // Not a load field — broker-identity provenance. A known trucking fraud
  // pattern is someone impersonating a broker with a lookalike domain to
  // redirect a rate confirmation's payment. `severity` stays `warning`,
  // never `error`: too many benign explanations exist (a broker switching
  // TMS providers, forwarding through a personal address) for this alone to
  // ever reject a document — it is a signal, not proof.
  if (receivedFrom && priorSenders && priorSenders.length > 0) {
    const currentDomain = emailDomain(receivedFrom);
    const known = [
      ...new Set(priorSenders.map(emailDomain).filter((d): d is string => d !== null)),
    ];
    if (currentDomain && known.length > 0) {
      const agrees = known.includes(currentDomain);
      out.push({
        field: 'senderDomain',
        documentValue: currentDomain,
        loadValue: known.join(' or '),
        agrees,
        severity: 'warning',
        ...(agrees
          ? {}
          : {
              note: `Prior paperwork for this broker arrived from ${known.join(' or ')}; this arrived from ${currentDomain}.`,
            }),
      });
    }
  }

  return out.map(
    (c): ValidationFinding => ({
      field: c.field,
      documentValue: c.documentValue,
      loadValue: c.loadValue,
      agrees: c.agrees,
      severity: c.severity,
      ...(c.note ? { note: c.note } : {}),
    }),
  );
}
