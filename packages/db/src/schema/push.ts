/**
 * Push notification devices and preferences. MOBILE_PARITY_PLAN.md section 7.
 *
 * **Keyed to the user, not the org** — an exception to `_shared.ts`'s rule 1,
 * on purpose. A phone belongs to a person, and one person can act in several
 * carriers. Who receives an alert is still decided per org, through
 * membership, exactly as email does (`listAllMembers` in the handler); this
 * table only answers "which phones does that person have".
 *
 * **Hard deletes here**, another deliberate exception (rule 3). A device
 * token is a delivery address, not a business record: nothing in the event
 * log points at one, and keeping a signed-out phone's token around is the
 * opposite of what signing out should do.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { pk } from './_shared.ts';
import { users } from './tenancy.ts';

export const pushDevices = pgTable(
  'push_devices',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    /**
     * The APNs device token (or, later, an FCM token). Unique across users:
     * the same phone signed in as someone else moves the row to them, so a
     * shared cab phone never delivers the last driver's alerts.
     */
    token: text('token').notNull().unique('push_devices_token_key'),
    appVersion: text('app_version'),
    /** Refreshed on every launch. A token not seen for months is a phone that's gone. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().default(sql`now()`),
    /** Set when the push service says the token is dead (APNs 410 / Unregistered). Never retried after. */
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledReason: text('disabled_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index('push_devices_user_idx').on(t.userId),
    check('push_devices_platform_ck', sql`${t.platform} in ('ios', 'android')`),
  ],
);

/**
 * What a person has switched off. Absent row, or a category not in `muted`,
 * means on: operational alerts default on (section 7's "Preferences" row).
 */
export const pushPreferences = pgTable('push_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  muted: text('muted').array().notNull().default(sql`'{}'`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});
