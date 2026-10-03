/**
 * Operator maintenance: reads and writes an admin runs by hand, from the
 * Render Shell, that no product screen offers. Kept here because this package
 * is the only one that touches the ORM.
 *
 * First need (2026-10-02): the App Store review login owned four empty trial
 * carriers it created during the old in-app sign-up. Its "Which account?"
 * picker then offered five near-identical "Demo" names, four of which open
 * "Account not active". `retireEmptyOrg` hides such a carrier.
 */

import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.ts';
import { loads } from '../schema/loads.ts';
import { orgMemberships, orgs, users } from '../schema/tenancy.ts';

export interface AccountMembership {
  /** Which of the email's user rows holds this membership. */
  userId: string;
  orgId: string;
  orgName: string;
  orgStatus: string;
  role: string;
  /** Active members of the carrier, this login included. */
  memberCount: number;
  loadCount: number;
  /** A Stripe subscription is on file. Active without one is a manual comp. */
  hasSubscription: boolean;
}

export interface EmailUser {
  id: string;
  /** Clerk `user_...`: what a sign-in actually resolves to. */
  externalAuthId: string;
  email: string;
  createdAt: Date;
}

/**
 * Every user row with this email, newest first. Clerk can give one person
 * more than one: a deleted and re-made account, or a second sign-in method.
 * Only one is the account a sign-in reaches now, and only the Clerk id says
 * which: compare `externalAuthId` with the user in the Clerk dashboard.
 * (Not `last_seen_at`: nothing writes it.)
 */
export async function usersByEmail(db: Database, email: string): Promise<EmailUser[]> {
  return db
    .select({ id: users.id, externalAuthId: users.externalAuthId, email: users.email, createdAt: users.createdAt })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
    .orderBy(sql`${users.createdAt} desc`);
}

/**
 * Make a user an active member of a carrier with this role, whether or not
 * they had a membership there. For an operator putting a login into a
 * carrier by hand; the product's own way in is an invitation.
 */
export async function ensureMembership(db: Database, args: { orgId: string; userId: string; role: 'owner' | 'dispatcher' | 'driver' | 'accountant' }): Promise<void> {
  const now = new Date();
  await db
    .insert(orgMemberships)
    .values({ orgId: args.orgId, userId: args.userId, role: args.role, status: 'active', acceptedAt: now })
    .onConflictDoUpdate({
      target: [orgMemberships.orgId, orgMemberships.userId],
      set: { role: args.role, status: 'active', acceptedAt: now, updatedAt: now },
    });
}

/** The carriers these logins actively belong to, not deleted, with what's in them. */
export async function accountMemberships(db: Database, userIds: readonly string[]): Promise<AccountMembership[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({
      userId: orgMemberships.userId,
      orgId: orgs.id,
      orgName: orgs.name,
      orgStatus: orgs.status,
      role: orgMemberships.role,
      subscriptionId: orgs.stripeSubscriptionId,
    })
    .from(orgMemberships)
    .innerJoin(orgs, eq(orgs.id, orgMemberships.orgId))
    .where(and(inArray(orgMemberships.userId, [...userIds]), eq(orgMemberships.status, 'active'), isNull(orgs.deletedAt)));

  const out: AccountMembership[] = [];
  for (const r of rows) {
    const [members] = await db
      .select({ n: count() })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, r.orgId), eq(orgMemberships.status, 'active')));
    const [loadRows] = await db.select({ n: count() }).from(loads).where(eq(loads.orgId, r.orgId));
    const { subscriptionId, ...rest } = r;
    out.push({
      ...rest,
      orgStatus: String(r.orgStatus),
      role: String(r.role),
      memberCount: Number(members?.n ?? 0),
      loadCount: Number(loadRows?.n ?? 0),
      hasSubscription: subscriptionId !== null,
    });
  }
  return out;
}

/** Carriers, not deleted, whose name is exactly `nameOrIdPrefix` or whose id starts with it. */
export async function findOrgs(db: Database, nameOrIdPrefix: string): Promise<{ orgId: string; orgName: string; orgStatus: string }[]> {
  const rows = await db
    .select({ orgId: orgs.id, orgName: orgs.name, orgStatus: orgs.status })
    .from(orgs)
    .where(and(isNull(orgs.deletedAt), sql`(${orgs.name} = ${nameOrIdPrefix} or ${orgs.id}::text like ${`${nameOrIdPrefix.replace(/[%_\\]/g, '')}%`})`));
  return rows.map((r) => ({ ...r, orgStatus: String(r.orgStatus) }));
}

export interface RetireRules {
  /** Retire a carrier that has loads. Off by default: loads are real work. */
  includeLoads?: boolean;
  /** Retire an active carrier with no Stripe subscription (a manual comp). */
  includeComped?: boolean;
}

/** Why a carrier can't be retired, or null when it can. */
export function retireRefusal(
  m: Pick<AccountMembership, 'orgStatus' | 'loadCount' | 'memberCount' | 'hasSubscription'>,
  rules: RetireRules = {},
): string | null {
  if (m.hasSubscription && m.orgStatus !== 'cancelled') return 'it has a Stripe subscription';
  if (m.orgStatus === 'active' && !rules.includeComped) return 'it is active (comped: no subscription)';
  if (m.loadCount > 0 && !rules.includeLoads) return `it has ${m.loadCount} load(s)`;
  if (m.memberCount > 1) return `it has ${m.memberCount} members`;
  return null;
}

/**
 * Hide an empty, unpaid carrier: a soft delete (`deleted_at`), so every row
 * stays and it can be brought back by clearing the column. It stops appearing
 * in anyone's carrier list (`orgsForUser` skips deleted orgs). Re-checks the
 * same rules as `retireRefusal` inside the write, so a carrier that gained a
 * load or a member since the plan was printed is left alone.
 */
export async function retireEmptyOrg(db: Database, orgId: string, rules: RetireRules = {}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .select({ status: orgs.status, deletedAt: orgs.deletedAt, subscriptionId: orgs.stripeSubscriptionId })
      .from(orgs)
      .where(eq(orgs.id, orgId));
    if (!org || org.deletedAt) return false;
    const [members] = await tx
      .select({ n: count() })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.status, 'active')));
    const [loadRows] = await tx.select({ n: count() }).from(loads).where(eq(loads.orgId, orgId));
    const facts = {
      orgStatus: String(org.status),
      loadCount: Number(loadRows?.n ?? 0),
      memberCount: Number(members?.n ?? 0),
      hasSubscription: org.subscriptionId !== null,
    };
    if (retireRefusal(facts, rules)) return false;
    await tx.update(orgs).set({ deletedAt: new Date() }).where(eq(orgs.id, orgId));
    return true;
  });
}

/**
 * Mark one carrier active with no subscription behind it: a manual comp, by
 * an operator, for a demo carrier such as App Review's. Only `active` gets
 * past the paywall (`SubscriptionGate`, `REQUIRE_ACTIVE_SUBSCRIPTION`).
 * Billing webhooks reach an org through its Stripe customer, so one with no
 * subscription stays as set here.
 */
export async function activateOrg(db: Database, orgId: string): Promise<void> {
  await db.update(orgs).set({ status: 'active' }).where(eq(orgs.id, orgId));
}
