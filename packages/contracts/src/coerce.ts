/**
 * Turning a carrier's cell values into typed data.
 *
 * Every function here returns `{ value, issue }` rather than throwing or
 * returning null. The distinction that matters is between *absent* and
 * *unparseable*: an empty rate cell is a load whose rate was never recorded,
 * which is fine and common in historical data. A rate cell containing "see
 * email" is a value nobody can interpret, and it deserves a message naming the
 * cell rather than a silent zero.
 *
 * Silent zeros are the specific failure this file exists to prevent. A rate of
 * 0 imported from an unparseable cell does not look wrong in a list of ninety
 * loads, and it drags the carrier's measured revenue per mile down for as long
 * as nobody investigates.
 */

export interface Coerced<T> {
  value?: T;
  issue?: string;
}

const blank = (s: string | undefined): boolean =>
  s === undefined || s.trim() === '' || /^(n\/?a|none|null|-|--)$/i.test(s.trim());

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Parse money into integer cents.
 *
 * Handles the forms that actually turn up: `$1,800.00`, `1800`, `1,800.00 USD`,
 * `(250.00)` for a negative — accounting parenthesis notation, which Excel
 * produces and which a naive parser reads as a positive 250.
 */
export function coerceMoneyCents(raw: string | undefined): Coerced<number> {
  if (blank(raw)) return {};

  const text = raw!.trim();
  const negative = /^\(.*\)$/.test(text) || text.startsWith('-');

  const cleaned = text
    .replace(/^\(|\)$/g, '')
    .replace(/[$£€]/g, '')
    .replace(/\b(usd|cad|dollars?)\b/gi, '')
    .replace(/,/g, '')
    .replace(/-/g, '')
    .trim();

  if (cleaned === '' || !/^\d+(\.\d+)?$/.test(cleaned)) {
    return { issue: `"${text}" is not an amount HaulQ can read.` };
  }

  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) {
    return { issue: `"${text}" is not an amount HaulQ can read.` };
  }

  // Rounded at the boundary, once. Everything downstream is integer cents, so
  // this is the only place a fractional cent can exist.
  const cents = Math.round(amount * 100);
  return { value: negative ? -cents : cents };
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function coerceInteger(
  raw: string | undefined,
  opts: { label: string; min?: number; max?: number } = { label: 'value' },
): Coerced<number> {
  if (blank(raw)) return {};

  const cleaned = raw!.trim().replace(/,/g, '').replace(/\s*(mi|miles|lbs?|pounds?|ft|feet)\.?$/i, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { issue: `"${raw!.trim()}" is not a number.` };
  }

  const n = Math.round(Number(cleaned));
  if (opts.min !== undefined && n < opts.min) {
    return { issue: `${opts.label} cannot be below ${opts.min} (got ${n}).` };
  }
  if (opts.max !== undefined && n > opts.max) {
    return { issue: `${opts.label} of ${n} is beyond what HaulQ will accept.` };
  }
  return { value: n };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a date into an ISO string.
 *
 * Deliberately **not** `new Date(string)`. That constructor accepts almost
 * anything and guesses: it reads "3/4/2026" as March 4th, parses bare
 * "13/04/2026" as Invalid, and turns "totals" into Invalid Date without
 * complaint if the caller does not check. Guessing wrong on a load's delivery
 * date shifts a carrier's whole margin-by-month analysis by a month.
 *
 * US order (M/D/Y) is assumed for ambiguous slash dates because these are US
 * carriers' exports. Where the day is unambiguous (>12), the other order is
 * accepted and used — a file exported with European settings should not
 * silently produce nonsense.
 */
export function coerceDate(raw: string | undefined): Coerced<string> {
  if (blank(raw)) return {};
  const text = raw!.trim();

  // ISO, the easy case.
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (iso) {
    return build(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), text);
  }

  // Excel serial number. A column of five-digit integers where a date belongs
  // is almost always a sheet exported without formatting.
  if (/^\d{5}$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 60000) {
      // Excel's epoch is 1899-12-30 — 1900 is treated as a leap year, which it
      // was not, and the offset absorbs that.
      const ms = (serial - 25569) * 86_400_000;
      return { value: new Date(ms).toISOString() };
    }
  }

  // 3/4/2026, 03-04-26, 3.4.2026
  const slash = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (slash) {
    let [a, b] = [Number(slash[1]), Number(slash[2])];
    const year = normalizeYear(Number(slash[3]));

    // Unambiguous day-first, e.g. 25/03/2026.
    if (a > 12 && b <= 12) [a, b] = [b, a];
    return build(year, a - 1, b, text);
  }

  // May 1, 2026 / 1 May 2026 / May 1 2026
  const named = text.match(/^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/i);
  if (named) {
    const month = MONTHS[named[1]!.slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      return build(normalizeYear(Number(named[3])), month, Number(named[2]), text);
    }
  }

  const dayFirst = text.match(/^(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{2,4})$/i);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2]!.slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      return build(normalizeYear(Number(dayFirst[3])), month, Number(dayFirst[1]), text);
    }
  }

  return { issue: `"${text}" is not a date HaulQ can read.` };
}

function normalizeYear(y: number): number {
  if (y >= 1000) return y;
  // A two-digit year in freight records is this century. "26" is 2026, and a
  // load from 1926 is not a case worth supporting.
  return 2000 + y;
}

function build(year: number, month: number, day: number, original: string): Coerced<string> {
  const d = new Date(Date.UTC(year, month, day));
  // Round-trip check catches 2026-02-31, which Date silently rolls to March 3.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month ||
    d.getUTCDate() !== day
  ) {
    return { issue: `"${original}" is not a real date.` };
  }
  return { value: d.toISOString() };
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC',
};

const CODES = new Set(Object.values(STATES));

export function coerceState(raw: string | undefined): Coerced<string> {
  if (blank(raw)) return {};
  const text = raw!.trim();

  const upper = text.toUpperCase();
  if (upper.length === 2 && CODES.has(upper)) return { value: upper };

  const full = STATES[text.toLowerCase()];
  if (full) return { value: full };

  return { issue: `"${text}" is not a US state.` };
}

export interface Place {
  city?: string;
  state?: string;
}

/**
 * Parse a place from one cell or two.
 *
 * Carriers' exports do both, often in the same file — a "Pickup" column holding
 * "Wichita, KS" and separate "Delivery City" / "Delivery State" columns. This
 * takes whatever is available and works it out.
 */
export function coercePlace(
  combined: string | undefined,
  city?: string | undefined,
  state?: string | undefined,
): Coerced<Place> {
  if (!blank(city) || !blank(state)) {
    const st = coerceState(state);
    if (st.issue) return { issue: st.issue };
    return {
      value: {
        ...(blank(city) ? {} : { city: city!.trim() }),
        ...(st.value ? { state: st.value } : {}),
      },
    };
  }

  if (blank(combined)) return {};
  const text = combined!.trim();

  // "Wichita, KS" or "Wichita KS" or "Wichita, Kansas 67202"
  const withComma = text.match(/^(.+?),\s*([A-Za-z .]{2,20})(?:\s+\d{5}(?:-\d{4})?)?$/);
  if (withComma) {
    const st = coerceState(withComma[2]);
    if (st.value) return { value: { city: withComma[1]!.trim(), state: st.value } };
  }

  const trailing = text.match(/^(.+?)\s+([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
  if (trailing) {
    const st = coerceState(trailing[2]);
    if (st.value) return { value: { city: trailing[1]!.trim(), state: st.value } };
  }

  // A city with no state is still worth keeping. Geocoding it is Phase 3's
  // problem; discarding it here would lose the only location on the load.
  return { value: { city: text } };
}
