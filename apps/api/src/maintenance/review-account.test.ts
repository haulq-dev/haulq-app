/**
 * Getting the review login ready, against a real database: the dry run
 * changes nothing; applying promotes the login in the kept carrier, withdraws
 * its pending invitation, retires only the empty unpaid carriers, and leaves
 * any carrier with loads or other members alone.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  accountMemberships,
  addTestMembership,
  closeDatabase,
  createDatabase,
  createLoad,
  createTestOrg,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  getTestUser,
  inviteMember,
  orgsForUser,
  retireRefusal,
  setTestOrgStatus,
  testScope,
  upsertUserFromIdentity,
  type Database,
} from '@haulq/db';
import { prepareReviewAccount } from './review-account.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

suite('prepareReviewAccount', () => {
  let db: Database;
  let reviewer: string;
  let reviewerEmail: string;
  let otherUser: string;
  const orgIds: Record<string, string> = {};
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);

  before(async () => {
    db = createDatabase({ url: url! });
    reviewer = (await createTestUser(db)).id;
    reviewerEmail = (await getTestUser(db, reviewer))!.email;
    otherUser = (await createTestUser(db)).id;

    orgIds.keep = (await createTestOrg(db, 'Demo (test data) review')).id;
    await setTestOrgStatus(db, { orgId: orgIds.keep, status: 'active' });
    await addTestMembership(db, { orgId: orgIds.keep, userId: otherUser, role: 'owner' });
    await inviteMember(testScope(db, orgIds.keep, { type: 'user', id: otherUser }), { email: reviewerEmail, role: 'driver' }, 'owner');
    await addTestMembership(db, { orgId: orgIds.keep, userId: reviewer, role: 'driver' });

    orgIds.empty = (await createTestOrg(db, 'Demo empty trial')).id;
    await addTestMembership(db, { orgId: orgIds.empty, userId: reviewer, role: 'owner' });

    orgIds.withLoad = (await createTestOrg(db, 'Demo trial with a load')).id;
    await addTestMembership(db, { orgId: orgIds.withLoad, userId: reviewer, role: 'owner' });
    await createLoad(testScope(db, orgIds.withLoad, { type: 'user', id: reviewer }), {
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO' },
      ],
    });
  });

  after(async () => {
    for (const id of Object.values(orgIds)) await destroyTestOrg(db, id);
    await destroyTestUser(db, reviewer);
    await destroyTestUser(db, otherUser);
    await closeDatabase(db);
  });

  it('prints the plan and changes nothing on a dry run', async () => {
    const before_ = await accountMemberships(db, [reviewer]);
    const result = await prepareReviewAccount(db, { email: reviewerEmail, keep: 'Demo (test data) review', role: 'owner', apply: false, log });
    assert.equal(result.ok, true);
    assert.ok(lines.some((l) => l.includes('retire "Demo empty trial"')));
    assert.ok(lines.some((l) => l.includes('leave "Demo trial with a load"') && l.includes('load(s)')));
    assert.ok(lines.some((l) => l.includes('withdraw the pending driver invitation')));
    assert.deepEqual(await accountMemberships(db, [reviewer]), before_);
  });

  it('refuses to keep a carrier that is not active', async () => {
    const result = await prepareReviewAccount(db, { email: reviewerEmail, keep: 'Demo empty trial', role: 'owner', apply: true, log });
    assert.equal(result.ok, false);
  });

  it('promotes the login, withdraws the invitation, and retires only the empty trial', async () => {
    const result = await prepareReviewAccount(db, { email: reviewerEmail, keep: 'Demo (test data) review', role: 'owner', apply: true, log });
    assert.equal(result.ok, true);

    const after_ = await accountMemberships(db, [reviewer]);
    const names = after_.map((m) => m.orgName).sort();
    assert.deepEqual(names, ['Demo (test data) review', 'Demo trial with a load']);
    assert.equal(after_.find((m) => m.orgId === orgIds.keep)!.role, 'owner');

    // A second run has nothing left to do.
    lines.length = 0;
    await prepareReviewAccount(db, { email: reviewerEmail, keep: 'Demo (test data) review', role: 'owner', apply: false, log });
    assert.ok(!lines.some((l) => l.includes('withdraw the pending')));
    assert.ok(lines.some((l) => l.includes('as owner (already)')));
  });
});

/**
 * The real review login's shape: every carrier still trialing, two of them
 * with a load each. `--activate` comps the kept one; `--include-loads` lets
 * the other loaded one go too.
 */
suite('prepareReviewAccount with --activate and --include-loads', () => {
  let db: Database;
  let reviewer: string;
  let reviewerEmail: string;
  const orgIds: Record<string, string> = {};
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);

  async function withLoad(name: string) {
    const id = (await createTestOrg(db, name)).id;
    await addTestMembership(db, { orgId: id, userId: reviewer, role: 'owner' });
    await createLoad(testScope(db, id, { type: 'user', id: reviewer }), {
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO' },
      ],
    });
    return id;
  }

  before(async () => {
    db = createDatabase({ url: url! });
    reviewer = (await createTestUser(db)).id;
    reviewerEmail = (await getTestUser(db, reviewer))!.email;
    orgIds.keep = await withLoad('Demo kept');
    orgIds.otherLoaded = await withLoad('Demo other');
    orgIds.empty = (await createTestOrg(db, 'Demo2 empty')).id;
    await addTestMembership(db, { orgId: orgIds.empty, userId: reviewer, role: 'owner' });
  });

  after(async () => {
    for (const id of Object.values(orgIds)) await destroyTestOrg(db, id);
    await destroyTestUser(db, reviewer);
    await closeDatabase(db);
  });

  it('lists each user row and which one holds each carrier', async () => {
    await prepareReviewAccount(db, { email: reviewerEmail, keep: orgIds.keep!.slice(0, 8), role: 'owner', activate: true, apply: false, log });
    assert.ok(lines.some((l) => l.startsWith(`  user ${reviewer.slice(0, 8)}`) && l.includes('clerk user_')));
    assert.ok(lines.some((l) => l.includes('"Demo kept"') && l.includes(`(user ${reviewer.slice(0, 8)})`)));
    assert.ok(lines.some((l) => l.includes('mark "Demo kept" active (now trialing)')));
    assert.ok(lines.some((l) => l.includes('leave "Demo other"') && l.includes('1 load(s)')));
  });

  it('activates the kept carrier and, with --include-loads, retires the loaded one', async () => {
    const result = await prepareReviewAccount(db, {
      email: reviewerEmail,
      keep: orgIds.keep!.slice(0, 8),
      role: 'owner',
      activate: true,
      includeLoads: true,
      apply: true,
      log,
    });
    assert.equal(result.ok, true);

    const left = await accountMemberships(db, [reviewer]);
    assert.deepEqual(
      left.map((m) => ({ name: m.orgName, status: m.orgStatus })),
      [{ name: 'Demo kept', status: 'active' }],
    );
  });
});

/**
 * What went wrong on 2026-10-02: the email had several user rows, the kept
 * carrier was held by a stale one, and the row a sign-in actually reaches
 * lost its only carrier to the retire step. Now the script won't apply
 * without `--user`, and puts that row into the kept carrier.
 */
suite('prepareReviewAccount with several user rows for one email', () => {
  let db: Database;
  let stale: string;
  let live: { id: string; externalAuthId: string };
  let email: string;
  const orgIds: Record<string, string> = {};
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);

  before(async () => {
    db = createDatabase({ url: url! });
    stale = (await createTestUser(db)).id;
    email = (await getTestUser(db, stale))!.email;
    const liveRow = await upsertUserFromIdentity(db, { externalAuthId: `user_live_${stale.slice(0, 8)}`, email });
    live = { id: liveRow.id, externalAuthId: liveRow.externalAuthId };

    orgIds.keep = (await createTestOrg(db, 'Demo held by the stale row')).id;
    await setTestOrgStatus(db, { orgId: orgIds.keep, status: 'active' });
    await addTestMembership(db, { orgId: orgIds.keep, userId: stale, role: 'owner' });
    orgIds.liveTrial = (await createTestOrg(db, 'Demo held by the live row')).id;
    await addTestMembership(db, { orgId: orgIds.liveTrial, userId: live.id, role: 'owner' });
  });

  after(async () => {
    for (const id of Object.values(orgIds)) await destroyTestOrg(db, id);
    await destroyTestUser(db, stale);
    await destroyTestUser(db, live.id);
    await closeDatabase(db);
  });

  it('refuses to guess which row signs in', async () => {
    const result = await prepareReviewAccount(db, { email, keep: orgIds.keep!.slice(0, 8), role: 'owner', apply: true, log });
    assert.equal(result.ok, false);
    assert.ok(lines.some((l) => l.includes(`clerk ${live.externalAuthId}`)));
    assert.ok(lines.some((l) => l.includes('--user user_')));
    assert.equal((await orgsForUser(db, live.id)).length, 1);
  });

  it('puts the --user row into the kept carrier as owner', async () => {
    const result = await prepareReviewAccount(db, {
      email,
      keep: orgIds.keep!.slice(0, 8),
      role: 'owner',
      user: live.externalAuthId,
      apply: true,
      log,
    });
    assert.equal(result.ok, true);
    const orgs = await orgsForUser(db, live.id);
    assert.deepEqual(
      orgs.map((o) => ({ id: o.id, role: o.role, status: o.status })),
      [{ id: orgIds.keep, role: 'owner', status: 'active' }],
    );
  });
});

/**
 * The second fix of 2026-10-02: the reviewer belongs in the well-stocked demo
 * carrier someone else owns, not the one-load carrier it was comped into.
 * `--keep` finds a carrier the login isn't in and adds it; `--include-comped`
 * retires the comped one so the picker doesn't come back.
 */
suite('prepareReviewAccount keeping a carrier the login is not in', () => {
  let db: Database;
  let reviewer: string;
  let email: string;
  let stocker: string;
  const orgIds: Record<string, string> = {};
  const lines: string[] = [];
  const log = (l: string) => lines.push(l);

  before(async () => {
    db = createDatabase({ url: url! });
    reviewer = (await createTestUser(db)).id;
    email = (await getTestUser(db, reviewer))!.email;
    stocker = (await createTestUser(db)).id;

    orgIds.stocked = (await createTestOrg(db, 'Demo (test data) external')).id;
    await setTestOrgStatus(db, { orgId: orgIds.stocked, status: 'active' });
    await addTestMembership(db, { orgId: orgIds.stocked, userId: stocker, role: 'owner' });

    orgIds.comped = (await createTestOrg(db, 'Demo comped')).id;
    await setTestOrgStatus(db, { orgId: orgIds.comped, status: 'active' });
    await addTestMembership(db, { orgId: orgIds.comped, userId: reviewer, role: 'owner' });
    await createLoad(testScope(db, orgIds.comped, { type: 'user', id: reviewer }), {
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO' },
      ],
    });
  });

  after(async () => {
    for (const id of Object.values(orgIds)) await destroyTestOrg(db, id);
    await destroyTestUser(db, reviewer);
    await destroyTestUser(db, stocker);
    await closeDatabase(db);
  });

  it('leaves a comped carrier alone without --include-comped', async () => {
    await prepareReviewAccount(db, { email, keep: orgIds.stocked!.slice(0, 8), role: 'owner', includeLoads: true, apply: false, log });
    assert.ok(lines.some((l) => l.includes('none of these logins is in yet')));
    assert.ok(lines.some((l) => l.includes('adding user') && l.includes('as owner')));
    assert.ok(lines.some((l) => l.includes('leave "Demo comped"') && l.includes('comped')));
  });

  it('adds the login to the kept carrier and retires the comped one', async () => {
    const result = await prepareReviewAccount(db, {
      email,
      keep: orgIds.stocked!.slice(0, 8),
      role: 'owner',
      includeLoads: true,
      includeComped: true,
      apply: true,
      log,
    });
    assert.equal(result.ok, true);
    const orgs = await orgsForUser(db, reviewer);
    assert.deepEqual(
      orgs.map((o) => ({ id: o.id, role: o.role })),
      [{ id: orgIds.stocked, role: 'owner' }],
    );
    assert.equal((await orgsForUser(db, stocker)).length, 1);
  });
});

describe('retireRefusal', () => {
  const base = { orgStatus: 'active', loadCount: 0, memberCount: 1, hasSubscription: true };
  it('never retires a carrier with a Stripe subscription, whatever the flags', () => {
    assert.match(retireRefusal(base, { includeLoads: true, includeComped: true })!, /Stripe subscription/);
  });
  it('retires a comped carrier only with includeComped', () => {
    const comped = { ...base, hasSubscription: false };
    assert.match(retireRefusal(comped)!, /comped/);
    assert.equal(retireRefusal(comped, { includeComped: true }), null);
  });
});
