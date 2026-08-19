/**
 * Documents: the kinds, and the validation verdict.
 *
 * This lives in contracts rather than in the database package because the
 * disagreement view is a web screen, and `apps/web` depends on `@haulq/contracts`
 * and deliberately not on `@haulq/db`. The API writes these findings, the web
 * renders them, and neither should be re-describing the shape in its own words.
 *
 * ---------------------------------------------------------------------------
 * Extraction is not validation
 * ---------------------------------------------------------------------------
 *
 * `documents.extracted` holds what a model read off the page. This file is about
 * the other half: whether what it read agrees with the load the carrier already
 * agreed to. The schema note on `documents` is right that collapsing the two
 * into one `processed` flag would delete the thing HaulQ Docs sells, and the
 * split has to survive out here too or it gets re-collapsed on the wire.
 */

import { z } from 'zod';

/**
 * Document kinds.
 *
 * Mirrors `documents_kind_ck` in `sql/post/0500_constraints.sql`. Kept as a
 * plain list rather than a pg enum because the tail of paperwork a small carrier
 * receives is long and adding one should not be a deploy — but the two lists do
 * have to agree, and `documents.test.ts` is not able to check that from here, so
 * the constraint is the authority and this is the copy.
 */
export const DOCUMENT_KINDS = [
  'rate_confirmation',
  'bol',
  'pod',
  'invoice',
  'lumper_receipt',
  'scale_ticket',
  'weight_ticket',
  'insurance_certificate',
  'w9',
  'carrier_packet',
  'detention_evidence',
  'other',
] as const;

export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKindSchema>;

/** How a kind is written in a sentence a carrier reads. */
export function documentKindLabel(kind: string): string {
  return kind.replace(/_/g, ' ');
}

/**
 * Severity of one disagreement.
 *
 * Three levels, because two is not enough and four is not distinguishable:
 *
 *  - `error`   — the document contradicts the load in a way that costs money or
 *                breaks the paperwork. Blocks the packet.
 *  - `warning` — a real difference that a human should see but that does not
 *                stop an invoice going out.
 *  - `info`    — recorded for the trail, never surfaced as a problem.
 *
 * Only `error` rejects a document. That threshold is the product's tolerance
 * setting and it lives here, once, rather than in whichever caller happens to
 * be looking at findings.
 */
export const VALIDATION_SEVERITIES = ['error', 'warning', 'info'] as const;
export const ValidationSeveritySchema = z.enum(VALIDATION_SEVERITIES);
export type ValidationSeverity = z.infer<typeof ValidationSeveritySchema>;

/**
 * One field, compared.
 *
 * `documentValue` and `loadValue` are strings already formatted for display, not
 * raw numbers. The comparison happens before this record is built; by the time a
 * finding exists the question "do these agree" has been answered, and re-deriving
 * it from two numbers in the UI is how a rounding rule ends up in a React
 * component.
 */
export const ValidationFindingSchema = z.object({
  /** Load field this is about, e.g. `rateAmount`, `pickupCity`, `weightLbs`. */
  field: z.string().min(1),
  /** What the document says. Null when the document does not mention it. */
  documentValue: z.string().nullable(),
  /** What the load record says. Null when the load has nothing recorded. */
  loadValue: z.string().nullable(),
  agrees: z.boolean(),
  severity: ValidationSeveritySchema,
  /** Optional sentence shown beside the row. */
  note: z.string().optional(),
});
export type ValidationFinding = z.infer<typeof ValidationFindingSchema>;

export const ValidationFindingsSchema = z.array(ValidationFindingSchema);

/** What a set of findings adds up to. */
export interface ValidationVerdict {
  /** `validated` unless at least one finding is a disagreement at `error`. */
  outcome: 'validated' | 'rejected';
  /** Disagreements, worst first. Empty when everything agrees. */
  disagreements: ValidationFinding[];
  /**
   * The sentence a carrier reads. Non-null exactly when `outcome` is
   * `rejected` — `documents_rejected_has_reason` requires one, and "validation
   * failed" is not an answer anybody can act on.
   */
  reason: string | null;
}

const RANK: Record<ValidationSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Decide what a set of findings means.
 *
 * Pure, so the threshold and the wording are testable without a database, a
 * model, or a PDF. `recordValidation` in the database package calls this rather
 * than reimplementing the rule, and so does anything that wants to preview a
 * verdict before writing one.
 */
export function summarizeValidation(
  findings: readonly ValidationFinding[],
): ValidationVerdict {
  const disagreements = findings
    .filter((f) => !f.agrees)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity]);

  const errors = disagreements.filter((f) => f.severity === 'error');
  if (errors.length === 0) {
    return { outcome: 'validated', disagreements, reason: null };
  }

  return {
    outcome: 'rejected',
    disagreements,
    reason: describeDisagreements(errors),
  };
}

/**
 * Turn errors into one sentence.
 *
 * Names the first two fields with both values, because "3 fields disagree" sends
 * the carrier back to the document to find out which. Beyond two it counts, so
 * the sentence stays a sentence.
 */
function describeDisagreements(errors: readonly ValidationFinding[]): string {
  const phrase = (f: ValidationFinding) =>
    `${f.field} is ${f.documentValue ?? 'missing'} on the document but ` +
    `${f.loadValue ?? 'missing'} on the load`;

  const [first, second, ...rest] = errors;
  if (!first) return 'The document does not match the load.';
  if (!second) return `${phrase(first)}.`;
  if (rest.length === 0) return `${phrase(first)}, and ${phrase(second)}.`;

  const more = rest.length === 1 ? '1 other field' : `${rest.length} other fields`;
  return `${phrase(first)}, ${phrase(second)}, and ${more} also disagree.`;
}
