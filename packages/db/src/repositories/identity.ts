/**
 * Identity: the bridge between Clerk's users and HaulQ's tenancy.
 *
 * ---------------------------------------------------------------------------
 * Clerk owns identity. HaulQ owns tenancy.
 * ---------------------------------------------------------------------------
 *
 * Clerk has an Organizations feature and this codebase deliberately does not
 * use it. ADR-0002 made `orgs` and `org_memberships` the authoritative tenant
 * model — roles, invite state, entitlements and the carrier profile all hang
 * off them — and mirroring that into Clerk would mean two systems believing
 * they own who belongs to what, kept in step by a webhook. The first time they
 * disagree, a carrier is either locked out of their own account or looking at
 * someone else's loads, and there is no obvious source of truth to fix it from.
 *
 * So Clerk answers exactly one question — *which person is this?* — and
 * everything after that is a Postgres lookup against `org_memberships`.
 *
 * A pleasant consequence: the dev stub and Clerk have the same shape. Both
 * establish a person and then resolve the tenant from a header validated
 * against memberships, so the two paths differ only in how the person is
 * proven.
 */

import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.ts';
import { orgMemberships, orgs, users } from '../schema/tenancy.ts';

export type User = typeof users.$inferSelect;

export interface ExternalIdentity {
  /** Clerk `user_...`. */
  externalAuthId: string;
  /**
   * A REAL address, or omitted.
   *
   * Optional because the two callers know different amounts. The webhook always
   * has the verified primary address; a session token only carries one if the
   * Clerk instance is configured to include the claim, and often does not.
   *
   * Never pass a synthesized placeholder here. An earlier version had the
   * authenticator substitute `<sub>@users.clerk.invalid` when the claim was
   * missing, and because this function wrote whatever it was given, every
   * authenticated request overwrote the real address the webhook had just
   * stored. The placeholder then surfaced in member event sentences, which are
   * append-only and cannot be corrected in place.
   */
  email?: string | undefined;
  fullName?: string | undefined;
  phone?: string | undefined;
}

/**
 * The address a brand-new row gets when the caller has none.
 *
 * `users.email` is NOT NULL, and a person can reach the API before the webhook
 * carrying their address arrives. `.invalid` is reserved by RFC 2606 precisely
 * so a placeholder can never collide with, or be mistaken for, a deliverable
 * address. It is replaced by the first caller that knows better.
 */
function placeholderEmail(externalAuthId: string): string {
  return `${externalAuthId}@users.clerk.invalid`;
}

/** True for an address this module minted rather than received. */
export function isPlaceholderEmail(email: string): boolean {
  return email.endsWith('@users.clerk.invalid');
}

/**
 * Find or create the local projection of a Clerk user.
 *
 * Upserts rather than requiring the webhook to have arrived first. Clerk
 * redirects the browser the instant a sign-up completes, and the webhook is a
 * separate HTTP call that may land seconds later or be retried after a failure
 * — so a strict "user must already exist" rule produces an intermittent error
 * on the single most important request a new carrier ever makes.
 *
 * Matching is on `external_auth_id`, never on email. Email is mutable in Clerk
 * and matching on it would let a change of address silently attach a session to
 * a different HaulQ user.
 */
export async function upsertUserFromIdentity(
  db: Database,
  identity: ExternalIdentity,
): Promise<User> {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.externalAuthId, identity.externalAuthId));

  if (existing) {
    // Every field is only written when the caller actually supplied it. Absent
    // is not the same as empty: a session token with no email claim knows
    // nothing about the address, and must not erase what the webhook stored.
    const changed =
      (identity.email !== undefined && existing.email !== identity.email) ||
      (identity.fullName !== undefined && existing.fullName !== identity.fullName) ||
      (identity.phone !== undefined && existing.phone !== identity.phone);

    if (!changed) return existing;

    const [updated] = await db
      .update(users)
      .set({
        ...(identity.email !== undefined ? { email: identity.email } : {}),
        ...(identity.fullName !== undefined ? { fullName: identity.fullName } : {}),
        ...(identity.phone !== undefined ? { phone: identity.phone } : {}),
      })
      .where(eq(users.id, existing.id))
      .returning();
    return updated!;
  }

  const emailForInsert = identity.email ?? placeholderEmail(identity.externalAuthId);

  const [created] = await db
    .insert(users)
    .values({
      externalAuthId: identity.externalAuthId,
      email: emailForInsert,
      fullName: identity.fullName ?? null,
      phone: identity.phone ?? null,
    })
    /*
     * A second concurrent request for the same new user — Clerk's redirect and
     * the webhook arriving together — must not fail. Whichever loses the race
     * reads the winner's row.
     *
     * With a real address, write it: if we lost to a request that only had a
     * placeholder, this upgrades it. With no address of our own, update the
     * conflict key to itself — a deliberate no-op write, not a mistake. It
     * must stay `DO UPDATE` rather than `DO NOTHING`, because `DO NOTHING`
     * returns no row and `created!` would then be undefined at runtime while
     * typechecking perfectly.
     *
     * Both orderings converge on the real address, which is the property that
     * matters.
     */
    .onConflictDoUpdate({
      target: users.externalAuthId,
      set:
        identity.email !== undefined
          ? { email: identity.email }
          : { externalAuthId: identity.externalAuthId },
    })
    .returning();

  return created!;
}

/**
 * Find or create a user by the id a development request asserted.
 *
 * The Clerk path creates the local user on first sight, so a browser redirected
 * straight after sign-up works before the webhook lands. The dev authenticator
 * needs the same property for a different reason: there is no "create user"
 * endpoint — users arrive from Clerk — so a developer or a demo has no way to
 * bring one into existence otherwise.
 *
 * Keeping the two paths behaviourally identical is the point. A stub that
 * cannot do what production does is a stub that hides bugs until switchover.
 */
export async function ensureDevUser(db: Database, userId: string): Promise<User> {
  const [existing] = await db.select().from(users).where(eq(users.id, userId));
  if (existing) return existing;

  const [created] = await db
    .insert(users)
    .values({
      id: userId,
      // Namespaced so a dev row can never collide with a real Clerk subject,
      // and so these are trivially identifiable if one reaches a real database.
      externalAuthId: `dev_${userId}`,
      email: `${userId}@dev.haulq.test`,
    })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  // Lost a race with a concurrent request for the same id.
  const [raced] = await db.select().from(users).where(eq(users.id, userId));
  if (!raced) throw new Error(`could not create dev user ${userId}`);
  return raced;
}

export interface Membership {
  orgId: string;
  role: 'owner' | 'dispatcher' | 'driver' | 'accountant';
}

/**
 * Every org this user can act in.
 *
 * Only `active` memberships. An invited-but-not-accepted row is a pending
 * invitation, not access, and treating it as access would let anyone who has
 * been invited to an org read it before accepting.
 */
export async function membershipsFor(
  db: Database,
  userId: string,
): Promise<Membership[]> {
  const rows = await db
    .select({ orgId: orgMemberships.orgId, role: orgMemberships.role })
    .from(orgMemberships)
    .innerJoin(orgs, eq(orgs.id, orgMemberships.orgId))
    .where(
      and(eq(orgMemberships.userId, userId), eq(orgMemberships.status, 'active')),
    );

  return rows;
}

/** The user's membership in one org, or undefined if they have none. */
export async function membershipIn(
  db: Database,
  userId: string,
  orgId: string,
): Promise<Membership | undefined> {
  const [row] = await db
    .select({ orgId: orgMemberships.orgId, role: orgMemberships.role })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.userId, userId),
        eq(orgMemberships.orgId, orgId),
        eq(orgMemberships.status, 'active'),
      ),
    );
  return row;
}
