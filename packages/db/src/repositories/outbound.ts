/**
 * Outbound — the record of everything sent, drafted or held in a carrier's
 * name, and the settings that decide which. `FEATURE_REQUESTS_PLAN.md`
 * section 8, piece 1.
 *
 * This file only records and transitions state. *Deciding* what mode a
 * message runs in, and actually calling Unipile, is `apps/api`'s
 * `outbound/dispatch.ts` — the one choke point. Keeping the two apart is
 * what lets every rule (ceiling, kill switch, dedupe) live in one place
 * instead of being re-derived by each caller.
 */

import { and, count, desc, eq, lt } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { mailboxConnections } from '../schema/mailbox.ts';
import { autonomySettings, outboundMessages, type StoredOutboundAttachment } from '../schema/outbound.ts';
import { withTransaction } from '../transaction.ts';

export type OutboundMessageRow = typeof outboundMessages.$inferSelect;

export class OutboundStateError extends Error {
  readonly code: 'not_connected' | 'not_found' | 'wrong_state';
  constructor(code: OutboundStateError['code'], message: string) {
    super(message);
    this.name = 'OutboundStateError';
    this.code = code;
  }
}

// --- settings ---------------------------------------------------------------

export interface StoredOutboundSettings {
  sendingEnabled: boolean;
  /** Only the action types the carrier has explicitly set. */
  modes: Record<string, string>;
}

export async function getOutboundSettings(s: Scope): Promise<StoredOutboundSettings> {
  const [connection] = await s.db
    .select({ sendingEnabled: mailboxConnections.sendingEnabled, status: mailboxConnections.status })
    .from(mailboxConnections)
    .where(eq(mailboxConnections.orgId, s.ctx.orgId));

  const rows = await s.db
    .select({ actionType: autonomySettings.actionType, mode: autonomySettings.mode })
    .from(autonomySettings)
    .where(eq(autonomySettings.orgId, s.ctx.orgId));

  return {
    // A flag left on a connection that is no longer connected is not "on".
    sendingEnabled: connection?.status === 'connected' && connection.sendingEnabled,
    modes: Object.fromEntries(rows.map((r) => [r.actionType, r.mode])),
  };
}

/** The kill switch. Turning it on needs a connected mailbox; turning it off never does. */
export async function setSendingEnabled(s: Scope, enabled: boolean): Promise<void> {
  await withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .update(mailboxConnections)
      .set({ sendingEnabled: enabled, updatedAt: new Date() })
      .where(
        enabled
          ? and(eq(mailboxConnections.orgId, tx.ctx.orgId), eq(mailboxConnections.status, 'connected'))
          : eq(mailboxConnections.orgId, tx.ctx.orgId),
      )
      .returning({ id: mailboxConnections.id });

    if (!row) {
      if (enabled) {
        throw new OutboundStateError('not_connected', 'Connect a mailbox before turning sending on.');
      }
      return;
    }

    await recordEvent(tx, 'outbound.sending_changed', { subjectId: row.id, payload: { enabled } });
  });
}

export async function setAutonomyMode(s: Scope, actionType: string, mode: string): Promise<void> {
  await withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .insert(autonomySettings)
      .values({ orgId: tx.ctx.orgId, actionType, mode })
      .onConflictDoUpdate({
        target: [autonomySettings.orgId, autonomySettings.actionType],
        set: { mode, updatedAt: new Date() },
      })
      .returning({ id: autonomySettings.id });
    if (!row) throw new Error('autonomy setting upsert returned nothing');

    await recordEvent(tx, 'outbound.mode_changed', { subjectId: row.id, payload: { actionType, mode } });
  });
}

// --- messages ---------------------------------------------------------------

export interface CreateOutboundInput {
  actionType: string;
  mode: string;
  status: 'shadow' | 'pending_approval' | 'sending';
  holdReason: string | null;
  toAddresses: string[];
  subject: string;
  body: string;
  attachments?: StoredOutboundAttachment[] | undefined;
  relatedType?: string | undefined;
  relatedId?: string | undefined;
  dedupeKey?: string | undefined;
}

/**
 * Record a message. Idempotent on `dedupeKey`: a second call with the same
 * key returns the first row and `created: false`, so a loop that
 * re-evaluates the same load every pass cannot chase twice. The caller
 * must not send when `created` is false.
 *
 * One exception, and it matters: an earlier **shadow** row does not use up
 * the key against a message that is now allowed to go further. A draft that
 * was only held (sending was off, or the mode was still shadow) is
 * promoted in place — same row, refreshed content, new status — and comes
 * back `created: true`. Without this, a carrier who watched a week of
 * shadow drafts and then turned an action on would find the loop silently
 * refusing to send the very things they had just approved of, because each
 * was already "recorded". The status guard on the update keeps two racing
 * callers from both promoting the same row.
 */
export async function createOutbound(
  s: Scope,
  input: CreateOutboundInput,
): Promise<{ message: OutboundMessageRow; created: boolean }> {
  const [inserted] = await s.db
    .insert(outboundMessages)
    .values({
      orgId: s.ctx.orgId,
      actionType: input.actionType,
      mode: input.mode,
      status: input.status,
      holdReason: input.holdReason,
      toAddresses: input.toAddresses,
      subject: input.subject,
      body: input.body,
      attachments: input.attachments ?? [],
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { message: inserted, created: true };

  if (!input.dedupeKey) throw new Error('outbound insert returned nothing without a dedupe key');
  const [existing] = await s.db
    .select()
    .from(outboundMessages)
    .where(and(eq(outboundMessages.orgId, s.ctx.orgId), eq(outboundMessages.dedupeKey, input.dedupeKey)));
  if (!existing) throw new Error('outbound dedupe conflict but no existing row');

  if (existing.status === 'shadow' && input.status !== 'shadow') {
    const [promoted] = await s.db
      .update(outboundMessages)
      .set({
        mode: input.mode,
        status: input.status,
        holdReason: input.holdReason,
        toAddresses: input.toAddresses,
        subject: input.subject,
        body: input.body,
        attachments: input.attachments ?? [],
        updatedAt: new Date(),
      })
      .where(and(eq(outboundMessages.id, existing.id), eq(outboundMessages.status, 'shadow')))
      .returning();
    if (promoted) return { message: promoted, created: true };

    const [current] = await s.db.select().from(outboundMessages).where(eq(outboundMessages.id, existing.id));
    return { message: current ?? existing, created: false };
  }
  return { message: existing, created: false };
}

export async function getOutbound(s: Scope, id: string): Promise<OutboundMessageRow | undefined> {
  const [row] = await s.db
    .select()
    .from(outboundMessages)
    .where(and(eq(outboundMessages.id, id), eq(outboundMessages.orgId, s.ctx.orgId)));
  return row;
}

export async function listOutbound(
  s: Scope,
  opts: { status?: string | undefined; limit?: number | undefined } = {},
): Promise<OutboundMessageRow[]> {
  return s.db
    .select()
    .from(outboundMessages)
    .where(
      opts.status
        ? and(eq(outboundMessages.orgId, s.ctx.orgId), eq(outboundMessages.status, opts.status))
        : eq(outboundMessages.orgId, s.ctx.orgId),
    )
    .orderBy(desc(outboundMessages.createdAt))
    .limit(opts.limit ?? 100);
}

/**
 * Atomically move a message from `from` to `sending`. Returns undefined if
 * it was not in that state — someone else already claimed it, or it was
 * rejected — which is what makes a double-approve, or an approve racing a
 * reject, send at most once.
 */
export async function claimForSending(
  s: Scope,
  id: string,
  from: 'pending_approval',
  decidedByUserId: string,
): Promise<OutboundMessageRow | undefined> {
  return withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .update(outboundMessages)
      .set({ status: 'sending', decidedByUserId, decidedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(outboundMessages.id, id),
          eq(outboundMessages.orgId, tx.ctx.orgId),
          eq(outboundMessages.status, from),
        ),
      )
      .returning();
    if (!row) return undefined;

    await recordEvent(tx, 'outbound.approved', {
      subjectId: row.id,
      payload: { actionType: row.actionType, to: row.toAddresses.join(', ') },
    });
    return row;
  });
}

export async function markOutboundSent(
  s: Scope,
  id: string,
  providerMessageId: string | null,
  /** What actually went out, with sizes and checksums — the record of it, not the draft's guess. */
  attachments?: StoredOutboundAttachment[],
): Promise<OutboundMessageRow> {
  return withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .update(outboundMessages)
      .set({
        status: 'sent',
        providerMessageId,
        sentAt: new Date(),
        error: null,
        ...(attachments ? { attachments } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(outboundMessages.id, id), eq(outboundMessages.orgId, tx.ctx.orgId)))
      .returning();
    if (!row) throw new OutboundStateError('not_found', `outbound message ${id} not found`);

    await recordEvent(tx, 'outbound.sent', {
      subjectId: row.id,
      payload: { actionType: row.actionType, to: row.toAddresses.join(', '), subject: row.subject },
    });
    return row;
  });
}

export async function markOutboundFailed(s: Scope, id: string, error: string): Promise<OutboundMessageRow> {
  return withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .update(outboundMessages)
      .set({ status: 'failed', error, updatedAt: new Date() })
      .where(and(eq(outboundMessages.id, id), eq(outboundMessages.orgId, tx.ctx.orgId)))
      .returning();
    if (!row) throw new OutboundStateError('not_found', `outbound message ${id} not found`);

    await recordEvent(tx, 'outbound.failed', {
      subjectId: row.id,
      payload: { actionType: row.actionType, to: row.toAddresses.join(', '), error },
    });
    return row;
  });
}

export async function rejectOutbound(
  s: Scope,
  id: string,
  decidedByUserId: string,
): Promise<OutboundMessageRow | undefined> {
  return withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .update(outboundMessages)
      .set({ status: 'rejected', decidedByUserId, decidedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(outboundMessages.id, id),
          eq(outboundMessages.orgId, tx.ctx.orgId),
          eq(outboundMessages.status, 'pending_approval'),
        ),
      )
      .returning();
    if (!row) return undefined;

    await recordEvent(tx, 'outbound.rejected', {
      subjectId: row.id,
      payload: { actionType: row.actionType, to: row.toAddresses.join(', ') },
    });
    return row;
  });
}

/**
 * Attach a note to a message that already succeeded — used when the email
 * went out but something that should follow it did not. The status stays
 * `sent`: the email is a fact, and it must not read as a failure a retry
 * could act on.
 */
export async function annotateOutbound(s: Scope, id: string, note: string): Promise<void> {
  await s.db
    .update(outboundMessages)
    .set({ error: note, updatedAt: new Date() })
    .where(and(eq(outboundMessages.id, id), eq(outboundMessages.orgId, s.ctx.orgId)));
}

// --- turning an action off ---------------------------------------------------

/**
 * Remove an action's setting entirely. **Off is not `shadow`**: shadow is
 * "recorded, never sent", which is a row and a loop that visits and drafts.
 * Off is no row, and the autopilot loop only visits a carrier that has
 * explicitly set an action — so this is the one way to make the system stop
 * even *drafting*. A hard delete rather than the soft-delete the other
 * tables use, because `getOutboundSettings` reads rows directly and a
 * lingering deleted one would read as still set.
 */
export async function clearAutonomyMode(s: Scope, actionType: string): Promise<void> {
  await withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .delete(autonomySettings)
      .where(and(eq(autonomySettings.orgId, tx.ctx.orgId), eq(autonomySettings.actionType, actionType)))
      .returning({ id: autonomySettings.id });
    if (!row) return;
    await recordEvent(tx, 'outbound.mode_changed', { subjectId: row.id, payload: { actionType, mode: 'off' } });
  });
}

// --- the approval queue --------------------------------------------------------

/** How many drafts are waiting on a person, right now. */
export async function countPendingOutbound(s: Scope): Promise<number> {
  const [row] = await s.db
    .select({ n: count() })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.orgId, s.ctx.orgId), eq(outboundMessages.status, 'pending_approval')));
  return row?.n ?? 0;
}

/**
 * Tell the carrier there is something to approve. One event per call — the
 * caller decides the granularity (the autopilot loop calls it once per org
 * per pass) — and the event's outbox topic is what turns it into an email
 * to whoever can approve. Records nothing if `count` is zero.
 */
export async function raiseAwaitingApproval(s: Scope, count: number): Promise<void> {
  if (count <= 0) return;
  await withTransaction(s, async (tx) => {
    const waiting = await countPendingOutbound(tx);
    await recordEvent(tx, 'outbound.awaiting_approval', {
      subjectId: tx.ctx.orgId,
      payload: { count, waiting },
    });
  });
}

/**
 * Withdraw drafts that have gone out of date. Only `pending_approval` rows
 * for one action, created before `cutoff` — a message a person has already
 * decided on, or that has already gone out, is a fact and is never touched.
 * Returns how many were withdrawn.
 */
export async function expirePendingOutbound(s: Scope, actionType: string, cutoff: Date): Promise<number> {
  return withTransaction(s, async (tx) => {
    const rows = await tx.db
      .update(outboundMessages)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(
        and(
          eq(outboundMessages.orgId, tx.ctx.orgId),
          eq(outboundMessages.actionType, actionType),
          eq(outboundMessages.status, 'pending_approval'),
          lt(outboundMessages.createdAt, cutoff),
        ),
      )
      .returning();
    for (const row of rows) {
      await recordEvent(tx, 'outbound.expired', {
        subjectId: row.id,
        payload: { actionType: row.actionType, to: row.toAddresses.join(', '), subject: row.subject },
      });
    }
    return rows.length;
  });
}

/**
 * Move one draft to `expired`, if and only if it is still waiting. Used at
 * approval time, so a stale draft cannot be approved before the loop's next
 * pass gets to it.
 */
export async function expireOutboundIfPending(s: Scope, id: string): Promise<boolean> {
  return withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .update(outboundMessages)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(
        and(
          eq(outboundMessages.id, id),
          eq(outboundMessages.orgId, tx.ctx.orgId),
          eq(outboundMessages.status, 'pending_approval'),
        ),
      )
      .returning();
    if (!row) return false;
    await recordEvent(tx, 'outbound.expired', {
      subjectId: row.id,
      payload: { actionType: row.actionType, to: row.toAddresses.join(', '), subject: row.subject },
    });
    return true;
  });
}

export type { StoredOutboundAttachment } from '../schema/outbound.ts';
