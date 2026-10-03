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
  setTestOrgStatus,
  testScope,
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
