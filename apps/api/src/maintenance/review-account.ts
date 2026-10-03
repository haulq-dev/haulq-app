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
 * sign-in reaches only one: the row whose Clerk id is the live Clerk user's.
 * With more than one row, `user` (that Clerk id, from the Clerk dashboard) is
 * required to apply, and that row is the one made a member of the kept
 * carrier, joining it if it held a different row's carrier. The first version
 * guessed the row and promoted one no sign-in reached, then retired the
 * carriers the real one was in.
 *
 * Nothing is written without `apply`; the plan is printed either way.
 */

import { randomUUID } from 'node:crypto';
import {
  accountMemberships,
  activateOrg,
  changeRole,
  ensureMembership,
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
  /** Which user row signs in: its Clerk id (`user_...`) or the start of its HaulQ id. */
  user?: string;
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
  const day = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');
  o.log(`${o.email}: ${accounts.length} login(s), newest first`);
  for (const a of accounts) o.log(`  user ${short(a.id)}  clerk ${a.externalAuthId}  created ${day(a.createdAt)}`);
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

  let target = accounts.length === 1 ? accounts[0] : undefined;
  if (o.user) {
    const matches = accounts.filter((a) => a.externalAuthId === o.user || a.id.startsWith(o.user!));
    if (matches.length !== 1) {
      o.log(`\n--user ${o.user} matches ${matches.length} of those logins. Use the Clerk id (user_...) exactly. Nothing done.`);
      return { ok: false };
    }
    target = matches[0];
  }
  if (!target) {
    o.log(`\nThis email has ${accounts.length} logins and a sign-in reaches only one. Find the user in the Clerk dashboard and pass its id: --user user_... Nothing done.`);
    return { ok: false };
  }
  const held = memberships.find((m) => m.orgId === keep.orgId && m.userId === target.id);

  o.log(`\nPlan${o.apply ? '' : ' (dry run: add --apply to do it)'}:`);
  o.log(
    held
      ? `  keep "${keep.orgName}", user ${short(target.id)} as ${o.role}${held.role === o.role ? ' (already)' : ` (now ${held.role})`}`
      : `  keep "${keep.orgName}", adding user ${short(target.id)} (${target.externalAuthId}) to it as ${o.role}`,
  );
  if (keep.orgStatus !== 'active') o.log(`  mark "${keep.orgName}" active (now ${keep.orgStatus}), with no subscription behind it`);
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
  if (!held) {
    await ensureMembership(db, { orgId: keep.orgId, userId: target.id, role: o.role });
    o.log(`Added user ${short(target.id)} to "${keep.orgName}" as ${o.role}.`);
  } else if (held.role !== o.role) {
    await changeRole(s, { userId: target.id, role: o.role }, 'owner');
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