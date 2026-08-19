/**
 * Reading fields off a document, without asking a model.
 *
 * Same argument as `classify.ts` and the same section of the build plan: the
 * cheapest extraction is the one that never reaches a model. A broker's rate
 * confirmation is generated from a template, so the rate sits after a label that
 * says RATE, and finding it is reading, not inference.
 *
 * What this deliberately does not do is guess. Every field it returns came from
 * a labelled value it could point at; anything it could not find is simply
 * absent, and absence is what tells the pipeline a model pass is worth paying
 * for. A deterministic extractor that fills gaps with its best idea is worse
 * than no extractor, because the number it invents flows into validation and
 * gets compared against the load as if a human had typed it.
 *
 * ---------------------------------------------------------------------------
 * Money is never a float
 * ---------------------------------------------------------------------------
 *
 * Build plan section 5. `$2,400.00` becomes the integer 240000 here and stays an
 * integer through validation and into Pay. The `raw` string is kept beside it so
 * the disagreement view can show a carrier what was actually printed rather than
 * a re-rendering of what we parsed.
 */

import { type DocumentKind } from './documents.ts';

export interface ExtractedField {
  /** Integer minor units for money, an integer for counts, otherwise a string. */
  value: string | number;
  /** Exactly as printed. What a carrier is shown when a field disagrees. */
  raw: string;
  /** The label this was found under, so a wrong match is diagnosable. */
  label: string;
}

export interface Extraction {
  fields: Record<string, ExtractedField>;
  /** Recorded on the document so a cohort can be re-run when this changes. */
  version: string;
  /** Fields this kind expects but that were not found. Drives the model pass. */
  missing: string[];
}

export const DETERMINISTIC_VERSION = 'deterministic-v1';

/**
 * `$2,400.00` → 240000. Null for anything that is not plainly an amount.
 *
 * Three or more decimal places is rejected rather than rounded: at that point
 * the match is not a price, it is a rate per mile, a tax factor or a mis-split
 * line, and inventing cents from it is exactly the guessing this file refuses.
 */
export function parseMoney(raw: string): number | null {
  const cleaned = raw.replace(/[$\s,]/g, '');
  const match = cleaned.match(/^-?(\d+)(?:\.(\d+))?$/);
  if (!match) return null;

  const [, whole, decimals] = match;
  if (decimals && decimals.length > 2) return null;

  const cents = decimals ? decimals.padEnd(2, '0') : '00';
  const value = Number(whole) * 100 + Number(cents);
  return raw.trimStart().startsWith('-') ? -value : value;
}

/** `42,000` → 42000. Null when it is not a plain whole number. */
export function parseCount(raw: string): number | null {
  const cleaned = raw.replace(/[\s,]/g, '');
  return /^\d+$/.test(cleaned) ? Number(cleaned) : null;
}

/**
 * One field's worth of rules.
 *
 * `labels` are ordered most specific first, and the first one that matches wins.
 * That ordering is the whole design: "Line Haul" and "Total Rate" are both money
 * on a rate confirmation, and which one HaulQ compares against the load's rate
 * depends on which label it found, not on which number came first on the page.
 */
interface FieldRule {
  field: string;
  labels: RegExp[];
  /** How the captured text becomes a value. */
  parse: (raw: string) => string | number | null;
  /** Expected on this kind. Absence of an expected field is worth a model call. */
  expected?: boolean;
  /**
   * Lines this field must never be read from.
   *
   * "Per Mile Rate: $1.85" matches a bare `rate` label and is off by a factor of
   * about a thousand. A rule that finds the wrong number confidently is worse
   * than one that finds nothing, so the exclusion is part of the rule rather
   * than a cleanup pass afterwards.
   */
  excludeLine?: RegExp;
}

const MONEY_VALUE = String.raw`\$?\s*-?[\d,]+(?:\.\d{1,2})?`;
const NUMBER_VALUE = String.raw`[\d,]+`;
const REF_VALUE = String.raw`[A-Za-z0-9][A-Za-z0-9\-\/]*`;

/**
 * A label followed by its value, on the same line.
 *
 * Same-line is not a simplification, it is the fix for a whole class of wrong
 * answers. `\s` matches a newline, so an unanchored pattern reads INVOICE from a
 * document's title and then captures the first word of the line below it as the
 * invoice number. Freight templates put a label and its value together; matching
 * happens line by line and nothing bleeds across.
 */
function labelled(label: string, value: string): RegExp {
  return new RegExp(`${label}[ \\t]*[:#]?[ \\t]*(${value})`, 'i');
}

/** Captures that are plainly part of a label rather than a value. */
const NOT_A_VALUE = /^(?:number|no|num|of|the|is|total|due|amount)$/i;

const RATE_CONFIRMATION: FieldRule[] = [
  {
    field: 'rateAmount',
    labels: [
      labelled(String.raw`total\s+(?:carrier\s+)?(?:rate|pay|charges?)`, MONEY_VALUE),
      labelled(String.raw`agreed\s+rate`, MONEY_VALUE),
      labelled(String.raw`carrier\s+pay`, MONEY_VALUE),
      labelled(String.raw`rate`, MONEY_VALUE),
    ],
    parse: parseMoney,
    expected: true,
    excludeLine: /per\s*mile|\bper\s*mi\b|\/\s*mi\b|\brpm\b/i,
  },
  {
    field: 'linehaulAmount',
    labels: [labelled(String.raw`line\s*haul`, MONEY_VALUE)],
    parse: parseMoney,
  },
  {
    field: 'brokerLoadNumber',
    labels: [
      labelled(String.raw`(?:broker\s+)?load\s*(?:number|no|#)?`, REF_VALUE),
      labelled(String.raw`order\s*(?:number|no|#)?`, REF_VALUE),
      labelled(String.raw`pro\s*(?:number|no|#)?`, REF_VALUE),
    ],
    parse: (raw) => raw.trim(),
    expected: true,
  },
  {
    field: 'weightLbs',
    labels: [labelled(String.raw`weight`, NUMBER_VALUE)],
    parse: parseCount,
  },
  {
    field: 'equipment',
    labels: [labelled(String.raw`(?:equipment|trailer\s+type)`, String.raw`[A-Za-z0-9 '"-]{3,20}`)],
    parse: (raw) => raw.trim(),
  },
];

const INVOICE: FieldRule[] = [
  {
    field: 'invoiceAmount',
    labels: [
      labelled(String.raw`(?:total\s+)?amount\s+due`, MONEY_VALUE),
      labelled(String.raw`invoice\s+total`, MONEY_VALUE),
      labelled(String.raw`balance\s+due`, MONEY_VALUE),
    ],
    parse: parseMoney,
    expected: true,
  },
  {
    field: 'invoiceNumber',
    labels: [labelled(String.raw`invoice\s*(?:number|no|#)?`, REF_VALUE)],
    parse: (raw) => raw.trim(),
    expected: true,
  },
];

const BOL: FieldRule[] = [
  {
    field: 'bolNumber',
    labels: [
      labelled(String.raw`b\/l\s*(?:number|no|#)?`, REF_VALUE),
      labelled(String.raw`bill\s+of\s+lading\s*(?:number|no|#)?`, REF_VALUE),
    ],
    parse: (raw) => raw.trim(),
    expected: true,
  },
  {
    field: 'weightLbs',
    labels: [labelled(String.raw`(?:total\s+)?weight`, NUMBER_VALUE)],
    parse: parseCount,
  },
  {
    field: 'pieceCount',
    labels: [labelled(String.raw`(?:pieces|piece\s+count|cartons|pallets)`, NUMBER_VALUE)],
    parse: parseCount,
  },
];

const WEIGHT_TICKET: FieldRule[] = [
  {
    field: 'weightLbs',
    labels: [
      labelled(String.raw`(?:certified\s+|net\s+|gross\s+)?weight`, NUMBER_VALUE),
      labelled(String.raw`gross`, NUMBER_VALUE),
    ],
    parse: parseCount,
    expected: true,
  },
];

const LUMPER: FieldRule[] = [
  {
    field: 'lumperAmount',
    labels: [
      labelled(String.raw`lumper\s*(?:fee|charge|paid)?`, MONEY_VALUE),
      labelled(String.raw`amount\s+paid`, MONEY_VALUE),
    ],
    parse: parseMoney,
    expected: true,
  },
];

const RULES: Partial<Record<DocumentKind, FieldRule[]>> = {
  rate_confirmation: RATE_CONFIRMATION,
  invoice: INVOICE,
  bol: BOL,
  scale_ticket: WEIGHT_TICKET,
  weight_ticket: WEIGHT_TICKET,
  lumper_receipt: LUMPER,
};

/**
 * Read what can be read.
 *
 * `missing` lists the expected fields that were not found. An empty `missing` on
 * a rate confirmation means no model call is needed for this page at all, which
 * is the outcome the whole file exists to produce.
 */
export function extractDeterministically(input: {
  text: string;
  kind: DocumentKind;
}): Extraction {
  const rules = RULES[input.kind] ?? [];
  const fields: Record<string, ExtractedField> = {};
  const missing: string[] = [];

  const lines = input.text.split(/\r?\n/);

  for (const rule of rules) {
    let found: ExtractedField | null = null;

    // Each label gets a whole pass over the document before the next is tried,
    // so "Total Rate" anywhere on the page beats a bare "Rate" on line two.
    outer: for (const label of rule.labels) {
      for (const line of lines) {
        if (rule.excludeLine?.test(line)) continue;

        const match = line.match(label);
        const captured = match?.[1];
        if (!captured || NOT_A_VALUE.test(captured.trim())) continue;

        const value = rule.parse(captured);
        if (value === null || value === '') continue;

        found = {
          value,
          raw: captured.trim(),
          // The label as printed, not the pattern — a wrong match is diagnosed
          // by seeing which words it keyed on.
          label:
            match[0]!.slice(0, match[0]!.length - captured.length).trim() || rule.field,
        };
        break outer;
      }
    }

    if (found) fields[rule.field] = found;
    else if (rule.expected) missing.push(rule.field);
  }

  return { fields, version: DETERMINISTIC_VERSION, missing };
}
