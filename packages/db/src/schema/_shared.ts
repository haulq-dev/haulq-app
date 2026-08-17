/**
 * Conventions every table in HaulQ follows.
 *
 * Read this before adding a table. The three rules below are the ones that are
 * expensive to walk back later, and build plan section 13 names the load object
 * and the event log as the two things that cannot be retrofitted cheaply.
 *
 *  1. Every tenant-scoped table carries `org_id` as its FIRST column after the
 *     primary key, and every index on it leads with `org_id`. No exceptions.
 *     A query that forgets the tenant filter should be slow enough to notice.
 *
 *  2. Money is integer minor units plus an explicit currency. Never a float,
 *     never a bare `numeric` that some ORM will hand back as a JS number.
 *     `money()` below is the only sanctioned way to store an amount.
 *     Build plan section 5: "never floats near an invoice".
 *
 *  3. Soft delete via `deleted_at`, not `DELETE`. The event log references
 *     rows by id and an audit trail with dangling pointers is not an audit
 *     trail. Hard deletes happen only through the retention job, which writes
 *     a tombstone event first.
 */

import { sql } from 'drizzle-orm';
import { bigint, char, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Primary key. `gen_random_uuid()` ships with pgcrypto, enabled in 0000_init. */
export const pk = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

/**
 * The `org_id` column is declared inline in each table rather than by a helper.
 * A helper here would import `orgs`, and `tenancy.ts` imports this file, and
 * the resulting cycle is the kind that works until the day a bundler reorders
 * two modules. Four extra lines per table is the cheaper trade.
 */

/**
 * TypeScript names are camelCase, Postgres names are snake_case. Everywhere
 * else in this schema both are written out by hand; the money helpers derive
 * the second from the first, so they need this.
 */
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Money, rule 2.
 *
 * Stored as minor units (cents for USD) in a bigint, with the currency beside
 * it. This is the shape dinero.js takes and returns, so nothing has to round on
 * the way in or out. `bigint` rather than `integer` because a fleet's annual
 * settlement total will exceed 21 million dollars long before anyone remembers
 * this line exists.
 *
 * `...money('expectedCost')` yields the TS properties `expectedCostAmount` and
 * `expectedCostCurrency` over the columns `expected_cost_amount` and
 * `expected_cost_currency`.
 *
 * The generic and the cast exist so those property names survive into the
 * table's type. Without them the spread widens to an index signature, the
 * columns vanish from `typeof loads`, and every query that touches an amount
 * fails to compile for a reason that points at the call site rather than here.
 */
export function money<N extends string>(name: N) {
  const amount = bigint(`${snake(name)}_amount`, { mode: 'number' });
  const currency = char(`${snake(name)}_currency`, { length: 3 }).default('USD');
  return { [`${name}Amount`]: amount, [`${name}Currency`]: currency } as {
    [K in `${N}Amount`]: typeof amount;
  } & { [K in `${N}Currency`]: typeof currency };
}

/** Same as `money()` but required. */
export function moneyNotNull<N extends string>(name: N) {
  const amount = bigint(`${snake(name)}_amount`, { mode: 'number' }).notNull();
  const currency = char(`${snake(name)}_currency`, { length: 3 })
    .notNull()
    .default('USD');
  return { [`${name}Amount`]: amount, [`${name}Currency`]: currency } as {
    [K in `${N}Amount`]: typeof amount;
  } & { [K in `${N}Currency`]: typeof currency };
}

/** Timestamps every table gets. `deleted_at` is rule 3. */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};
