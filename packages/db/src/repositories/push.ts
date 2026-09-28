/**
 * Push devices and preferences. See `schema/push.ts` for why these are keyed
 * to the user and hard-deleted.
 *
 * These take a `Database`, not a `Scope`: a device belongs to a person across
 * every carrier they act in, the same shape `orgsForUser` takes. Which org's
 * alerts reach them is decided by the caller, from membership.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.ts';
import { pushDevices, pushPreferences } from '../schema/push.ts';

export type PushDevice = typeof pushDevices.$inferSelect;

/**
 * Register a phone, or refresh one already known. Called on every launch.
 * The token is unique: if it was someone else's (a shared phone, a new
 * sign-in), it becomes this person's, and a token the push service had
 * given up on is live again because the phone just handed it over fresh.
 */
export async function registerPushDevice(
  db: Database,
  input: { userId: string; token: string; platform: 'ios' | 'android'; appVersion?: string | undefined },
): Promise<PushDevice> {
  const [row] = await db
    .insert(pushDevices)
    .values({
      userId: input.userId,
      token: input.token,
      platform: input.platform,
      appVersion: input.appVersion ?? null,
    })
    .onConflictDoUpdate({
      target: pushDevices.token,
      set: {
        userId: input.userId,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        lastSeenAt: sql`now()`,
        disabledAt: null,
        disabledReason: null,
      },
    })
    .returning();
  if (!row) throw new Error('push device upsert returned nothing');
  return row;
}

/**
 * Forget a phone, on sign-out. Only this person's own token: a stale app
 * signing out can't remove the device from whoever has it now.
 * Returns whether anything was removed.
 */
export async function unregisterPushDevice(db: Database, userId: string, token: string): Promise<boolean> {
  const removed = await db
    .delete(pushDevices)
    .where(and(eq(pushDevices.token, token), eq(pushDevices.userId, userId)))
    .returning({ id: pushDevices.id });
  return removed.length > 0;
}

/** The push service says this token is dead. Never sent to again unless the phone registers it afresh. */
export async function disablePushDevice(db: Database, token: string, reason: string): Promise<void> {
  await db
    .update(pushDevices)
    .set({ disabledAt: sql`now()`, disabledReason: reason })
    .where(eq(pushDevices.token, token));
}

/**
 * The live phones of these people that should get this category: not
 * disabled, and the person hasn't muted it.
 */
export async function pushTargets(db: Database, userIds: readonly string[], category: string): Promise<PushDevice[]> {
  if (userIds.length === 0) return [];
  const [devices, prefs] = await Promise.all([
    db
      .select()
      .from(pushDevices)
      .where(and(inArray(pushDevices.userId, [...userIds]), isNull(pushDevices.disabledAt))),
    db.select().from(pushPreferences).where(inArray(pushPreferences.userId, [...userIds])),
  ]);
  const muted = new Set(prefs.filter((p) => p.muted.includes(category)).map((p) => p.userId));
  return devices.filter((d) => !muted.has(d.userId));
}

export async function getPushPreferences(db: Database, userId: string): Promise<{ muted: string[] }> {
  const [row] = await db.select().from(pushPreferences).where(eq(pushPreferences.userId, userId));
  return { muted: row?.muted ?? [] };
}

export async function setPushPreferences(db: Database, userId: string, muted: readonly string[]): Promise<{ muted: string[] }> {
  const unique = [...new Set(muted)];
  const [row] = await db
    .insert(pushPreferences)
    .values({ userId, muted: unique })
    .onConflictDoUpdate({ target: pushPreferences.userId, set: { muted: unique, updatedAt: sql`now()` } })
    .returning();
  return { muted: row?.muted ?? unique };
}
