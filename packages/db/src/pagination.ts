/**
 * Cursor pagination — the shared, boring half.
 *
 * Every list in this app that can grow without bound (loads, trucks,
 * drivers, members, documents, imports, invoices, factoring companies and
 * packets) used to either cap at a bare `.limit()` with no way to reach the
 * rows past it, or have no limit at all — a genuinely unbounded `SELECT`.
 * `readTimeline` (`events/record.ts`) already proved the right shape for
 * this codebase: an opaque cursor encoding the last row's sort key and id,
 * a `WHERE (sortKey, id) < (cursor.v, cursor.id)` tuple comparison for the
 * next page, and a `nextCursor` computed from whatever the last row of
 * *this* page actually was — never a guess, never hardcoded `null`.
 *
 * Only the cursor's encode/decode and its error type live here. Each
 * repository's own `WHERE`/`orderBy` stays hand-written, plain Drizzle,
 * matching every other query in this package — a fully generic
 * query-builder wrapper would fight Drizzle's per-table column typing for
 * a saving that is mostly boilerplate anyway, and this codebase's own
 * stated preference is three similar lines over a premature abstraction.
 *
 * `nextCursor` is decided by whether a page came back full
 * (`rows.length === limit`), not a second `COUNT` query — the same
 * "assume more until proven otherwise" trick `readTimeline` already uses.
 */

export class CursorError extends Error {
  readonly code = 'invalid_cursor';
  readonly explanation = 'That page reference is not valid — start again from the first page.';
  constructor() {
    super('cursor failed to decode');
    this.name = 'CursorError';
  }
}

export interface DecodedCursor {
  v: string | number;
  id: string;
}

export function encodeCursor(v: string | number, id: string): string {
  return Buffer.from(JSON.stringify({ v, id })).toString('base64url');
}

export function decodeCursor(cursor: string): DecodedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError();
  }
  const obj = parsed as Partial<DecodedCursor> | null;
  if (
    obj === null ||
    typeof obj !== 'object' ||
    typeof obj.id !== 'string' ||
    (typeof obj.v !== 'string' && typeof obj.v !== 'number')
  ) {
    throw new CursorError();
  }
  return { v: obj.v, id: obj.id };
}

/** A page of rows plus the cursor for the next one, or `null` at the end. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Turn a fetched page into `{ items, nextCursor }`. `keyOf` reads the sort
 * key and id off the last row — callers pass their own accessor since the
 * sort column differs per table (`createdAt` for the newest-first lists,
 * `label`/`fullName`/`email`/`name` for the alphabetical ones).
 */
export function toCursorPage<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => { v: string | number; id: string },
): CursorPage<T> {
  if (rows.length < limit) return { items: rows, nextCursor: null };
  const last = rows[rows.length - 1];
  if (!last) return { items: rows, nextCursor: null };
  const key = keyOf(last);
  return { items: rows, nextCursor: encodeCursor(key.v, key.id) };
}
