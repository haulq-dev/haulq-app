/**
 * Migration runner.
 *
 * Three phases, in this order:
 *
 *  1. `sql/pre/`  — extensions. Must precede the tables, because a column
 *                   defaulting to `gen_random_uuid()` fails at CREATE TABLE if
 *                   the function does not exist yet.
 *  2. `drizzle/`  — the generated migrations. Tables, columns, indexes.
 *  3. `sql/post/` — what Drizzle's schema language cannot express: triggers,
 *                   append-only grants, the per-org load reference counter,
 *                   status-transition and check constraints.
 *
 * Phases 1 and 3 are idempotent by construction (`create or replace`, `drop
 * trigger if exists` before create, `if not exists` everywhere) so re-running
 * them on every deploy is safe and there is no second migration table to keep
 * honest.
 *
 * Run: `DATABASE_URL=... pnpm --filter @haulq/db migrate`
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sslFor } from './ssl.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

async function main() {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  // max: 1 — migrations must not interleave across connections.
  //
  // Notices are suppressed because sql/post is deliberately idempotent: every
  // guard is `drop ... if exists` then create, and Postgres emits a NOTICE for
  // each one that was not there. On a fresh database that is ~30 lines of noise
  // burying the one line that matters.
  // TLS derived from the URL — running migrations from a laptop against
  // Render's external host needs it, and the internal host must not have it.
  const sql = postgres(url, { max: 1, onnotice: () => {}, ssl: sslFor(url) });
  const db = drizzle(sql);

  const applyDir = async (label: string, dir: string) => {
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    } catch {
      return; // directory absent is not an error
    }
    console.log(`→ ${label}`);
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8');
      process.stdout.write(`   ${file} ... `);
      await sql.unsafe(text);
      console.log('ok');
    }
  };

  try {
    await applyDir('extensions', join(packageRoot, 'sql', 'pre'));

    console.log('→ drizzle migrations');
    await migrate(db, { migrationsFolder: join(packageRoot, 'drizzle') });

    await applyDir('guards', join(packageRoot, 'sql', 'post'));

    console.log('✓ migrations complete');
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
