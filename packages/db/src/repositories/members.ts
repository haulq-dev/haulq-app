/**
 * Members and invitations.
 *
 * Two rules run through this file and are worth stating before the code:
 *
 * **An org must always have at least one owner.** Removing or demoting the last
 * one leaves a carrier's account with nobody who can invite anyone, change
 * billing, or reconcile their costs — and no screen anywhere that can fix it.
 * It is a one-click footgun, so it is refused at this layer rather than in the
 * UI, where a second surface would eventually forget.
 *
 * **Only an owner can create another owner.** A dispatcher who can invite is
 * useful; a dispatcher who can invite an *owner* has just granted themselves
 * a path to full control of the carrier's finances.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, count, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { eventOutbox } from '../schema/events.ts';
import { recordEvent } from '../events/record.ts';
import { decodeCursor, toCursorPage, type CursorPage } from '../pagination.ts';
import { orgInvitations, orgMemberships, orgs, users } from '../schema/tenancy.ts';
import { withTransaction } from '../transaction.ts';

export type Role = 'owner' | 'dispatcher' | 'driver' | 'accountant';
export type Invitation = typeof orgInvitations.$inferSelect;

export class MemberError extends Error {
  readonly explanation: string;
  readonly code: string;

  constructor(code: string, message: string, explanation: string) {
    super(message);
    this.name = 'MemberError';
    this.code = code;
    this.explanation = explanation;
  }
}

/** Invitations are good for a week. Long enough for a driver's days off. */
const INVITE_TTL_DAYS = 7;

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface MemberRow {
  userId: string;
  email: string;
  fullName: string | null;
  role: Role;
  acceptedAt: Date | null;
}

export interface ListPageQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** Alphabetical by email, cursor-paginated on `(email, userId)` — see `pagination.ts`. */
export async function listMembers(s: Scope, q: ListPageQuery = {}): Promise<CursorPage<MemberRow>> {
  const conditions = [eq(orgMemberships.orgId, s.ctx.orgId), eq(orgMemberships.status, 'active')];
  if (q.cursor) {
    const cursor = decodeCursor(q.cursor);
    const cursorEmail = String(cursor.v);
    conditions.push(
      or(gt(users.email, cursorEmail), and(eq(users.email, cursorEmail), gt(users.id, cursor.id)))!,
    );
  }

  const limit = Math.min(q.limit ?? 50, 200);
  const rows = await s.db
    .select({
      userId: users.id,
      email: users.email,
      fullName: users.fullName,
      role: orgMemberships.role,
      acceptedAt: orgMemberships.acceptedAt,
    })
    .from(orgMemberships)
    .innerJoin(users, eq(users.id, orgMemberships.userId))
    .where(and(...conditions))
    .orderBy(asc(users.email), asc(users.id))
    .limit(limit);

  return toCursorPage(rows, limit, (row) => ({ v: row.email, id: row.userId }));
}

/** Every active member, not one page — for internal sweeps like the exception-alert outbox handler. */
export async function listAllMembers(s: Scope): Promise<MemberRow[]> {
  const all: MemberRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await listMembers(s, cursor ? { cursor } : {});
    all.push(...page.items);
    if (!page.nextCursor) return all;
    cursor = page.nextCursor;
  }
}

/** Pending invitations. Never returns the token — only its existence. */
export async function listInvitations(
  s: Scope,
  q: ListPageQuery = {},
): Promise<CursorPage<Omit<Invitation, 'tokenHash'>>> {
  const conditions = [
    eq(orgInvitations.orgId, s.ctx.orgId),
    isNull(orgInvitations.acceptedAt),
    isNull(orgInvitations.revokedAt),
  ];
  if (q.cursor) {
    const cursor = decodeCursor(q.cursor);
    const cursorDate = new Date(cursor.v);
    conditions.push(
      or(
        gt(orgInvitations.createdAt, cursorDate),
        and(eq(orgInvitations.createdAt, cursorDate), gt(orgInvitations.id, cursor.id)),
      )!,
    );
  }

  const limit = Math.min(q.limit ?? 50, 200);
  const rows = await s.db
    .select()
    .from(orgInvitations)
    .where(and(...conditions))
    .orderBy(asc(orgInvitations.createdAt), asc(orgInvitations.id))
    .limit(limit);

  const items = rows.map(({ tokenHash: _hash, ...rest }) => rest);
  return toCursorPage(items, limit, (row) => ({ v: row.createdAt.toISOString(), id: row.id }));
}

async function ownerCount(s: Scope): Promise<number> {
  const [row] = await s.db
    .select({ n: count() })
    .from(orgMemberships)
    .where(
      and(
        eq(orgMemberships.orgId, s.ctx.orgId),
        eq(orgMemberships.role, 'owner'),
        eq(orgMemberships.status, 'active'),
      ),
    );
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Inviting
// ---------------------------------------------------------------------------

export interface InviteResult {
  invitation: Omit<Invitation, 'tokenHash'>;
  /**
   * The raw token, returned exactly once.
   *
   * It is never stored and never retrievable again — only its hash is kept, so
   * a leaked database cannot be used to join a carrier's account. Losing the
   * link means re-inviting, which is a button.
   */
  token: string;
}

export async function inviteMember(
  s: Scope,
  input: { email: string; role: Role },
  actorRole: Role,
): Promise<InviteResult> {
  const email = normalizeEmail(input.email);

  if (input.role === 'owner' && actorRole !== 'owner') {
    throw new MemberError(
      'forbidden',
      `${actorRole} attempted to invite an owner`,
      'Only an owner can invite another owner.',
    );
  }

  return withTransaction(s, async (tx) => {
    // Already a member — a different situation from a pending invite, and it
    // deserves its own message rather than a duplicate-key error.
    const [existing] = await tx.db
      .select({ id: users.id })
      .from(orgMemberships)
      .innerJoin(users, eq(users.id, orgMemberships.userId))
      .where(
        and(
          eq(orgMemberships.orgId, tx.ctx.orgId),
          eq(users.email, email),
          eq(orgMemberships.status, 'active'),
        ),
      );

    if (existing) {
      throw new MemberError(
        'already_member',
        `${email} is already a member`,
        `${email} is already on this account.`,
      );
    }

    // Re-inviting supersedes rather than stacking. Two live links for one
    // address means the older one still works after the newer is revoked.
    await tx.db
      .update(orgInvitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(orgInvitations.orgId, tx.ctx.orgId),
          eq(orgInvitations.email, email),
          isNull(orgInvitations.acceptedAt),
          isNull(orgInvitations.revokedAt),
        ),
      );

    // 32 bytes. base64url so it survives being pasted into a URL, an email
    // client, and a text message without re-encoding.
    const token = randomBytes(32).toString('base64url');

    const [row] = await tx.db
      .insert(orgInvitations)
      .values({
        orgId: tx.ctx.orgId,
        email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedByUserId: tx.ctx.actor.type === 'user' ? tx.ctx.actor.id : null,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
      })
      .returning();

    if (!row) throw new Error('invitation insert returned nothing');

    await recordEvent(tx, 'member.invited', {
      subjectId: tx.ctx.orgId,
      payload: { email, role: input.role },
    });

    /**
     * The email, queued by hand rather than by the event catalogue.
     *
     * `member.invited` deliberately has no `topic`, because the audit payload
     * cannot carry the token and the email is useless without it. So the
     * message is enqueued here — still inside this transaction, so it is never
     * sent for an invitation that rolled back and never lost for one that
     * committed, which is the whole point of the outbox.
     *
     * **This row holds a live credential.** That is the accepted cost of
     * sending asynchronously, and it is bounded three ways: the consumer scrubs
     * the payload the moment the send succeeds, the token expires in
     * INVITE_TTL_DAYS regardless, and revoking the invitation invalidates it
     * immediately. The audit log — the thing kept forever — never sees it.
     */
    const [org] = await tx.db
      .select({ name: orgs.name })
      .from(orgs)
      .where(eq(orgs.id, tx.ctx.orgId));

    await tx.db.insert(eventOutbox).values({
      orgId: tx.ctx.orgId,
      topic: 'member.invite_email',
      payload: {
        email,
        role: input.role,
        token,
        orgName: org?.name ?? 'your carrier',
        expiresAt: row.expiresAt.toISOString(),
        invitedByEmail: tx.ctx.actor.type === 'user' ? (tx.ctx.actor.email ?? null) : null,
      },
    });

    const { tokenHash: _hash, ...invitation } = row;
    return { invitation, token };
  });
}

export async function revokeInvitation(s: Scope, id: string): Promise<void> {
  await withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .select()
      .from(orgInvitations)
      .where(
        and(eq(orgInvitations.id, id), eq(orgInvitations.orgId, tx.ctx.orgId)),
      );

    if (!row) {
      throw new MemberError(
        'not_found',
        `invitation ${id} not found`,
        'That invitation no longer exists.',
      );
    }
    if (row.acceptedAt) {
      throw new MemberError(
        'already_accepted',
        'invitation already accepted',
        `${row.email} has already joined. Remove them instead of revoking the invitation.`,
      );
    }
    if (row.revokedAt) return;

    await tx.db
      .update(orgInvitations)
      .set({ revokedAt: new Date() })
      .where(eq(orgInvitations.id, id));

    await recordEvent(tx, 'member.invite_revoked', {
      subjectId: tx.ctx.orgId,
      payload: { email: row.email },
    });
  });
}

// ---------------------------------------------------------------------------
// Accepting
// ---------------------------------------------------------------------------

export interface InvitationPreview {
  orgName: string;
  email: string;
  role: Role;
  expiresAt: Date;
}

/**
 * Look up an invitation by its raw token.
 *
 * Runs without a tenant, because the point is to establish which tenant. Takes
 * the database directly rather than a `Scope` for the same reason.
 *
 * The lookup is by hash, which is a single indexed equality — so this does not
 * leak timing information about which tokens exist the way a scan-and-compare
 * would. `timingSafeEqual` is used anyway on the final comparison; it costs
 * nothing and removes the question.
 */
export async function previewInvitation(
  db: Database,
  token: string,
): Promise<InvitationPreview> {
  const hash = hashToken(token);

  const [row] = await db
    .select({
      invitation: orgInvitations,
      orgName: orgs.name,
    })
    .from(orgInvitations)
    .innerJoin(orgs, eq(orgs.id, orgInvitations.orgId))
    .where(eq(orgInvitations.tokenHash, hash));

  if (!row) {
    throw new MemberError(
      'invalid_token',
      'no invitation for token',
      'That invitation link is not valid. Ask whoever invited you to send a new one.',
    );
  }

  const stored = Buffer.from(row.invitation.tokenHash, 'hex');
  const offered = Buffer.from(hash, 'hex');
  if (stored.length !== offered.length || !timingSafeEqual(stored, offered)) {
    throw new MemberError(
      'invalid_token',
      'token hash mismatch',
      'That invitation link is not valid.',
    );
  }

  if (row.invitation.revokedAt) {
    throw new MemberError(
      'revoked',
      'invitation revoked',
      'That invitation was withdrawn. Ask whoever invited you to send a new one.',
    );
  }
  if (row.invitation.acceptedAt) {
    throw new MemberError(
      'already_accepted',
      'invitation already accepted',
      'That invitation has already been used. Sign in instead.',
    );
  }
  if (row.invitation.expiresAt.getTime() < Date.now()) {
    throw new MemberError(
      'expired',
      'invitation expired',
      'That invitation has expired. Ask whoever invited you to send a new one.',
    );
  }

  return {
    orgName: row.orgName,
    email: row.invitation.email,
    role: row.invitation.role,
    expiresAt: row.invitation.expiresAt,
  };
}

export interface AcceptResult {
  orgId: string;
  role: Role;
  /** True when the person signed in with a different address than was invited. */
  emailMismatch: boolean;
}

/**
 * Accept an invitation.
 *
 * **The token is the authority, not the email.** A person who signed in with an
 * address other than the one invited still joins, and the mismatch is recorded
 * in the timeline with both addresses.
 *
 * That is a deliberate trade. Carriers forward invitations constantly — an
 * owner types the address he has on file, the driver signs up with the personal
 * Gmail he actually reads. Refusing would strand him with no self-service fix,
 * for marginal gain: the token is already an unguessable secret that expires in
 * a week and can be revoked. The audit trail carries the residual risk, which is
 * what it is for.
 *
 * Making it strict is a one-line change here, and the test that documents the
 * current behaviour would fail loudly.
 */
export async function acceptInvitation(
  db: Database,
  args: { token: string; userId: string; userEmail: string; correlationId: string },
): Promise<AcceptResult> {
  const preview = await previewInvitation(db, args.token);
  const hash = hashToken(args.token);

  const [invitation] = await db
    .select()
    .from(orgInvitations)
    .where(eq(orgInvitations.tokenHash, hash));
  if (!invitation) {
    throw new MemberError('invalid_token', 'gone', 'That invitation is no longer valid.');
  }

  const scopeForOrg: Scope = {
    ctx: {
      orgId: invitation.orgId,
      actor: { type: 'user', id: args.userId, email: args.userEmail },
      correlationId: args.correlationId,
    },
    db,
  };

  return withTransaction(scopeForOrg, async (tx) => {
    // The dangerous case this whole block exists for: the person opening
    // the link is already an *active* member of this org — most often the
    // owner themselves, testing or forwarding an invite while still signed
    // in — and the upsert below would silently overwrite their own role
    // with whatever the invitation says. If that role is a demotion and
    // they are the org's only owner, accepting would leave the account
    // with nobody who can invite anyone, change billing, or fix this —
    // exactly the state `changeRole` and `removeMember` already refuse to
    // produce. Checked before the invitation is claimed, so a refusal here
    // does not burn the link — the intended recipient can still use it.
    const [existingMembership] = await tx.db
      .select({ role: orgMemberships.role })
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, invitation.orgId),
          eq(orgMemberships.userId, args.userId),
          eq(orgMemberships.status, 'active'),
        ),
      );

    if (
      existingMembership?.role === 'owner' &&
      invitation.role !== 'owner' &&
      (await ownerCount(tx)) === 1
    ) {
      throw new MemberError(
        'last_owner',
        'accepting would demote the org\'s only owner',
        'You are the only owner on this account. Accepting this invitation would change your own role and leave the account with no owner — make someone else an owner first, or have the intended recipient accept it from their own account.',
      );
    }

    // Re-checked inside the transaction. Two clicks on the same link, or a
    // click racing a revoke, must not produce two memberships.
    const [claimed] = await tx.db
      .update(orgInvitations)
      .set({ acceptedAt: new Date(), acceptedByUserId: args.userId })
      .where(
        and(
          eq(orgInvitations.id, invitation.id),
          isNull(orgInvitations.acceptedAt),
          isNull(orgInvitations.revokedAt),
        ),
      )
      .returning();

    if (!claimed) {
      throw new MemberError(
        'already_accepted',
        'lost the race to claim the invitation',
        'That invitation has already been used.',
      );
    }

    await tx.db
      .insert(orgMemberships)
      .values({
        orgId: invitation.orgId,
        userId: args.userId,
        role: invitation.role,
        status: 'active',
        invitedByUserId: invitation.invitedByUserId,
        invitedAt: invitation.createdAt,
        acceptedAt: new Date(),
      })
      // Already a member of this org in some other capacity — accepting should
      // apply the invited role rather than fail on the unique constraint.
      // (Never the org's last owner losing their role — guarded above.)
      .onConflictDoUpdate({
        target: [orgMemberships.orgId, orgMemberships.userId],
        set: { role: invitation.role, status: 'active', acceptedAt: new Date() },
      });

    const emailMismatch = normalizeEmail(args.userEmail) !== invitation.email;

    await recordEvent(tx, 'member.joined', {
      subjectId: invitation.orgId,
      payload: { email: args.userEmail, role: invitation.role },
      ...(emailMismatch
        ? {
            explanation:
              `${args.userEmail} joined the account as ${invitation.role}, ` +
              `using an invitation sent to ${invitation.email}.`,
          }
        : {}),
    });

    return { orgId: invitation.orgId, role: preview.role, emailMismatch };
  });
}

// ---------------------------------------------------------------------------
// Changing and removing
// ---------------------------------------------------------------------------

export async function changeRole(
  s: Scope,
  args: { userId: string; role: Role },
  actorRole: Role,
): Promise<void> {
  if (args.role === 'owner' && actorRole !== 'owner') {
    throw new MemberError(
      'forbidden',
      `${actorRole} attempted to grant owner`,
      'Only an owner can make someone else an owner.',
    );
  }

  await withTransaction(s, async (tx) => {
    const [membership] = await tx.db
      .select({ role: orgMemberships.role, email: users.email })
      .from(orgMemberships)
      .innerJoin(users, eq(users.id, orgMemberships.userId))
      .where(
        and(
          eq(orgMemberships.orgId, tx.ctx.orgId),
          eq(orgMemberships.userId, args.userId),
          eq(orgMemberships.status, 'active'),
        ),
      );

    if (!membership) {
      throw new MemberError(
        'not_found',
        `no membership for ${args.userId}`,
        'That person is not on this account.',
      );
    }
    if (membership.role === args.role) return;

    if (membership.role === 'owner' && (await ownerCount(tx)) === 1) {
      throw new MemberError(
        'last_owner',
        'refusing to demote the last owner',
        'This is the only owner on the account. Make someone else an owner first.',
      );
    }

    await tx.db
      .update(orgMemberships)
      .set({ role: args.role })
      .where(
        and(
          eq(orgMemberships.orgId, tx.ctx.orgId),
          eq(orgMemberships.userId, args.userId),
        ),
      );

    await recordEvent(tx, 'member.role_changed', {
      subjectId: tx.ctx.orgId,
      payload: { email: membership.email, from: membership.role, to: args.role },
    });
  });
}

export async function removeMember(s: Scope, userId: string): Promise<void> {
  await withTransaction(s, async (tx) => {
    const [membership] = await tx.db
      .select({ role: orgMemberships.role, email: users.email })
      .from(orgMemberships)
      .innerJoin(users, eq(users.id, orgMemberships.userId))
      .where(
        and(
          eq(orgMemberships.orgId, tx.ctx.orgId),
          eq(orgMemberships.userId, userId),
          eq(orgMemberships.status, 'active'),
        ),
      );

    if (!membership) {
      throw new MemberError(
        'not_found',
        `no membership for ${userId}`,
        'That person is not on this account.',
      );
    }

    if (membership.role === 'owner' && (await ownerCount(tx)) === 1) {
      throw new MemberError(
        'last_owner',
        'refusing to remove the last owner',
        'This is the only owner on the account. Make someone else an owner before removing this one.',
      );
    }

    // Deleted rather than suspended. `org_memberships` is the access model, not
    // a record of who was ever here — the event log is that, and it keeps the
    // removal with its actor and timestamp.
    await tx.db
      .delete(orgMemberships)
      .where(
        and(
          eq(orgMemberships.orgId, tx.ctx.orgId),
          eq(orgMemberships.userId, userId),
        ),
      );

    await recordEvent(tx, 'member.removed', {
      subjectId: tx.ctx.orgId,
      payload: { email: membership.email },
    });
  });
}

// ---------------------------------------------------------------------------
// Org switching
// ---------------------------------------------------------------------------

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

/**
 * The orgs a person can act in.
 *
 * The web app needs this immediately after sign-in: a session establishes who
 * someone is, and this answers which account they are working in. A driver who
 * moves between two carriers on the platform has two entries here and one login.
 */
export async function orgsForUser(db: Database, userId: string): Promise<OrgSummary[]> {
  return db
    .select({
      id: orgs.id,
      name: orgs.name,
      slug: orgs.slug,
      role: orgMemberships.role,
    })
    .from(orgMemberships)
    .innerJoin(orgs, eq(orgs.id, orgMemberships.orgId))
    .where(
      and(
        eq(orgMemberships.userId, userId),
        eq(orgMemberships.status, 'active'),
        isNull(orgs.deletedAt),
      ),
    )
    .orderBy(asc(orgs.name));
}

/** Expire stale invitations. Housekeeping for a scheduled job. */
export async function expireStaleInvitations(db: Database): Promise<number> {
  const rows = await db
    .update(orgInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        isNull(orgInvitations.acceptedAt),
        isNull(orgInvitations.revokedAt),
        sql`${orgInvitations.expiresAt} < now()`,
      ),
    )
    .returning({ id: orgInvitations.id });
  return rows.length;
}
