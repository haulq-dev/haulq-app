/**
 * Get a login ready for App Store review: make it a member that sees every
 * screen in the carrier the reviewer should use, and hide the other carriers
 * it would otherwise have to choose between.
 *
 * Written 2026-10-02 for `emmanuel234432@gmail.com`, which had five user rows
 * and owned four trial carriers (two of them named just "Demo") left over
 * from the removed in-app sign-up. Every one was `trialing`, and only
 * `active` gets past the paywall, so each opened "Account not active".
 *
 * What it does, per carrier the login belongs to:
 *  - the one to keep: change the login's role (default owner, so Pay's money
 *    controls show) and withdraw any invitation still pending to that email;
 *    with `activate`, also mark it active (a manual comp: only `active` gets
 *    past the paywall, and a trial never does);
 *  - any other carrier: retire it (soft delete) if it is unpaid and has no
 *    other members, and no loads unless `includeLoads`; otherwise leave it
 *    and say why.
 *
 * The same email can have several user rows (see `usersByEmail`), and a
 * sign-in reaches only one. The listing shows which row holds each carrier
 * and when each row was last seen, so the kept carrier is one the reviewer's
 * sign-in actually reaches.
 *
 * Nothing is written without `apply`; the plan is printed either way.
 */

import { randomUUID } from 'node:crypto';
import {
  accountMemberships,
  activateOrg,
  changeRole,
  listInvitations,
  retireEmptyOrg,
  retireRefusal,
  revokeInvitation,
  scope,
  usersByEmail,
  type Database,
} from '@haulq/db';

type Role = 'owner' | 'dispatcher' | 'driver' | 'accountant';

export interface ReviewAccountOptions {
  email: string;
  /** The carrier to keep: its exact name, or the start of its id. */
  keep: string;
  role: Role;
  /** Mark the kept carrier active if it isn't. */
  activate?: boolean;
  /** Retire other carriers even if they have loads. */
  includeLoads?: boolean;
  apply: boolean;
  log: (line: string) => void;
}

export async function prepareReviewAccount(db: Database, o: ReviewAccountOptions): Promise<{ ok: boolean }> {
  const accounts = await usersByEmail(db, o.email);
  if (accounts.length === 0) {
    o.log(`No HaulQ login uses ${o.email}.`);
    return { ok: false };
  }
  const userIds = accounts.map((a) => a.id);
  const memberships = await accountMemberships(db, userIds);
  const short = (id: string) => id.slice(0, 8);
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : 'never');
  o.log(`${o.email}: ${accounts.length} login(s), most recently seen first`);
  for (const a of accounts) o.log(`  user ${short(a.id)}  created ${day(a.createdAt)}  last seen ${day(a.lastSeenAt)}`);
  o.log(`${memberships.length} carrier(s):`);
  for (const m of memberships) {
    o.log(`  ${m.orgId}  "${m.orgName}"  ${m.orgStatus}  as ${m.role} (user ${short(m.userId)})  · ${m.memberCount} member(s), ${m.loadCount} load(s)`);
  }
  const rules = { includeLoads: o.includeLoads ?? false };

  const keeps = memberships.filter((m) => m.orgName === o.keep || m.orgId.startsWith(o.keep));
  if (keeps.length !== 1) {
    o.log(
      keeps.length === 0
        ? `\nNo carrier called "${o.keep}" (or with an id starting ${o.keep}) among those. Nothing done.`
        : `\n"${o.keep}" matches ${keeps.length} carriers. Use an id prefix instead. Nothing done.`,
    );
    return { ok: false };
  }
  const keep = keeps[0]!;
  if (keep.orgStatus !== 'active' && !o.activate) {
    o.log(`\n"${keep.orgName}" is ${keep.orgStatus}, not active, so the reviewer would still see "Account not active". Add --activate to mark it active. Nothing done.`);
    return { ok: false };
  }

  o.log(`\nPlan${o.apply ? '' : ' (dry run: add --apply to do it)'}:`);
  o.log(`  keep "${keep.orgName}", as ${o.role}${keep.role === o.role ? ' (already)' : ` (now ${keep.role})`}`);
  if (keep.orgStatus !== 'active') o.log(`  mark "${keep.orgName}" active (now ${keep.orgStatus}), with no subscription behind it`);
  if (keep.userId !== accounts[0]!.id) {
    o.log(`  note: "${keep.orgName}" is held by user ${short(keep.userId)}, not the most recently seen one (${short(accounts[0]!.id)})`);
  }
  const others = memberships.filter((m) => m.orgId !== keep.orgId);
  for (const m of others) {
    const refusal = retireRefusal(m, rules);
    o.log(refusal ? `  leave "${m.orgName}" (${m.orgId}): ${refusal}` : `  retire "${m.orgName}" (${m.orgId})`);
  }

  const s = scope(db, {
    orgId: keep.orgId,
    actor: { type: 'system', name: 'prepare-review-account' },
    correlationId: randomUUID(),
  });
  const pending = (await listInvitations(s, { limit: 200 })).items.filter((i) => i.email.toLowerCase() === o.email.trim().toLowerCase());
  for (const i of pending) o.log(`  withdraw the pending ${i.role} invitation to ${i.email}`);

  if (!o.apply) return { ok: true };

  if (keep.orgStatus !== 'active') {
    await activateOrg(db, keep.orgId);
    o.log(`\nMarked "${keep.orgName}" active.`);
  }
  if (keep.role !== o.role) {
    await changeRole(s, { userId: keep.userId, role: o.role }, 'owner');
    o.log(`Role set to ${o.role} in "${keep.orgName}".`);
  }
  for (const i of pending) {
    await revokeInvitation(s, i.id);
    o.log(`Withdrew the invitation to ${i.email}.`);
  }
  for (const m of others) {
    if (retireRefusal(m, rules)) continue;
    const done = await retireEmptyOrg(db, m.orgId, rules);
    o.log(done ? `Retired "${m.orgName}".` : `Left "${m.orgName}": it changed since the plan was printed.`);
  }
  o.log('\nDone. Signing in now opens straight into the kept carrier.');
  return { ok: true };
}