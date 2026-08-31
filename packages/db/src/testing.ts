/**
 * Test fixtures.
 *
 * Shipped from `@haulq/db` rather than duplicated per package, for the same
 * reason the repositories are: this is the only package that imports
 * `drizzle-orm`, and a test that reaches around that rule is a test that will
 * break when the ORM changes.
 *
 * The awkward part — tearing down an org — is centralised here on purpose.
 * `event_log` is append-only and `ON DELETE RESTRICT`, so removing a tenant
 * means disabling a trigger, and that dance appearing in five test files is
 * five places to get it wrong. That it is awkward at all is the guardrail
 * working: an audit trail should not be removable by deleting its tenant.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from './client.ts';
import { scope, type Actor, type Scope } from './context.ts';
import { eventLog, eventOutbox } from './schema/events.ts';
import { loads } from './schema/loads.ts';
import { orgInvitations, orgMemberships, orgs, users } from './schema/tenancy.ts';
import { brokerVerifications } from './schema/verify.ts';

export interface TestOrg {
  id: string;
  slug: string;
}

export async function createTestOrg(
  db: Database,
  name = 'Test Carrier',
): Promise<TestOrg> {
  const slug = `test-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(orgs)
    .values({ name, slug, contactEmail: `${slug}@example.test` })
    .returning({ id: orgs.id });
  if (!row) throw new Error('could not create test org');
  return { id: row.id, slug };
}

export async function createTestUser(db: Database): Promise<{ id: string; email: string }> {
  const tag = randomUUID().slice(0, 8);
  const email = `test-${tag}@example.test`;
  const [row] = await db
    .insert(users)
    .values({ externalAuthId: `user_${tag}`, email })
    .returning({ id: users.id });
  if (!row) throw new Error('could not create test user');
  return { id: row.id, email };
}

/**
 * Remove a test org and its audit trail.
 *
 * Only ever call this against a database you are willing to lose. Disabling the
 * append-only trigger is exactly the operation the guardrail exists to prevent,
 * and it is acceptable here solely because the alternative is test data that
 * accumulates forever.
 *
 * **`ALTER TABLE ... DISABLE TRIGGER` is global, not session-scoped.** For the
 * moment this runs, no connection anywhere can rely on the append-only
 * guarantee. That is why the root `test` script pins turbo to
 * `--concurrency=1`: two suites tearing down against one database would race,
 * and the symptom would be an append-only assertion failing intermittently in
 * CI for reasons that look nothing like the cause.
 */
export async function destroyTestOrg(db: Database, orgId: string): Promise<void> {
  await db.execute(sql`alter table event_log disable trigger event_log_no_delete_trg`);
  try {
    await db.delete(eventLog).where(eq(eventLog.orgId, orgId));
  } finally {
    await db.execute(sql`alter table event_log enable trigger event_log_no_delete_trg`);
  }
  await db.delete(orgs).where(eq(orgs.id, orgId));
}

/**
 * Delete a test user, including any events they authored.
 *
 * The trigger dance is not optional, and the reason is not obvious.
 * `event_log.actor_user_id` is ON DELETE SET NULL, so deleting a user makes
 * Postgres UPDATE the log — and the append-only trigger rejects UPDATEs. The
 * failure surfaces as:
 *
 *     event_log is append-only (attempted UPDATE)
 *
 * …from a line that only says `destroyTestUser`, which reads like the guardrail
 * is broken rather than like a helper that cannot clean up after itself. It
 * only bites once a user has actually acted, so it stayed hidden while the
 * suites destroyed users who had merely authenticated.
 *
 * Same global-trigger caveat as `destroyTestOrg` above: for this moment no
 * connection anywhere has the append-only guarantee, which is why the root
 * `test` script pins turbo to `--concurrency=1`.
 */
export async function destroyTestUser(db: Database, userId: string): Promise<void> {
  await db.execute(sql`alter table event_log disable trigger event_log_no_delete_trg`);
  try {
    await db.delete(eventLog).where(eq(eventLog.actorUserId, userId));
  } finally {
    await db.execute(sql`alter table event_log enable trigger event_log_no_delete_trg`);
  }
  await db.delete(users).where(eq(users.id, userId));
}

/** A scope for a test, defaulting to a user actor. */
export function testScope(db: Database, orgId: string, actor: Actor): Scope {
  return scope(db, { orgId, actor, correlationId: randomUUID() });
}

// ---------------------------------------------------------------------------
// Membership and user helpers
// ---------------------------------------------------------------------------
//
// These exist so test files do not import `drizzle-orm`. That rule is not
// pedantry: `@haulq/db` being the only package that touches the ORM is what
// makes swapping it a local change, and a test suite that reaches around the
// rule is exactly as much of an obstacle as production code doing it.

export type TestRole = 'owner' | 'dispatcher' | 'driver' | 'accountant';

export async function addTestMembership(
  db: Database,
  args: { orgId: string; userId: string; role?: TestRole },
): Promise<void> {
  await db.insert(orgMemberships).values({
    orgId: args.orgId,
    userId: args.userId,
    role: args.role ?? 'owner',
    status: 'active',
    acceptedAt: new Date(),
  });
}

export async function setTestMembershipRole(
  db: Database,
  args: { orgId: string; userId: string; role: TestRole },
): Promise<void> {
  await db
    .update(orgMemberships)
    .set({ role: args.role })
    .where(
      and(
        eq(orgMemberships.orgId, args.orgId),
        eq(orgMemberships.userId, args.userId),
      ),
    );
}

export async function getTestUser(
  db: Database,
  id: string,
): Promise<typeof users.$inferSelect | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row;
}

/**
 * Age an invitation past its expiry.
 *
 * The alternative is a test that sleeps for a week or one that injects a clock
 * into the repository. Moving the row's own deadline into the past exercises
 * the real expiry check with no production code bent to accommodate it.
 */
export async function expireInvitationForTest(
  db: Database,
  invitationId: string,
): Promise<void> {
  await db
    .update(orgInvitations)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(orgInvitations.id, invitationId));
}

/** Topics queued but not yet consumed, for asserting on the outbox. */
/**
 * Put a drained message back on the queue.
 *
 * Simulates the one delivery guarantee that is hard to test any other way: the
 * outbox is at-least-once, so a lease that expires mid-handling causes the same
 * message to arrive twice. A handler that is not idempotent looks perfectly
 * correct until that happens in production at 3am.
 *
 * Lives here rather than in the suite so test files do not import drizzle-orm —
 * same rule as the helpers above.
 */
export async function requeueOutboxForTest(
  db: Database,
  args: { orgId: string; topic: string },
): Promise<number> {
  const rows = await db
    .update(eventOutbox)
    .set({ processedAt: null, availableAt: new Date(), attempts: 0 })
    .where(and(eq(eventOutbox.orgId, args.orgId), eq(eventOutbox.topic, args.topic)))
    .returning({ seq: eventOutbox.seq });
  return rows.length;
}

export async function pendingOutboxTopics(
  db: Database,
  orgId: string,
): Promise<string[]> {
  const rows = await db
    .select({ topic: eventOutbox.topic })
    .from(eventOutbox)
    .where(and(eq(eventOutbox.orgId, orgId), isNull(eventOutbox.processedAt)));
  return rows.map((r) => r.topic);
}

/**
 * Move a verification's `checkedAt` into the past.
 *
 * The nightly re-check sweep decides what is "due" purely off this column,
 * and nothing in the application ever backdates it — a test that wants to
 * exercise "stale" has no real path to that state except reaching in
 * directly, the same reason `expireInvitationForTest` exists above.
 */
export async function backdateVerificationForTest(
  db: Database,
  verificationId: string,
  checkedAt: Date,
): Promise<void> {
  await db
    .update(brokerVerifications)
    .set({ checkedAt })
    .where(eq(brokerVerifications.id, verificationId));
}

/** Look up by the Clerk id, which is what a webhook test has to hand. */
export async function findTestUserByExternalId(
  db: Database,
  externalAuthId: string,
): Promise<typeof users.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.externalAuthId, externalAuthId));
  return row;
}

/**
 * Set a load's `actual_*` columns directly.
 *
 * No repository function does this outside the CSV importer — reconciling
 * expected against actual is Insights' whole reason to exist, and Insights is
 * read-only, so there is nothing to call. Direct like the trigger dance above,
 * for the same reason: keeping test files free of `drizzle-orm`.
 */
export async function setLoadActualsForTest(
  db: Database,
  loadId: string,
  actuals: {
    actualRevenueAmount?: number;
    actualLoadedMiles?: number;
    actualDeadheadMiles?: number;
    deliveredAt?: Date;
  },
): Promise<void> {
  await db
    .update(loads)
    .set(
      actuals.actualRevenueAmount !== undefined
        ? { ...actuals, actualRevenueCurrency: 'USD' }
        : actuals,
    )
    .where(eq(loads.id, loadId));
}

export async function setTestUserEmail(
  db: Database,
  id: string,
  email: string,
): Promise<void> {
  await db.update(users).set({ email }).where(eq(users.id, id));
}
