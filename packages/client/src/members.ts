/**
 * People: who can act in the account and who has been asked to. The rules
 * from `apps/web/src/routes/Members.tsx`, shared for the mobile port
 * (MOBILE_PARITY_PLAN.md M4).
 *
 * `packages/db/src/repositories/members.ts` is what refuses. These only
 * decide which controls to show, so the screen never offers something that
 * would bounce, and can say why it isn't offered.
 */

import { canDispatch, canManageMembers } from './access.ts';
import { ROLES, type Invitation, type Member, type Role } from './types.ts';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** `GET /v1/members` pages the two lists independently, with separate cursors. */
export interface MembersPage {
  members: CursorPage<Member>;
  invitations: CursorPage<Invitation>;
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  dispatcher: 'Dispatcher',
  driver: 'Driver',
  accountant: 'Accountant',
};

export const ROLE_HINT: Record<Role, string> = {
  owner: 'Everything, including billing, members and the carrier authority.',
  dispatcher: 'Books loads, manages trucks and drivers. No billing.',
  driver: 'Their own loads and documents.',
  accountant: 'Invoices, settlements and reports. Cannot book.',
};

/** Roles this person may invite someone as. Only an owner can make another owner. */
export function invitableRoles(myRole: string | undefined): Role[] {
  if (!canDispatch(myRole)) return [];
  return ROLES.filter((r) => r !== 'owner' || canManageMembers(myRole));
}

/**
 * What this person may do to one member. The last owner can be neither
 * demoted nor removed: it would leave an account nobody can administer, and
 * no screen could fix it. Nobody removes themselves from here.
 */
export function memberControls(
  member: Pick<Member, 'userId' | 'role'>,
  me: { userId: string | undefined; role: string | undefined },
  ownerCount: number,
): { changeRole: boolean; remove: boolean; lastOwner: boolean } {
  const lastOwner = member.role === 'owner' && ownerCount <= 1;
  const manage = canManageMembers(me.role) && !lastOwner;
  return { changeRole: manage, remove: manage && member.userId !== me.userId, lastOwner };
}

/** How an invitation's expiry reads: "Expired", "Expires today", "3 days left". */
export function invitationExpiry(expiresAt: string, now: number = Date.now()): { label: string; tone: 'bad' | 'warn' | 'neutral' } {
  const left = Math.ceil((new Date(expiresAt).getTime() - now) / 86_400_000);
  if (left < 0) return { label: 'Expired', tone: 'bad' };
  if (left === 0) return { label: 'Expires today', tone: 'warn' };
  return { label: `${left} ${left === 1 ? 'day' : 'days'} left`, tone: left <= 2 ? 'warn' : 'neutral' };
}

/**
 * The link an invitee opens. `/invite/:token` is a page on the web app and a
 * route in the mobile app, so it works whichever the person has.
 */
export function invitationLink(webOrigin: string, token: string): string {
  return `${webOrigin.replace(/\/$/, '')}/invite/${encodeURIComponent(token)}`;
}
