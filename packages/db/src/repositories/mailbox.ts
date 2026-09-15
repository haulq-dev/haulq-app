/**
 * Mailbox connections — `FEATURE_REQUESTS_PLAN.md` section 1.
 *
 * `schema/mailbox.ts`'s module note has the reasoning for why this is a
 * separate table from `board_credentials` rather than a reuse of it: the
 * thing this table stores is a queryable pointer, not a secret, and the
 * new-email webhook's whole job — "given this Unipile `account_id`, which
 * org?" — needs it in plaintext.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../client.ts';
import { scope, type Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { mailboxConnections } from '../schema/mailbox.ts';
import { withTransaction } from '../transaction.ts';

export type MailboxConnection = typeof mailboxConnections.$inferSelect;

export async function getMailboxConnection(s: Scope): Promise<MailboxConnection | undefined> {
  const [row] = await s.db
    .select()
    .from(mailboxConnections)
    .where(eq(mailboxConnections.orgId, s.ctx.orgId));
  return row;
}

/**
 * Start (or restart) a connection. Upserts on `org_id` — one connected
 * mailbox per org, `schema/mailbox.ts`'s own unique index — so clicking
 * "connect" a second time after a disconnect reuses the row rather than
 * accumulating history nobody reads. `unipileAccountId` is cleared back to
 * null: a stale account id from a previous connection must not survive
 * into a new "pending" state, where `markMailboxConnected` below would
 * otherwise have nothing to overwrite it before the webhook arrives.
 */
export async function requestMailboxConnection(s: Scope, provider = 'unipile'): Promise<MailboxConnection> {
  const [row] = await s.db
    .insert(mailboxConnections)
    .values({ orgId: s.ctx.orgId, provider, status: 'pending' })
    .onConflictDoUpdate({
      target: mailboxConnections.orgId,
      set: {
        provider,
        status: 'pending',
        unipileAccountId: null,
        connectedAt: null,
        disconnectedAt: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error('mailbox connection upsert returned nothing');
  return row;
}

/**
 * Look up an org by Unipile's own account id — the only query the new-email
 * webhook actually needs, and the reason this table exists as its own thing
 * rather than living inside `board_credentials`. No `Scope` parameter: this
 * runs before any org is known, the same shape `getOrgBySlug` already uses
 * for `postmark-inbound.ts`'s tenant resolution.
 */
export async function getMailboxConnectionByAccountId(
  db: Database,
  unipileAccountId: string,
): Promise<MailboxConnection | undefined> {
  const [row] = await db
    .select()
    .from(mailboxConnections)
    .where(eq(mailboxConnections.unipileAccountId, unipileAccountId));
  return row;
}

/**
 * Called from `account-notify`, Unipile's server-to-server confirmation
 * that a carrier finished the hosted-auth flow — no user session exists for
 * that request, so this takes `Database` and an explicit `orgId` rather
 * than a `Scope`, the same shape the Motive OAuth callback uses for
 * `storeOAuthCredential`.
 */
export async function markMailboxConnected(
  db: Database,
  args: { orgId: string; unipileAccountId: string },
): Promise<MailboxConnection> {
  const s = scope(db, {
    orgId: args.orgId,
    actor: { type: 'integration', provider: 'unipile' },
    correlationId: randomUUID(),
  });
  return withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .update(mailboxConnections)
      .set({
        unipileAccountId: args.unipileAccountId,
        status: 'connected',
        connectedAt: new Date(),
        disconnectedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(mailboxConnections.orgId, args.orgId))
      .returning();
    if (!row) throw new Error(`mailbox connection for org ${args.orgId} not found — connect was never requested`);

    await recordEvent(tx, 'mailbox_connection.connected', {
      subjectId: row.id,
      payload: { provider: row.provider },
    });

    return row;
  });
}

export async function disconnectMailbox(s: Scope): Promise<void> {
  await withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .update(mailboxConnections)
      .set({ status: 'disconnected', unipileAccountId: null, disconnectedAt: new Date(), updatedAt: new Date() })
      .where(eq(mailboxConnections.orgId, tx.ctx.orgId))
      .returning();
    if (!row) return;

    await recordEvent(tx, 'mailbox_connection.disconnected', {
      subjectId: row.id,
      payload: { provider: row.provider },
    });
  });
}
