/**
 * Appending to the event log.
 *
 * `recordEvent` is the only supported way to write `event_log`. It is not a
 * convenience wrapper — it is where three rules are applied that the database
 * cannot apply for itself:
 *
 *  1. **The explanation comes from the catalogue.** Not from the call site. See
 *     the note in `catalog.ts` for why that decays otherwise.
 *  2. **The actor is recorded faithfully.** `actor_type` distinguishes an agent
 *     from a cron job, which is what makes guardrail 5 auditable at all.
 *  3. **The outbox row goes in the same transaction.** So a consequence never
 *     fires for a change that rolled back.
 *
 * Rules the *database* applies, which nothing here duplicates: the hash chain,
 * append-only enforcement, and `seq` ordering. Those live in
 * `sql/post/0200_event_log_append_only.sql` because a rule enforced only in
 * this file is a rule that a raw SQL migration will break.
 */

import { and, desc, eq, lt } from 'drizzle-orm';
import { actorId, actorUserId, type Scope } from '../context.ts';
import { eventLog, eventOutbox } from '../schema/events.ts';
import { eventCatalog, type EventVerb, type PayloadOf } from './catalog.ts';

export interface RecordedEvent {
  seq: bigint;
  verb: EventVerb;
  explanation: string;
}

export interface RecordOptions {
  /**
   * Override the catalogue's sentence.
   *
   * Exists for the case the catalogue cannot serve: replaying history during a
   * migration or import, where the accurate sentence is the one from the source
   * system rather than one generated now. Not for convenience — if the
   * catalogue's phrasing is wrong, fix the catalogue.
   */
  explanation?: string;
  /** Overrides `now()`. Used when importing history that happened earlier. */
  occurredAt?: Date;
}

/**
 * Append one event.
 *
 * Must be called inside `withTransaction` alongside the change it describes.
 * Calling it on a bare connection will still work, and will still be wrong —
 * see the module note in `transaction.ts`.
 */
export async function recordEvent<V extends EventVerb>(
  s: Scope,
  verb: V,
  args: { subjectId?: string; payload: PayloadOf<V> } & RecordOptions,
): Promise<RecordedEvent> {
  const definition = eventCatalog[verb];
  const explanation =
    args.explanation ??
    (definition.describe as (p: PayloadOf<V>) => string)(args.payload);

  const [row] = await s.db
    .insert(eventLog)
    .values({
      orgId: s.ctx.orgId,
      occurredAt: args.occurredAt ?? new Date(),
      actorType: s.ctx.actor.type,
      actorId: actorId(s.ctx.actor),
      actorUserId: actorUserId(s.ctx.actor),
      verb,
      subjectType: definition.subjectType,
      subjectId: args.subjectId ?? null,
      explanation,
      data: args.payload as Record<string, unknown>,
      correlationId: s.ctx.correlationId,
      ipAddress: s.ctx.ipAddress ?? null,
      userAgent: s.ctx.userAgent ?? null,
    })
    // hash and prev_hash are computed by the trigger and deliberately not sent.
    .returning({ seq: eventLog.seq });

  if (!row) throw new Error(`event_log insert returned nothing for ${verb}`);

  if (definition.topic) {
    await s.db.insert(eventOutbox).values({
      orgId: s.ctx.orgId,
      eventSeq: row.seq,
      topic: definition.topic,
      payload: args.payload as Record<string, unknown>,
    });
  }

  return { seq: row.seq, verb, explanation };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  seq: bigint;
  occurredAt: Date;
  verb: string;
  subjectType: string;
  subjectId: string | null;
  explanation: string;
  actorType: string;
  actorId: string | null;
}

export interface TimelineQuery {
  /** Cursor: return events before this seq. See `PageQuerySchema` for why. */
  before?: bigint;
  limit?: number;
  /** Narrow to one subject, e.g. everything that happened to one load. */
  subjectType?: string;
  subjectId?: string;
}

/**
 * The org's timeline, newest first.
 *
 * Returns only the readable columns. `hash` and `prev_hash` are deliberately
 * not exposed — they are tamper evidence, not content, and putting them in an
 * API response invites someone to validate the chain client-side against a
 * partial page and conclude it is broken.
 */
export async function readTimeline(
  s: Scope,
  q: TimelineQuery = {},
): Promise<TimelineEntry[]> {
  const limit = Math.min(q.limit ?? 50, 200);

  const conditions = [eq(eventLog.orgId, s.ctx.orgId)];
  if (q.before !== undefined) conditions.push(lt(eventLog.seq, q.before));
  if (q.subjectType) conditions.push(eq(eventLog.subjectType, q.subjectType));
  if (q.subjectId) conditions.push(eq(eventLog.subjectId, q.subjectId));

  return s.db
    .select({
      seq: eventLog.seq,
      occurredAt: eventLog.occurredAt,
      verb: eventLog.verb,
      subjectType: eventLog.subjectType,
      subjectId: eventLog.subjectId,
      explanation: eventLog.explanation,
      actorType: eventLog.actorType,
      actorId: eventLog.actorId,
    })
    .from(eventLog)
    .where(and(...conditions))
    .orderBy(desc(eventLog.seq))
    .limit(limit);
}
