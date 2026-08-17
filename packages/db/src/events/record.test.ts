/**
 * The event log writer, against a real database.
 *
 * The claim under test is the one the whole design rests on: **a state change
 * and the event recording it commit together or not at all.** Everything else
 * here is secondary.
 *
 * Skips without DATABASE_URL, same as `guards.test.ts`.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, createDatabase, type Database } from '../client.ts';
import { scope, type Actor, type Scope } from '../context.ts';
import { eventLog, eventOutbox } from '../schema/events.ts';
import { trucks } from '../schema/fleet.ts';
import {
  createTestOrg,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
} from '../testing.ts';
import { withTransaction } from '../transaction.ts';
import { readTimeline, recordEvent } from './record.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let db: Database;
let orgId: string;
let otherOrgId: string;
let userId: string;

const scopeFor = (actor: Actor, org = orgId): Scope =>
  scope(db, { orgId: org, actor, correlationId: randomUUID() });

suite('event log writer', () => {
  before(async () => {
    db = createDatabase({ url: url! });

    orgId = (await createTestOrg(db, 'Writer Test Carrier')).id;
    otherOrgId = (await createTestOrg(db, 'Other Carrier')).id;
    userId = (await createTestUser(db)).id;
  });

  after(async () => {
    // Tearing down an org means disabling the append-only trigger. That it is
    // awkward enough to justify a helper is the guardrail working.
    await destroyTestOrg(db, orgId);
    await destroyTestOrg(db, otherOrgId);
    await destroyTestUser(db, userId);
    // Without this the test runner hangs on the open pool rather than exiting.
    await closeDatabase(db);
  });

  // --- the central claim ---------------------------------------------------

  describe('atomicity', () => {
    it('commits the record and its event together', async () => {
      const s = scopeFor({ type: 'user', id: userId, email: 'j@haulq.ai' });
      const label = `atomic-${Date.now()}`;

      const truckId = await withTransaction(s, async (tx) => {
        const [row] = await tx.db
          .insert(trucks)
          .values({ orgId: tx.ctx.orgId, label })
          .returning();
        await recordEvent(tx, 'truck.added', {
          subjectId: row!.id,
          payload: { label, equipment: 'STRAIGHT_BOX' },
        });
        return row!.id;
      });

      const events = await db
        .select()
        .from(eventLog)
        .where(and(eq(eventLog.orgId, orgId), eq(eventLog.subjectId, truckId)));

      assert.equal(events.length, 1);
      assert.equal(events[0]!.verb, 'truck.added');
      assert.match(events[0]!.explanation, /^Added atomic-\d+ \(straight box\)\.$/);
    });

    it('leaves no event behind when the transaction rolls back', async () => {
      // The failure this exists to catch: an audit trail claiming a truck was
      // added that never was. Silent, and only discovered when the trail
      // matters.
      const s = scopeFor({ type: 'user', id: userId });
      const label = `rollback-${Date.now()}`;
      const marker = randomUUID();

      await assert.rejects(
        withTransaction(s, async (tx) => {
          const [row] = await tx.db
            .insert(trucks)
            .values({ orgId: tx.ctx.orgId, label })
            .returning();
          await recordEvent(tx, 'truck.added', {
            subjectId: row!.id,
            payload: { label: marker, equipment: 'STRAIGHT_BOX' },
          });
          throw new Error('deliberate failure after both writes');
        }),
        /deliberate failure/,
      );

      const events = await db
        .select()
        .from(eventLog)
        .where(eq(eventLog.orgId, orgId));
      assert.equal(
        events.filter((e) => e.explanation.includes(marker)).length,
        0,
        'the event survived a rollback',
      );

      const rows = await db
        .select()
        .from(trucks)
        .where(and(eq(trucks.orgId, orgId), eq(trucks.label, label)));
      assert.equal(rows.length, 0, 'the truck survived a rollback');
    });

    it('writes the outbox row in the same transaction', async () => {
      const s = scopeFor({ type: 'user', id: userId });
      const marker = `outbox-${Date.now()}`;

      await assert.rejects(
        withTransaction(s, async (tx) => {
          await recordEvent(tx, 'member.invited', {
            payload: { email: `${marker}@example.com`, role: 'driver' },
          });
          throw new Error('deliberate failure');
        }),
        /deliberate failure/,
      );

      const pending = await db
        .select()
        .from(eventOutbox)
        .where(eq(eventOutbox.orgId, orgId));
      assert.equal(
        pending.filter((p) => JSON.stringify(p.payload).includes(marker)).length,
        0,
        'an invite email would have been sent for an invite that rolled back',
      );
    });

    it('only queues an outbox row for verbs that have a consequence', async () => {
      const s = scopeFor({ type: 'user', id: userId });
      const before_ = await db
        .select()
        .from(eventOutbox)
        .where(eq(eventOutbox.orgId, orgId));

      await withTransaction(s, (tx) =>
        recordEvent(tx, 'driver.added', { payload: { name: 'Ray' } }),
      );

      const after_ = await db
        .select()
        .from(eventOutbox)
        .where(eq(eventOutbox.orgId, orgId));
      assert.equal(after_.length, before_.length, 'driver.added has no topic');
    });
  });

  // --- guardrail 5 ---------------------------------------------------------

  describe('actor attribution', () => {
    it('records an agent as an agent, not as the system', async () => {
      // The whole reason actor_type is a union. If a model's action and a cron
      // job's action look the same in the log, guardrail 5 is unauditable.
      const s = scopeFor({
        type: 'agent',
        model: 'claude-haiku-4-5-20251001',
        onBehalfOfUserId: userId,
      });

      const recorded = await withTransaction(s, (tx) =>
        recordEvent(tx, 'load.created', {
          payload: {
            reference: 1,
            origin: 'Wichita, KS',
            destination: 'Denver, CO',
            source: 'load_board',
          },
        }),
      );

      const [row] = await db
        .select()
        .from(eventLog)
        .where(eq(eventLog.seq, recorded.seq));

      assert.equal(row!.actorType, 'agent');
      assert.equal(row!.actorId, 'claude-haiku-4-5-20251001');
      assert.equal(
        row!.actorUserId,
        userId,
        'who authorized it is recorded, without implying they performed it',
      );
    });

    it('records a system job distinguishably', async () => {
      const s = scopeFor({ type: 'system', name: 'retention-purge' });
      const recorded = await withTransaction(s, (tx) =>
        recordEvent(tx, 'truck.deactivated', {
          payload: { label: 'Unit 9', reason: 'retention' },
        }),
      );
      const [row] = await db
        .select()
        .from(eventLog)
        .where(eq(eventLog.seq, recorded.seq));

      assert.equal(row!.actorType, 'system');
      assert.equal(row!.actorId, 'retention-purge');
      assert.equal(row!.actorUserId, null);
    });
  });

  // --- reading -------------------------------------------------------------

  describe('timeline', () => {
    it('never returns another org\'s events', async () => {
      const mine = scopeFor({ type: 'user', id: userId });
      const theirs = scopeFor({ type: 'user', id: userId }, otherOrgId);

      await withTransaction(theirs, (tx) =>
        recordEvent(tx, 'org.created', { payload: { name: 'Other Carrier' } }),
      );

      const entries = await readTimeline(mine, { limit: 200 });
      assert.equal(
        entries.filter((e) => e.explanation.includes('Other Carrier')).length,
        0,
      );
    });

    it('returns newest first and pages backwards on seq', async () => {
      const s = scopeFor({ type: 'user', id: userId });
      for (const name of ['Paging A', 'Paging B', 'Paging C']) {
        await withTransaction(s, (tx) =>
          recordEvent(tx, 'driver.added', { payload: { name } }),
        );
      }

      const first = await readTimeline(s, { limit: 2 });
      assert.equal(first.length, 2);
      assert.ok(first[0]!.seq > first[1]!.seq, 'newest first');

      const next = await readTimeline(s, { limit: 2, before: first[1]!.seq });
      assert.ok(
        next.every((e) => e.seq < first[1]!.seq),
        'the cursor does not repeat rows',
      );
    });

    it('filters to one subject', async () => {
      const s = scopeFor({ type: 'user', id: userId });
      const subjectId = randomUUID();

      await withTransaction(s, (tx) =>
        recordEvent(tx, 'truck.added', {
          subjectId,
          payload: { label: 'Filtered', equipment: 'REEFER' },
        }),
      );

      const entries = await readTimeline(s, { subjectType: 'truck', subjectId });
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.subjectId, subjectId);
    });
  });

  // --- overrides -----------------------------------------------------------

  it('accepts a supplied explanation and occurredAt for imported history', async () => {
    const s = scopeFor({ type: 'system', name: 'csv-import' });
    const when = new Date('2026-05-01T12:00:00Z');

    const recorded = await withTransaction(s, (tx) =>
      recordEvent(tx, 'load.delivered', {
        payload: { reference: 88, deliveredAt: when.toISOString() },
        explanation: 'Delivered load 88 (imported from the carrier\'s records).',
        occurredAt: when,
      }),
    );

    const [row] = await db
      .select()
      .from(eventLog)
      .where(eq(eventLog.seq, recorded.seq));

    assert.match(row!.explanation, /imported from/);
    assert.equal(row!.occurredAt.toISOString(), when.toISOString());
  });
});
