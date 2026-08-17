/**
 * Operating facts — what it costs this carrier to run a truck for a mile.
 *
 * These six numbers are the most consequential thing a carrier enters into
 * HaulQ. Every margin prediction, every score, and the entire premise of
 * "profit-horizon optimization" (build plan section 8) is arithmetic on top of
 * them. Phase 0's exit gate is a carrier reconciling them against 30–90 days of
 * their own imported loads, and section 13 is blunt that without that the
 * scoring weights cannot be tuned at all.
 *
 * ---------------------------------------------------------------------------
 * Why validation lives in contracts rather than the API
 * ---------------------------------------------------------------------------
 *
 * The warnings need to appear as the carrier types, before anything is saved.
 * A round-trip per keystroke is not the answer, and re-implementing the bounds
 * in the web app guarantees the two drift. So the rules are here, in the shared
 * package, and both sides run the same function.
 *
 * ---------------------------------------------------------------------------
 * Errors versus warnings
 * ---------------------------------------------------------------------------
 *
 * Lifted from the dispatcher's `validateCriteria`, whose framing is right:
 * bounds are deliberately wide, and the job is catching typos and impossible
 * values rather than second-guessing an owner who knows his own market.
 *
 * An **error** blocks saving. Reserved for values that are arithmetically
 * impossible or certainly a typo.
 *
 * A **warning** does not block. It says "this is unusual, and here is why we
 * think so." An owner running a niche operation may be right and the warning
 * wrong; refusing his number would make the product useless to him.
 */

import { z } from 'zod';

/**
 * All money in cents, all rates per mile unless named otherwise.
 *
 * Every field is optional because a carrier fills this in over time — often
 * across two sittings, and often after the import lands and gives them real
 * numbers to check against. A schema that demanded all six up front would make
 * the first save impossible.
 */
export const OperatingFactsSchema = z.object({
  /**
   * All-in operating cost per mile, excluding driver pay: fuel, maintenance,
   * tyres, tolls. The single most important number here.
   */
  costPerMileCents: z.number().int().nonnegative().optional(),

  /**
   * Costs that accrue whether or not the truck moves: payment, insurance,
   * permits, parking, phone. Per week.
   *
   * The number owner-operators most often omit, and omitting it is what makes a
   * load look profitable when the week was not.
   */
  fixedWeeklyCostCents: z.number().int().nonnegative().optional(),

  /** Diesel, cents per gallon. Used with `avgMpg` to sanity-check the above. */
  fuelPricePerGallonCents: z.number().int().nonnegative().optional(),

  /** Loaded average. A 26 ft straight box is typically 8–10. */
  avgMpg: z.number().positive().optional(),

  /**
   * What the driver is paid per mile. Zero for an owner-operator who drives
   * himself — his pay is the margin, and double-counting it makes every load
   * look unprofitable.
   */
  driverPayPerMileCents: z.number().int().nonnegative().optional(),

  /** Target margin as a percentage of revenue. */
  targetMarginPercent: z.number().min(0).max(99).optional(),
});

export type OperatingFacts = z.infer<typeof OperatingFactsSchema>;

export type FactField = keyof OperatingFacts | 'general';

export interface FactIssue {
  field: FactField;
  /** `error` blocks saving; `warning` does not. */
  severity: 'error' | 'warning';
  message: string;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Check operating facts.
 *
 * Returns every issue found rather than stopping at the first, because a
 * carrier filling in six fields should see all six problems at once instead of
 * discovering them one save at a time.
 */
export function validateOperatingFacts(f: OperatingFacts): FactIssue[] {
  const issues: FactIssue[] = [];
  const has = (v: number | undefined): v is number =>
    typeof v === 'number' && Number.isFinite(v);

  // --- cost per mile -------------------------------------------------------

  if (has(f.costPerMileCents)) {
    if (f.costPerMileCents === 0) {
      issues.push({
        field: 'costPerMileCents',
        severity: 'error',
        message: 'Cost per mile cannot be zero — every load would look pure profit.',
      });
    } else if (f.costPerMileCents > 1000) {
      issues.push({
        field: 'costPerMileCents',
        severity: 'error',
        message: `${dollars(f.costPerMileCents)}/mi is beyond any real operating cost. Check for a typo.`,
      });
    } else if (f.costPerMileCents < 60) {
      issues.push({
        field: 'costPerMileCents',
        severity: 'warning',
        message:
          'Under $0.60/mi is below fuel and maintenance for most straight trucks. Margins will look better than they are.',
      });
    } else if (f.costPerMileCents > 300) {
      issues.push({
        field: 'costPerMileCents',
        severity: 'warning',
        message: 'Over $3.00/mi is high for a straight truck. Worth double-checking.',
      });
    }
  }

  // --- fixed weekly cost ---------------------------------------------------

  if (has(f.fixedWeeklyCostCents)) {
    if (f.fixedWeeklyCostCents === 0) {
      issues.push({
        field: 'fixedWeeklyCostCents',
        severity: 'warning',
        message:
          'Zero fixed cost means no truck payment, insurance or permits. If those exist, a profitable-looking load can still lose the week.',
      });
    } else if (f.fixedWeeklyCostCents > 1_000_000) {
      issues.push({
        field: 'fixedWeeklyCostCents',
        severity: 'error',
        message: `${dollars(f.fixedWeeklyCostCents)} a week per truck is beyond plausible. Check for a typo.`,
      });
    }
  }

  // --- fuel ----------------------------------------------------------------

  if (has(f.fuelPricePerGallonCents)) {
    if (f.fuelPricePerGallonCents === 0) {
      issues.push({
        field: 'fuelPricePerGallonCents',
        severity: 'error',
        message: 'Fuel price cannot be zero.',
      });
    } else if (f.fuelPricePerGallonCents > 1500) {
      issues.push({
        field: 'fuelPricePerGallonCents',
        severity: 'error',
        message: `${dollars(f.fuelPricePerGallonCents)} a gallon is beyond any real price. Check for a typo.`,
      });
    } else if (f.fuelPricePerGallonCents < 200 || f.fuelPricePerGallonCents > 700) {
      issues.push({
        field: 'fuelPricePerGallonCents',
        severity: 'warning',
        message: `${dollars(f.fuelPricePerGallonCents)} a gallon is outside the usual range. Fine if that is what you pay.`,
      });
    }
  }

  if (has(f.avgMpg)) {
    if (f.avgMpg > 20) {
      issues.push({
        field: 'avgMpg',
        severity: 'error',
        message: `${f.avgMpg} mpg is beyond what a commercial truck achieves. Check for a typo.`,
      });
    } else if (f.avgMpg < 4 || f.avgMpg > 14) {
      issues.push({
        field: 'avgMpg',
        severity: 'warning',
        message: `${f.avgMpg} mpg is outside the usual 6–12 for a straight truck.`,
      });
    }
  }

  // --- cross-field ---------------------------------------------------------
  //
  // The check that catches the mistake nobody notices on their own. If the
  // stated cost per mile is below what fuel alone costs, the number is wrong —
  // not unusual, wrong — and every margin prediction built on it will be
  // optimistic in a way that looks plausible for months.

  if (
    has(f.costPerMileCents) &&
    has(f.fuelPricePerGallonCents) &&
    has(f.avgMpg) &&
    f.avgMpg > 0
  ) {
    const fuelOnly = Math.round(f.fuelPricePerGallonCents / f.avgMpg);

    if (f.costPerMileCents < fuelOnly) {
      issues.push({
        field: 'costPerMileCents',
        severity: 'error',
        message:
          `At ${dollars(f.fuelPricePerGallonCents)}/gal and ${f.avgMpg} mpg, fuel alone is ` +
          `${dollars(fuelOnly)}/mi. A total cost of ${dollars(f.costPerMileCents)}/mi is less than that.`,
      });
    } else if (f.costPerMileCents < fuelOnly * 1.3) {
      issues.push({
        field: 'costPerMileCents',
        severity: 'warning',
        message:
          `Fuel alone is ${dollars(fuelOnly)}/mi, so this leaves under 30% for maintenance, ` +
          `tyres and tolls. Most carriers find that optimistic.`,
      });
    }
  }

  // --- target margin -------------------------------------------------------

  if (has(f.targetMarginPercent)) {
    if (f.targetMarginPercent < 5) {
      issues.push({
        field: 'targetMarginPercent',
        severity: 'warning',
        message: 'Under 5% leaves nothing for a bad week. Most carriers target 15–25%.',
      });
    } else if (f.targetMarginPercent > 50) {
      issues.push({
        field: 'targetMarginPercent',
        severity: 'warning',
        message: 'Over 50% will filter out almost every load on the board.',
      });
    }
  }

  return issues;
}

export function hasErrors(issues: FactIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

/**
 * The fields needed before scoring can produce a number worth trusting.
 *
 * Driver pay and target margin are deliberately excluded: zero is a legitimate
 * answer for an owner-operator who drives himself, and a missing target margin
 * falls back to a platform default without making the arithmetic wrong.
 */
export const REQUIRED_FOR_SCORING = [
  'costPerMileCents',
  'fixedWeeklyCostCents',
] as const satisfies ReadonlyArray<keyof OperatingFacts>;

export function isCompleteForScoring(f: OperatingFacts): boolean {
  return REQUIRED_FOR_SCORING.every((k) => typeof f[k] === 'number');
}

/** Which of the required fields are still missing, for the onboarding checklist. */
export function missingForScoring(f: OperatingFacts): string[] {
  return REQUIRED_FOR_SCORING.filter((k) => typeof f[k] !== 'number');
}
