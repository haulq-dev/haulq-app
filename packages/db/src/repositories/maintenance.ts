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
  orgId: string;
  orgName: string;
  orgStatus: string;
  role: string;
  /** Active members of the carrier, this login included. */
  memberCount: number;
  loadCount: number;
}

/** Every user row with this email. Clerk can give one person more than one. */
export async function usersByEmail(db: Database, email: string): Promise<{ id: string; email: string }[]> {
  return db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`);
}

/** The carriers these logins actively belong to, not deleted, with what's in them. */
export async function accountMemberships(db: Database, userIds: readonly string[]): Promise<AccountMembership[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ orgId: orgs.id, orgName: orgs.name, orgStatus: orgs.status, role: orgMemberships.role })
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
    out.push({ ...r, orgStatus: String(r.orgStatus), role: String(r.role), memberCount: Number(members?.n ?? 0), loadCount: Number(loadRows?.n ?? 0) });
  }
  return out;
}

/** Why a carrier can't be retired, or null when it can. */
export function retireRefusal(m: Pick<AccountMembership, 'orgStatus' | 'loadCount' | 'memberCount'>): string | null {
  if (m.orgStatus === 'active') return 'it has an active subscription';
  if (m.loadCount > 0) return `it has ${m.loadCount} load(s)`;
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
export async function retireEmptyOrg(db: Database, orgId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [org] = await tx.select({ status: orgs.status, deletedAt: orgs.deletedAt }).from(orgs).where(eq(orgs.id, orgId));
    if (!org || org.deletedAt) return false;
    const [members] = await tx
      .select({ n: count() })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.status, 'active')));
    const [loadRows] = await tx.select({ n: count() }).from(loads).where(eq(loads.orgId, orgId));
    if (retireRefusal({ orgStatus: String(org.status), loadCount: Number(loadRows?.n ?? 0), memberCount: Number(members?.n ?? 0) })) return false;
    await tx.update(orgs).set({ deletedAt: new Date() }).where(eq(orgs.id, orgId));
    return true;
  });
}
