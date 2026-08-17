/**
 * The database client.
 *
 * Two things are exported and the difference matters:
 *
 *  - `db` is the raw connection. Migrations, background jobs and the tenant
 *    bootstrap use it. It can see every row in every org.
 *
 *  - `forOrg(orgId)` returns a handle that carries the tenant with it. Request
 *    handlers use this one, always.
 *
 * `forOrg` does not yet enforce isolation at the database level — that arrives
 * with Postgres row-level security in Phase 0b, once Clerk is wired and there is
 * a real session to derive the role from. Until then it is a convention with a
 * type behind it, which is weaker than RLS but stronger than passing a bare
 * uuid around and hoping every `where` clause remembers it.
 *
 * The shape is chosen so switching to RLS is a change inside this file: `forOrg`
 * starts issuing `set local app.org_id` in a transaction, and no call site moves.
 */

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

export type Database = ReturnType<typeof createDatabase>;

export interface DatabaseOptions {
  url: string;
  /** Keep this low on Render's smaller instances; pg-boss needs headroom too. */
  max?: number;
  /** Log every statement. Local debugging only. */
  debug?: boolean;
}

/**
 * Connections held open, so `closeDatabase` can find the right one.
 *
 * A WeakMap rather than a property on the returned object: the drizzle instance
 * is passed everywhere, and an `.end()` hanging off it is an invitation for
 * some request handler to close the pool for the whole process.
 */
const connections = new WeakMap<object, postgres.Sql>();

export function createDatabase(options: DatabaseOptions) {
  const sql = postgres(options.url, {
    max: options.max ?? 10,
    // Postgres `timestamptz` comes back as a JS Date; leave it that way.
    // Anything that needs a wall-clock local time uses the user's `timezone`
    // column rather than the server's, which is UTC everywhere.
    onnotice: options.debug ? console.log : () => {},
  });

  const db = drizzle(sql, { schema, logger: options.debug ?? false });
  connections.set(db, sql);
  return db;
}

/**
 * Close the pool.
 *
 * Needed in two places and easy to forget in both. Tests hang without it —
 * Node's runner waits on the open sockets and reports nothing, which reads like
 * a deadlock in the code under test rather than a leaked handle in the harness.
 * And a process that exits without draining the pool leaves connections for
 * Postgres to time out, which on a small Render instance is a real ceiling.
 */
export async function closeDatabase(db: Database): Promise<void> {
  await connections.get(db)?.end({ timeout: 5 });
}

/**
 * A database handle bound to one tenant.
 *
 * Every query built from this still needs its own `eq(table.orgId, orgId)` —
 * the binding is not magic yet. What it buys today is that a function taking an
 * `OrgScopedDatabase` cannot be called without someone having named a tenant,
 * so "which org is this?" is answered at the boundary rather than forgotten in
 * the middle.
 */
export interface OrgScopedDatabase {
  readonly orgId: string;
  readonly db: Database;
}

export function forOrg(db: Database, orgId: string): OrgScopedDatabase {
  if (!orgId) throw new Error('forOrg requires an orgId');
  return { orgId, db };
}

/**
 * Round-trip the connection. Backs the API's readiness check.
 *
 * It lives here rather than in the API so that `@haulq/db` stays the only
 * package importing `drizzle-orm` — the moment a second one does, the ORM is
 * load-bearing in two places and swapping it stops being a local change.
 */
export async function ping(db: Database): Promise<void> {
  await db.execute(sql`select 1`);
}

export { schema };
