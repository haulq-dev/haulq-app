/**
 * Behavioural tests for the database guards.
 *
 * These cover the rules in `sql/post/` — triggers, check constraints, the hash
 * chain. None of them are visible to `tsc` or to `drizzle-kit`, and they are the
 * ones carrying build plan section 9's guardrails. A schema that compiles and a
 * schema that refuses to let an audit row be edited are different claims.
 *
 * Needs a real Postgres:
 *
 *   DATABASE_URL=postgres://... pnpm --filter @haulq/db migrate
 *   DATABASE_URL=postgres://... pnpm --filter @haulq/db test
 *
 * Skips when DATABASE_URL is unset so `pnpm test` still runs on a laptop with
 * no database. CI always sets it — see .github/workflows/ci.yml.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import postgres from 'postgres';
import { sslFor } from './ssl.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let sql: postgres.Sql;
let orgId: string;

/**
 * Asserts the statement fails, and that the message mentions `contains`.
 *
 * Runs inside its own transaction, which matters for two reasons. The failure
 * rolls back rather than leaving a half-written row behind, and — the reason
 * this is not optional — the statement gets a reserved connection instead of
 * sharing the pooled one. Expected failures on a shared pipelined connection
 * can surface against whichever query is in flight, which produces test results
 * that blame the wrong assertion and are miserable to read.
 */
async function rejects(
  fn: (t: postgres.TransactionSql) => Promise<unknown>,
  contains: string,
) {
  try {
    await sql.begin(async (t) => fn(t));
  } catch (err) {
    assert.match(
      String((err as Error).message),
      new RegExp(contains, 'i'),
      `expected failure mentioning "${contains}"`,
    );
    return;
  }
  assert.fail(`expected a failure mentioning "${contains}", but it succeeded`);
}

suite('database guards', () => {
  before(async () => {
    // Same TLS negotiation `migrate.ts` and `client.ts` do — without it, a
    // connection string from Render's "External" tab fails with a `28000`
    // ("SSL/TLS required") that Node's driver often surfaces as a bare
    // ECONNRESET instead, which reads like a network blip and is not one.
    sql = postgres(url!, { max: 1, ssl: sslFor(url!) });
    const [org] = await sql<{ id: string }[]>`
      insert into orgs (name, slug, contact_email)
      values ('Guard Test Carrier', ${'guard-' + Date.now()}, 'test@example.com')
      returning id`;
    orgId = org!.id;
  });

  after(async () => {
    // orgs cascade to everything tenant-scoped except event_log, which is
    // ON DELETE RESTRICT precisely so an audit trail cannot be removed by
    // deleting its tenant. Clearing it here needs the trigger dropped, which
    // is itself a demonstration of the guard working.
    await sql`alter table event_log disable trigger event_log_no_delete_trg`;
    await sql`delete from event_log where org_id = ${orgId}`;
    await sql`alter table event_log enable trigger event_log_no_delete_trg`;
    await sql`delete from orgs where id = ${orgId}`;
    await sql.end();
  });

  // --- load references (0100) ---------------------------------------------

  describe('load references', () => {
    it('assigns sequential numbers per org, starting at 1', async () => {
      const mk = () => sql<{ reference: number }[]>`
        insert into loads (org_id, source, status)
        values (${orgId}, 'manual', 'prospect')
        returning reference`;

      const [a] = await mk();
      const [b] = await mk();

      assert.equal(a!.reference, 1);
      assert.equal(b!.reference, 2);
    });

    it('does not overwrite a reference the caller supplied', async () => {
      // The CSV importer relies on this to preserve a carrier's historical
      // load numbers, which are on invoices the broker already has.
      //
      // Also the shape of a real historical row: delivered, with no truck named,
      // because the carrier's old system did not record one. See the exemption
      // in 0300_load_status.sql.
      const [row] = await sql<{ reference: number }[]>`
        insert into loads (org_id, source, status, reference, booked_at, delivered_at)
        values (${orgId}, 'csv_import', 'delivered', 9001,
                now() - interval '40 days', now() - interval '38 days')
        returning reference`;
      assert.equal(row!.reference, 9001);
    });

    it('keeps numbering independent between orgs', async () => {
      const [other] = await sql<{ id: string }[]>`
        insert into orgs (name, slug, contact_email)
        values ('Second Carrier', ${'guard2-' + Date.now()}, 'b@example.com')
        returning id`;

      const [row] = await sql<{ reference: number }[]>`
        insert into loads (org_id, source, status)
        values (${other!.id}, 'manual', 'prospect')
        returning reference`;

      assert.equal(row!.reference, 1, 'a new org starts at 1');
      await sql`delete from orgs where id = ${other!.id}`;
    });
  });

  // --- event log (0200) ----------------------------------------------------

  describe('event log', () => {
    const insertEvent = (verb: string, explanation: string) => sql<
      { seq: string; hash: string; prev_hash: string | null }[]
    >`
      insert into event_log (org_id, actor_type, actor_id, verb, subject_type, explanation)
      values (${orgId}, 'system', 'guard-test', ${verb}, 'load', ${explanation})
      returning seq, hash, prev_hash`;

    it('refuses updates', async () => {
      const [e] = await insertEvent('load.booked', 'Booked load 1.');
      await rejects(
        (t) => t`update event_log set explanation = 'edited' where seq = ${e!.seq}`,
        'append-only',
      );
    });

    it('refuses deletes', async () => {
      const [e] = await insertEvent('load.cancelled', 'Cancelled load 1.');
      await rejects(
        (t) => t`delete from event_log where seq = ${e!.seq}`,
        'append-only',
      );
    });

    it('chains each event to the one before it', async () => {
      const [first] = await insertEvent('load.quoted', 'Quoted load 2 at $2,400.');
      const [second] = await insertEvent('load.booked', 'Booked load 2 at $2,400.');

      assert.ok(first!.hash, 'hash is computed by the trigger, not the caller');
      assert.equal(second!.prev_hash, first!.hash);
    });

    it('ignores a hash supplied by the caller', async () => {
      // Anything the application can set, the application can forge.
      const [e] = await sql<{ hash: string }[]>`
        insert into event_log
          (org_id, actor_type, verb, subject_type, explanation, hash, prev_hash)
        values
          (${orgId}, 'agent', 'load.recommended', 'load', 'Recommended load 3.',
           'forged', 'also-forged')
        returning hash`;
      assert.notEqual(e!.hash, 'forged');
    });

    it('verifies an intact chain', async () => {
      const rows = await sql`select * from verify_event_chain(${orgId})`;
      assert.equal(rows.length, 0, 'no rows means the chain reproduces');
    });

    it('requires an explanation', async () => {
      // Guardrail 6. A log row nobody can read is not an audit trail.
      await rejects(
        (t) => t`
          insert into event_log (org_id, actor_type, verb, subject_type)
          values (${orgId}, 'system', 'load.booked', 'load')`,
        'explanation',
      );
    });
  });

  // --- load status (0300) --------------------------------------------------

  describe('load status transitions', () => {
    const newLoad = async (status = 'prospect') => {
      const [row] = await sql<{ id: string }[]>`
        insert into loads (org_id, source, status)
        values (${orgId}, 'manual', ${status})
        returning id`;
      return row!.id;
    };

    it('allows skipping forward', async () => {
      // prospect → booked, with nothing quoted. This is what a carrier booking
      // straight off a broker email actually does.
      const id = await newLoad();
      await sql`update loads set status = 'booked', booked_at = now() where id = ${id}`;
      const [row] = await sql<{ status: string }[]>`select status from loads where id = ${id}`;
      assert.equal(row!.status, 'booked');
    });

    it('refuses to move backwards', async () => {
      const id = await newLoad();
      await sql`update loads set status = 'booked', booked_at = now() where id = ${id}`;
      await rejects(
        (t) => t`update loads set status = 'quoted' where id = ${id}`,
        'backwards',
      );
    });

    it('refuses to reopen a cancelled load', async () => {
      const id = await newLoad();
      await sql`update loads set status = 'cancelled', cancelled_at = now() where id = ${id}`;
      await rejects(
        (t) => t`update loads set status = 'booked', booked_at = now() where id = ${id}`,
        'cancelled',
      );
    });

    it('refuses to cancel a paid load', async () => {
      const id = await newLoad();
      const [truck] = await sql<{ id: string }[]>`
        insert into trucks (org_id, label) values (${orgId}, ${'T-' + Date.now()})
        returning id`;
      await sql`
        update loads
           set status = 'paid', booked_at = now(), delivered_at = now(),
               truck_id = ${truck!.id}
         where id = ${id}`;
      await rejects(
        (t) => t`update loads set status = 'cancelled', cancelled_at = now() where id = ${id}`,
        'reversal',
      );
    });

    it('requires booked_at once booked', async () => {
      const id = await newLoad();
      await rejects(
        (t) => t`update loads set status = 'booked' where id = ${id}`,
        'loads_booked_has_timestamp',
      );
    });

    it('requires a truck once dispatched', async () => {
      const id = await newLoad();
      await rejects(
        (t) => t`
          update loads set status = 'dispatched', booked_at = now() where id = ${id}`,
        'loads_dispatched_has_truck',
      );
    });
  });

  // --- constraints (0500) --------------------------------------------------

  describe('provenance and money', () => {
    it('refuses a board-sourced load with no provenance', async () => {
      // Guardrail 4 is only enforceable if every board row knows where it came
      // from and when.
      await rejects(
        (t) => t`
          insert into loads (org_id, source, status)
          values (${orgId}, 'load_board', 'prospect')`,
        'provenance',
      );
    });

    it('accepts a board-sourced load with provenance', async () => {
      const [row] = await sql<{ id: string }[]>`
        insert into loads (org_id, source, status, source_board, source_load_id,
                           source_fetched_at, purge_after)
        values (${orgId}, 'load_board', 'prospect', 'DF', ${'df-' + Date.now()},
                now(), now() + interval '30 days')
        returning id`;
      assert.ok(row!.id);
    });

    it('refuses an amount with no currency', async () => {
      await rejects(
        (t) => t`
          insert into loads (org_id, source, status, rate_amount, rate_currency)
          values (${orgId}, 'manual', 'prospect', 240000, null)`,
        'currency',
      );
    });

    it('refuses a truck position with no timestamp or source', async () => {
      await rejects(
        (t) => t`
          insert into trucks (org_id, label, current_lat, current_lng)
          values (${orgId}, ${'P-' + Date.now()}, 37.6872, -97.3301)`,
        'trucks_position_has_timestamp',
      );
    });

    it('refuses a rejected document with no reason', async () => {
      await rejects(
        (t) => t`
          insert into documents (org_id, source, status, storage_key, sha256)
          values (${orgId}, 'upload', 'rejected', 'k/1', ${'sha-' + Date.now()})`,
        'documents_rejected_has_reason',
      );
    });
  });

  // --- updated_at (0400) ---------------------------------------------------

  it('maintains updated_at without the application setting it', async () => {
    const [row] = await sql<{ id: string; updated_at: Date }[]>`
      insert into trucks (org_id, label) values (${orgId}, ${'U-' + Date.now()})
      returning id, updated_at`;

    await new Promise((r) => setTimeout(r, 10));
    const [after_] = await sql<{ updated_at: Date }[]>`
      update trucks set label = ${'U2-' + Date.now()} where id = ${row!.id}
      returning updated_at`;

    assert.ok(
      after_!.updated_at.getTime() > row!.updated_at.getTime(),
      'the trigger, not the ORM, moves updated_at',
    );
  });
});
