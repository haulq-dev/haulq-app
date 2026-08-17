/**
 * Members and invitations, end to end.
 *
 * The invitation token is a credential — it grants access to a carrier's
 * financial records — so the tests that matter most here are the ones about
 * what must *not* work: a revoked link, an expired one, a dispatcher granting
 * ownership, a carrier removing their only owner.
 *
 * Skips without DATABASE_URL.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  expireInvitationForTest,
  pendingOutboxTopics,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let app: FastifyInstance;
let ownerId: string;
const createdOrgs: string[] = [];
const createdUsers: string[] = [];

const as = (orgId: string, userId = ownerId, extra: Record<string, string> = {}) => ({
  'x-haulq-org-id': orgId,
  'x-haulq-user-id': userId,
  ...extra,
});

async function newOrg(name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/orgs',
    headers: { 'x-haulq-user-id': ownerId },
    payload: { name, contactEmail: 'owner@example.com' },
  });
  const id = res.json().org.id as string;
  createdOrgs.push(id);
  return id;
}

async function newUser() {
  const u = await createTestUser(app.db);
  createdUsers.push(u.id);
  return u;
}

async function invite(orgId: string, email: string, role = 'driver', actor = ownerId) {
  return app.inject({
    method: 'POST',
    url: '/v1/members/invites',
    headers: as(orgId, actor),
    payload: { email, role },
  });
}

const accept = (token: string, userId: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/invitations/${token}/accept`,
    headers: { 'x-haulq-user-id': userId },
  });

suite('members', () => {
  before(async () => {
    app = await buildServer(
      loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }),
    );
    ownerId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    for (const id of createdUsers) await destroyTestUser(app.db, id);
    await destroyTestUser(app.db, ownerId);
    await app.close();
  });

  // --- the happy path ------------------------------------------------------

  describe('inviting and accepting', () => {
    it('takes someone from invited to a working member', async () => {
      const orgId = await newOrg('Invite Co');
      const driver = await newUser();

      const invited = await invite(orgId, 'ray@example.com', 'dispatcher');
      assert.equal(invited.statusCode, 201);
      const token = invited.json().token as string;

      const preview = await app.inject({
        method: 'GET',
        url: `/v1/invitations/${token}`,
      });
      assert.equal(preview.statusCode, 200);
      assert.equal(preview.json().orgName, 'Invite Co');
      assert.equal(preview.json().role, 'dispatcher');

      const accepted = await accept(token, driver.id);
      assert.equal(accepted.statusCode, 200);
      assert.equal(accepted.json().orgId, orgId);

      // The membership is real: they can now use the account.
      const trucks = await app.inject({
        method: 'GET',
        url: '/v1/trucks',
        headers: as(orgId, driver.id),
      });
      assert.equal(trucks.statusCode, 200);
    });

    it('shows the invitation before sign-in, without authentication', async () => {
      // The recipient needs to see who is asking before deciding to create an
      // account at all. Nothing is disclosed that the token holder lacks.
      const orgId = await newOrg('Preview Co');
      const token = (await invite(orgId, 'someone@example.com')).json().token;

      const res = await app.inject({ method: 'GET', url: `/v1/invitations/${token}` });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().orgName, 'Preview Co');
    });

    it('lists members and pending invitations together', async () => {
      const orgId = await newOrg('Listing Co');
      await invite(orgId, 'pending@example.com');

      const res = await app.inject({
        method: 'GET',
        url: '/v1/members',
        headers: as(orgId),
      });
      const body = res.json();

      assert.equal(body.members.length, 1, 'the founder');
      assert.equal(body.members[0].role, 'owner');
      assert.equal(body.invitations.length, 1);
      assert.equal(body.invitations[0].email, 'pending@example.com');
    });

    it('never returns the token hash', async () => {
      const orgId = await newOrg('Hash Co');
      await invite(orgId, 'x@example.com');

      const res = await app.inject({
        method: 'GET',
        url: '/v1/members',
        headers: as(orgId),
      });
      assert.equal(JSON.stringify(res.json()).includes('tokenHash'), false);
    });
  });

  // --- what must not work --------------------------------------------------

  describe('token handling', () => {
    it('refuses a token that was never issued', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/invitations/not-a-real-token',
      });
      assert.equal(res.statusCode, 404);
      assert.match(res.json().explanation, /not valid/);
    });

    it('refuses a revoked invitation', async () => {
      const orgId = await newOrg('Revoke Co');
      const invited = await invite(orgId, 'gone@example.com');
      const { token, invitation } = invited.json();

      const revoked = await app.inject({
        method: 'DELETE',
        url: `/v1/members/invites/${invitation.id}`,
        headers: as(orgId),
      });
      assert.equal(revoked.statusCode, 204);

      const user = await newUser();
      const res = await accept(token, user.id);
      assert.equal(res.statusCode, 410);
      assert.match(res.json().explanation, /withdrawn/);
    });

    it('refuses an expired invitation', async () => {
      const orgId = await newOrg('Expiry Co');
      const invited = await invite(orgId, 'slow@example.com');
      await expireInvitationForTest(app.db, invited.json().invitation.id);

      const user = await newUser();
      const res = await accept(invited.json().token, user.id);
      assert.equal(res.statusCode, 410);
      assert.match(res.json().explanation, /expired/);
    });

    it('cannot be accepted twice', async () => {
      const orgId = await newOrg('Once Co');
      const token = (await invite(orgId, 'once@example.com')).json().token;
      const first = await newUser();
      const second = await newUser();

      assert.equal((await accept(token, first.id)).statusCode, 200);

      const again = await accept(token, second.id);
      assert.equal(again.statusCode, 409);
      assert.match(again.json().explanation, /already been used/);
    });

    it('supersedes the previous link when someone is re-invited', async () => {
      // Two live links for one address means the older still works after the
      // newer is revoked.
      const orgId = await newOrg('Resend Co');
      const first = (await invite(orgId, 'again@example.com')).json().token;
      const second = (await invite(orgId, 'again@example.com')).json().token;

      assert.notEqual(first, second);

      const user = await newUser();
      const stale = await accept(first, user.id);
      assert.equal(stale.statusCode, 410, 'the first link is dead');

      assert.equal((await accept(second, user.id)).statusCode, 200);
    });

    it('requires sign-in to accept', async () => {
      const orgId = await newOrg('Anon Co');
      const token = (await invite(orgId, 'anon@example.com')).json().token;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/invitations/${token}/accept`,
      });
      assert.equal(res.statusCode, 401);
    });

    it('will not let an agent join a carrier', async () => {
      // Guardrail 5 at the one place there is no tenant for the usual check.
      const orgId = await newOrg('Agent Co');
      const token = (await invite(orgId, 'bot@example.com')).json().token;
      const user = await newUser();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/invitations/${token}/accept`,
        headers: {
          'x-haulq-user-id': user.id,
          'x-haulq-agent': 'claude-haiku-4-5-20251001',
        },
      });
      assert.equal(res.statusCode, 401);
    });
  });

  // --- privilege -----------------------------------------------------------

  describe('privilege', () => {
    it('refuses a dispatcher inviting an owner', async () => {
      // A dispatcher who can mint owners has granted themselves a path to full
      // control of the carrier's finances.
      const orgId = await newOrg('Escalation Co');
      const dispatcher = await newUser();
      const token = (await invite(orgId, 'd@example.com', 'dispatcher')).json().token;
      await accept(token, dispatcher.id);

      const res = await invite(orgId, 'newowner@example.com', 'owner', dispatcher.id);
      assert.equal(res.statusCode, 403);
      assert.match(res.json().explanation, /Only an owner can invite another owner/);
    });

    it('lets a dispatcher invite a driver', async () => {
      const orgId = await newOrg('Delegation Co');
      const dispatcher = await newUser();
      const token = (await invite(orgId, 'd2@example.com', 'dispatcher')).json().token;
      await accept(token, dispatcher.id);

      const res = await invite(orgId, 'driver@example.com', 'driver', dispatcher.id);
      assert.equal(res.statusCode, 201);
    });

    it('refuses a driver inviting anyone', async () => {
      const orgId = await newOrg('Driver Invite Co');
      const driver = await newUser();
      const token = (await invite(orgId, 'dr@example.com', 'driver')).json().token;
      await accept(token, driver.id);

      const res = await invite(orgId, 'x@example.com', 'driver', driver.id);
      assert.equal(res.statusCode, 403);
    });

    it('refuses a dispatcher changing roles', async () => {
      const orgId = await newOrg('Role Change Co');
      const dispatcher = await newUser();
      const token = (await invite(orgId, 'd3@example.com', 'dispatcher')).json().token;
      await accept(token, dispatcher.id);

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/members/${dispatcher.id}`,
        headers: as(orgId, dispatcher.id),
        payload: { role: 'owner' },
      });
      assert.equal(res.statusCode, 403);
    });
  });

  // --- the lockout guard ---------------------------------------------------

  describe('last owner', () => {
    it('refuses to remove the only owner', async () => {
      // A one-click way for a carrier to lose their own account, with no screen
      // anywhere that could fix it.
      const orgId = await newOrg('Lockout Co');

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/members/${ownerId}`,
        headers: as(orgId),
      });
      assert.equal(res.statusCode, 409);
      assert.match(res.json().explanation, /only owner/);
    });

    it('refuses to demote the only owner', async () => {
      const orgId = await newOrg('Demote Co');

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/members/${ownerId}`,
        headers: as(orgId),
        payload: { role: 'dispatcher' },
      });
      assert.equal(res.statusCode, 409);
      assert.match(res.json().explanation, /Make someone else an owner first/);
    });

    it('allows it once a second owner exists', async () => {
      const orgId = await newOrg('Succession Co');
      const successor = await newUser();
      const token = (await invite(orgId, 'second@example.com', 'owner')).json().token;
      await accept(token, successor.id);

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/members/${ownerId}`,
        headers: as(orgId),
        payload: { role: 'dispatcher' },
      });
      assert.equal(res.statusCode, 200);
    });
  });

  // --- membership changes --------------------------------------------------

  describe('changing membership', () => {
    it('removes access immediately', async () => {
      const orgId = await newOrg('Removal Co');
      const member = await newUser();
      const token = (await invite(orgId, 'temp@example.com', 'dispatcher')).json().token;
      await accept(token, member.id);

      assert.equal(
        (await app.inject({ method: 'GET', url: '/v1/trucks', headers: as(orgId, member.id) }))
          .statusCode,
        200,
      );

      await app.inject({
        method: 'DELETE',
        url: `/v1/members/${member.id}`,
        headers: as(orgId),
      });

      // The dev authenticator does not check memberships, so this asserts the
      // membership row is gone rather than that the request is refused —
      // ClerkAuthenticator's own tests cover the refusal.
      const members = await app.inject({
        method: 'GET',
        url: '/v1/members',
        headers: as(orgId),
      });
      const emails = (members.json().members as Array<{ userId: string }>).map(
        (m) => m.userId,
      );
      assert.ok(!emails.includes(member.id));
    });

    it('refuses to invite someone already on the account', async () => {
      const orgId = await newOrg('Duplicate Co');
      const member = await newUser();
      const token = (await invite(orgId, member.email, 'driver')).json().token;
      await accept(token, member.id);

      const res = await invite(orgId, member.email, 'driver');
      assert.equal(res.statusCode, 409);
      assert.match(res.json().explanation, /already on this account/);
    });
  });

  // --- audit ---------------------------------------------------------------

  describe('the timeline', () => {
    it('records the invitation, the join and the removal', async () => {
      const orgId = await newOrg('Audit Co');
      const member = await newUser();
      const token = (await invite(orgId, 'audited@example.com', 'driver')).json().token;
      await accept(token, member.id);
      await app.inject({
        method: 'DELETE',
        url: `/v1/members/${member.id}`,
        headers: as(orgId),
      });

      const timeline = await app.inject({
        method: 'GET',
        url: '/v1/timeline?subjectType=org',
        headers: as(orgId),
      });
      const text = (timeline.json().items as Array<{ explanation: string }>)
        .map((i) => i.explanation)
        .join('\n');

      assert.match(text, /Invited audited@example\.com to join as driver\./);
      assert.match(text, /joined the account as driver/);
      assert.match(text, /Removed .* from the account\./);
    });

    it('records when someone joins with a different address than was invited', async () => {
      // The token is the authority, so this is allowed — carriers forward
      // invitations constantly. The audit trail carries the residual risk,
      // which is what it is for.
      const orgId = await newOrg('Mismatch Co');
      const member = await newUser();
      const token = (await invite(orgId, 'work@example.com', 'driver')).json().token;

      const res = await accept(token, member.id);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().emailMismatch, true);

      const timeline = await app.inject({
        method: 'GET',
        url: '/v1/timeline?subjectType=org',
        headers: as(orgId),
      });
      const entry = (timeline.json().items as Array<{ explanation: string }>)[0]!;
      assert.match(entry.explanation, /using an invitation sent to work@example\.com/);
    });

    it('queues the invitation email in the same transaction', async () => {
      // The member.invited event carries an outbox topic, so nothing is sent
      // for an invitation that rolled back.
      const orgId = await newOrg('Outbox Co');
      await invite(orgId, 'queued@example.com');

      const topics = await pendingOutboxTopics(app.db, orgId);
      assert.ok(topics.includes('member.invite_email'));
    });
  });

  // --- org switching -------------------------------------------------------

  describe('GET /v1/orgs', () => {
    it('lists every account a person can act in', async () => {
      const member = await newUser();
      const a = await newOrg('Carrier One');
      const b = await newOrg('Carrier Two');

      for (const orgId of [a, b]) {
        const token = (await invite(orgId, member.email, 'driver')).json().token;
        await accept(token, member.id);
      }

      const res = await app.inject({
        method: 'GET',
        url: '/v1/orgs',
        headers: { 'x-haulq-user-id': member.id },
      });

      const names = (res.json().items as Array<{ name: string }>).map((o) => o.name);
      assert.ok(names.includes('Carrier One'));
      assert.ok(names.includes('Carrier Two'));
    });

    it('is empty for someone who belongs to nothing', async () => {
      const stranger = await newUser();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/orgs',
        headers: { 'x-haulq-user-id': stranger.id },
      });
      assert.deepEqual(res.json().items, []);
    });
  });

  // --- isolation -----------------------------------------------------------

  it('does not show one carrier another\'s members', async () => {
    const a = await newOrg('Members A');
    const b = await newOrg('Members B');
    await invite(a, 'only-in-a@example.com');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/members',
      headers: as(b),
    });
    const emails = (res.json().invitations as Array<{ email: string }>).map((i) => i.email);
    assert.ok(!emails.includes('only-in-a@example.com'));
  });

  it('refuses to revoke another carrier\'s invitation', async () => {
    const a = await newOrg('Revoke A');
    const b = await newOrg('Revoke B');
    const invitationId = (await invite(a, 'theirs@example.com')).json().invitation.id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/members/invites/${invitationId}`,
      headers: as(b),
    });
    assert.equal(res.statusCode, 404);
  });
});
