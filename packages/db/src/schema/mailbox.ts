/**
 * Mailbox connections — `FEATURE_REQUESTS_PLAN.md` section 1.
 *
 * One connected inbox per org, through Unipile's hosted auth wizard —
 * Unipile holds the actual Google/Microsoft OAuth tokens and rotates them
 * on its own side; what HaulQ needs to keep is the pointer that says which
 * Unipile "account" belongs to which org, so `unipile-inbound.ts`'s
 * new-email webhook can resolve a tenant from `account_id` alone.
 *
 * Deliberately not folded into `board_credentials` even though the shape
 * looks similar (a connected third-party account, org-scoped). That table
 * exists specifically to hold a *secret* — `board_credentials_has_a_secret`
 * enforces it — sealed with `CREDENTIAL_ENCRYPTION_PUBLIC_KEY` because a
 * leaked database must not hand over the ability to act as the connection.
 * Unipile's `account_id` is not that: it is a pointer that is useless to
 * anyone who does not also hold HaulQ's own platform-level `UNIPILE_API_KEY`,
 * and it has to be **queryable in plaintext** — the new-email webhook's
 * entire job is "given this account_id, which org?" — which sealing would
 * make impossible without decrypting every row on every delivery. Forcing
 * it through the secret-shaped table would satisfy neither need well.
 */

import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pk, timestamps } from './_shared.ts';
import { orgs } from './tenancy.ts';

export const mailboxConnections = pgTable(
  'mailbox_connections',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    /** Text, not an enum — same reasoning `board_credentials.board` gives: the set of providers grows on someone else's schedule. */
    provider: text('provider').notNull().default('unipile'),

    /**
     * Unipile's own account id. Null between "connect requested" and "the
     * carrier finished the hosted-auth flow" — `status` carries that gap,
     * not a missing row, because the pending state itself is worth showing
     * ("waiting on you to finish connecting").
     */
    unipileAccountId: text('unipile_account_id'),

    /** 'pending' | 'connected' | 'disconnected'. Text, same reasoning as `board_credentials.status`. */
    status: text('status').notNull().default('pending'),

    /**
     * The kill switch, inverted so the safe state is the default: false
     * until the owner turns sending on, and turning it off again holds
     * every outbound message to shadow instantly. Lives here rather than
     * on `orgs` because sending is a property of *this* connection — a
     * disconnected or replaced mailbox must not inherit an "on" nobody
     * re-confirmed, and `requestMailboxConnection` resets it.
     * `FEATURE_REQUESTS_PLAN.md` section 8.
     */
    sendingEnabled: boolean('sending_enabled').notNull().default(false),

    connectedAt: timestamp('connected_at', { withTimezone: true }),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    /** One connected mailbox per org — reconnecting overwrites rather than adding a second row. */
    uniqueIndex('mailbox_connections_org_key').on(t.orgId),
    index('mailbox_connections_org_idx').on(t.orgId),
    /**
     * What the new-email webhook actually queries by. Partial: many rows sit
     * at `unipileAccountId: null` while pending, and null cannot collide
     * with null in a unique index the way two carriers both being mid-connect
     * would otherwise suggest.
     */
    uniqueIndex('mailbox_connections_account_id_key')
      .on(t.unipileAccountId)
      .where(sql`${t.unipileAccountId} is not null`),
  ],
);
