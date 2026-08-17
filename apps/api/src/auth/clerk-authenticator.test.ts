/**
 * The Clerk authenticator.
 *
 * The token verifier is injected, so everything specific to HaulQ is exercised
 * here against a real database: user projection, org resolution, and the
 * membership check that decides access. What is *not* covered is Clerk's own
 * RS256/JWKS verification, which is why that part is delegated to
 * `@clerk/backend` rather than written here.
 *
 * Skips without DATABASE_URL.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addTestMembership,
  closeDatabase,
  createDatabase,
  createTestOrg,
  destroyTestOrg,
  destroyTestUser,
  getTestUser,
  membershipsFor,
  setTestMembershipRole,
  setTestUserEmail,
  upsertUserFromIdentity,
  type Database,
} from '@haulq/db';
import { AuthenticationError } from './authenticator.ts';
import { ClerkAuthenticator, type SessionClaims } from './clerk-authenticator.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let db: Database;
let orgId: string;
let otherOrgId: string;
let localUserId: string;

const CLERK_USER = 'user_2abcdefghijklmnop';

/** Stands in for Clerk. Real tokens are just JSON here. */
const fakeVerifier = async (token: string): Promise<SessionClaims> => {
  if (token === 'expired') throw new Error('token expired');
  return JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as SessionClaims;
};

const tokenFor = (claims: SessionClaims) =>
  Buffer.from(JSON.stringify(claims)).toString('base64');

const auth = () =>
  new ClerkAuthenticator({ db, secretKey: 'sk_test_x', verifier: fakeVerifier });

const bearer = (claims: SessionClaims, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${tokenFor(claims)}`,
  ...extra,
});

suite('ClerkAuthenticator', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    orgId = (await createTestOrg(db, 'Clerk Test Carrier')).id;
    otherOrgId = (await createTestOrg(db, 'Someone Else')).id;

    const user = await upsertUserFromIdentity(db, {
      externalAuthId: CLERK_USER,
      email: 'j@haulq.ai',
    });
    localUserId = user.id;

    await addTestMembership(db, { orgId, userId: localUserId, role: 'dispatcher' });
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    await destroyTestOrg(db, otherOrgId);
    await destroyTestUser(db, localUserId);
    await closeDatabase(db);
  });

  it('refuses to construct without a secret key', () => {
    assert.throws(
      () => new ClerkAuthenticator({ db, secretKey: '' }),
      /requires CLERK_SECRET_KEY/,
    );
  });

  // --- no credential -------------------------------------------------------

  it('returns null when no token is present', async () => {
    // Null, not a throw. "Not signed in" and "broken session" deserve different
    // responses.
    assert.equal(await auth().authenticate({}), null);
  });

  it('distinguishes an expired session from no session', async () => {
    // An expired token should tell the browser to refresh, not look logged-out
    // and silently bounce someone mid-task.
    await assert.rejects(
      auth().authenticate({ authorization: 'Bearer expired' }),
      (err: unknown) =>
        err instanceof AuthenticationError && /expired or is not valid/.test(err.explanation),
    );
  });

  // --- token extraction ----------------------------------------------------

  it('reads the token from a bearer header', async () => {
    const result = await auth().authenticate(
      bearer({ sub: CLERK_USER, email: 'j@haulq.ai' }, { 'x-haulq-org-id': orgId }),
    );
    assert.equal(result?.actor.type, 'user');
    assert.equal(result?.role, 'dispatcher');
  });

  it('reads the token from Clerk\'s session cookie', async () => {
    // The web app uses the cookie; the mobile app in Phase 2a will use the
    // header. Supporting one now would mean editing this file later.
    const token = tokenFor({ sub: CLERK_USER, email: 'j@haulq.ai' });
    const result = await auth().authenticate({
      cookie: `foo=bar; __session=${token}; other=1`,
      'x-haulq-org-id': orgId,
    });
    assert.equal(result?.orgId, orgId);
  });

  // --- tenancy -------------------------------------------------------------

  it('requires an org to be named', async () => {
    await assert.rejects(
      auth().authenticate(bearer({ sub: CLERK_USER, email: 'j@haulq.ai' })),
      (err: unknown) =>
        err instanceof AuthenticationError && /No account was selected/.test(err.explanation),
    );
  });

  it('refuses an org the user has no membership in', async () => {
    await assert.rejects(
      auth().authenticate(
        bearer({ sub: CLERK_USER, email: 'j@haulq.ai' }, { 'x-haulq-org-id': otherOrgId }),
      ),
      (err: unknown) =>
        err instanceof AuthenticationError && /do not have access/.test(err.explanation),
    );
  });

  it('does not reveal whether an org exists', async () => {
    // Distinguishing "no such org" from "no membership" turns this into a way
    // to test whether an org id is real.
    const missing = '00000000-0000-4000-8000-000000000000';
    const a = await auth()
      .authenticate(bearer({ sub: CLERK_USER, email: 'j@haulq.ai' }, { 'x-haulq-org-id': missing }))
      .catch((e: AuthenticationError) => e.explanation);
    const b = await auth()
      .authenticate(bearer({ sub: CLERK_USER, email: 'j@haulq.ai' }, { 'x-haulq-org-id': otherOrgId }))
      .catch((e: AuthenticationError) => e.explanation);
    assert.equal(a, b);
  });

  it('reads the role from Postgres, not from the token', async () => {
    // A claim baked into a session would keep working until the session
    // refreshed. Revoking someone has to take effect on the next request.
    const claims: SessionClaims = { sub: CLERK_USER, email: 'j@haulq.ai' };

    await setTestMembershipRole(db, { orgId, userId: localUserId, role: 'owner' });
    const result = await auth().authenticate(bearer(claims, { 'x-haulq-org-id': orgId }));
    assert.equal(result?.role, 'owner');

    await setTestMembershipRole(db, { orgId, userId: localUserId, role: 'dispatcher' });
  });

  // --- user projection -----------------------------------------------------

  it('creates the local user on first sight rather than waiting for the webhook', async () => {
    // Clerk redirects the browser the instant sign-up completes; the webhook is
    // a separate call that may land seconds later. Requiring it first produces
    // an intermittent error on a new carrier's most important request.
    const fresh = `user_fresh_${Date.now()}`;
    const result = await auth().authenticateUser(
      bearer({ sub: fresh, email: 'brand.new@example.com' }),
    );

    assert.ok(result);
    const memberships = await membershipsFor(db, result!.actor.id);
    assert.deepEqual(memberships, [], 'a new user belongs to nothing yet');

    await destroyTestUser(db, result!.actor.id);
  });

  it('updates the local record when the email changes in Clerk', async () => {
    await auth().authenticateUser(bearer({ sub: CLERK_USER, email: 'changed@haulq.ai' }));

    const row = await getTestUser(db, localUserId);
    assert.equal(row!.email, 'changed@haulq.ai');

    await setTestUserEmail(db, localUserId, 'j@haulq.ai');
  });

  it('matches on the Clerk id, never on email', async () => {
    // Email is mutable in Clerk. Matching on it would let a change of address
    // silently attach a session to a different HaulQ user.
    const impostor = `user_impostor_${Date.now()}`;
    const result = await auth().authenticateUser(
      bearer({ sub: impostor, email: 'j@haulq.ai' }),
    );
    assert.notEqual(result!.actor.id, localUserId);

    await destroyTestUser(db, result!.actor.id);
  });

  it('signs in without email in the claims rather than failing', async () => {
    // Clerk can be configured not to include it. The webhook fills in the real
    // address; blocking sign-in over a display field would be a poor trade.
    const noEmail = `user_noemail_${Date.now()}`;
    const result = await auth().authenticateUser(bearer({ sub: noEmail }));
    assert.match(result!.actor.email!, /clerk\.invalid$/);

    await destroyTestUser(db, result!.actor.id);
  });
});
