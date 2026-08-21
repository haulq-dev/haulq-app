/**
 * Onboarding, profile and operating facts, end to end.
 *
 * The bootstrap path gets the most attention because it is the only route that
 * runs without a tenant, and a partial signup is unrecoverable from the UI: an
 * org with no owner cannot be reached by the person who just created it.
 *
 * Skips without DATABASE_URL.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addTestMembership,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let app: FastifyInstance;
let userId: string;
const createdOrgs: string[] = [];
const driverIds: string[] = [];

/** Signs up a carrier and remembers the org for teardown. */
async function signUp(name: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/orgs',
    headers: { 'x-haulq-user-id': userId },
    payload: { name, contactEmail: 'owner@example.com', ...extra },
  });
  if (res.statusCode === 201) createdOrgs.push(res.json().org.id);
  return res;
}

const as = (orgId: string, extra: Record<string, string> = {}) => ({
  'x-haulq-org-id': orgId,
  'x-haulq-user-id': userId,
  ...extra,
});

suite('onboarding', () => {
  before(async () => {
    app = await buildServer(
      loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }),
    );
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    for (const id of driverIds) await destroyTestUser(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  // --- the bootstrap -------------------------------------------------------

  describe('POST /v1/orgs', () => {
    it('creates the org, profile, membership and events together', async () => {
      const res = await signUp('Prairie Freight LLC', { mcNumber: 'MC-123456' });
      assert.equal(res.statusCode, 201);

      const { org, profile } = res.json();
      assert.equal(org.name, 'Prairie Freight LLC');
      assert.equal(org.status, 'trialing');
      assert.match(org.slug, /^prairie-freight-llc-[0-9a-f]{6}$/);
      // "MC-123456" normalized on the way in, so FMCSA lookups and broker
      // joins have one format to deal with.
      assert.equal(profile.mcNumber, '123456');

      // The owner can immediately act inside the org they just made — which is
      // the thing a partial signup would break.
      const timeline = await app.inject({
        method: 'GET',
        url: '/v1/timeline',
        headers: as(org.id),
      });
      const verbs = (timeline.json().items as Array<{ verb: string }>).map(
        (i) => i.verb,
      );
      assert.deepEqual(verbs.sort(), ['member.joined', 'org.created']);
    });

    it('gives two carriers with the same name different slugs', async () => {
      const a = await signUp('Midwest Freight');
      const b = await signUp('Midwest Freight');
      assert.equal(a.statusCode, 201);
      assert.equal(b.statusCode, 201);
      assert.notEqual(a.json().org.slug, b.json().org.slug);
    });

    it('refuses an unauthenticated signup', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orgs',
        payload: { name: 'Nobody', contactEmail: 'a@b.com' },
      });
      assert.equal(res.statusCode, 401);
    });

    it('refuses to let an agent create an account', async () => {
      // Guardrail 5, at the one place the usual check has no tenant to run in.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orgs',
        headers: {
          'x-haulq-user-id': userId,
          'x-haulq-agent': 'claude-haiku-4-5-20251001',
        },
        payload: { name: 'Robot Freight', contactEmail: 'a@b.com' },
      });
      assert.equal(res.statusCode, 401);
      assert.match(res.json().explanation, /needs a person/);
    });

    it('explains a bad MC number rather than storing it', async () => {
      const res = await signUp('Bad Docket', { mcNumber: 'MC-1' });
      assert.equal(res.statusCode, 400);
    });
  });

  // --- profile -------------------------------------------------------------

  describe('carrier profile', () => {
    it('records only the fields that changed', async () => {
      const orgId = (await signUp('Change Tracking Co')).json().org.id;

      await app.inject({
        method: 'PATCH',
        url: '/v1/org/profile',
        headers: as(orgId),
        payload: { dbaName: 'CTC Logistics', city: 'Wichita', state: 'ks' },
      });

      const timeline = await app.inject({
        method: 'GET',
        url: '/v1/timeline?subjectType=org',
        headers: as(orgId),
      });
      const entry = (timeline.json().items as Array<{ explanation: string }>)[0]!;

      assert.match(entry.explanation, /dbaName/);
      assert.match(entry.explanation, /city/);
      // legalName was not in the request and must not appear.
      assert.doesNotMatch(entry.explanation, /legalName/);

      const profile = await app.inject({
        method: 'GET',
        url: '/v1/org/profile',
        headers: as(orgId),
      });
      assert.equal(profile.json().state, 'KS', 'state upper-cased on the way in');
    });

    it("carries the org's slug, for the HaulQ Docs inbound address", async () => {
      // slug lives on orgs, not carrier_profiles — this is the join that makes
      // it visible here, and it is what the web app builds
      // docs+{slug}@docs.haulq.ai from.
      const signedUp = await signUp('Slug Visibility Co');
      const orgId = signedUp.json().org.id;
      const orgSlug = signedUp.json().org.slug;

      const profile = await app.inject({
        method: 'GET',
        url: '/v1/org/profile',
        headers: as(orgId),
      });
      assert.equal(profile.json().slug, orgSlug);
    });

    it('writes no event when nothing actually changed', async () => {
      // A timeline of noise is a timeline nobody reads, which defeats
      // guardrail 6 as thoroughly as having no log.
      const orgId = (await signUp('No-op Co')).json().org.id;

      const before_ = await app.inject({
        method: 'GET',
        url: '/v1/timeline?subjectType=org',
        headers: as(orgId),
      });
      await app.inject({
        method: 'PATCH',
        url: '/v1/org/profile',
        headers: as(orgId),
        payload: { legalName: 'No-op Co' },
      });
      const after_ = await app.inject({
        method: 'GET',
        url: '/v1/timeline?subjectType=org',
        headers: as(orgId),
      });

      assert.equal(after_.json().items.length, before_.json().items.length);
    });
  });

  // --- operating facts -----------------------------------------------------

  describe('operating facts', () => {
    it('refuses to save an impossible cost, and says why', async () => {
      const orgId = (await signUp('Impossible Costs')).json().org.id;

      const res = await app.inject({
        method: 'PUT',
        url: '/v1/org/operating-facts',
        headers: as(orgId),
        payload: { costPerMileCents: 40, fuelPricePerGallonCents: 400, avgMpg: 8 },
      });

      assert.equal(res.json().saved, false);
      assert.match(res.json().explanation, /fuel alone/);
    });

    it('saves an unusual figure and returns the warning with it', async () => {
      // The asymmetry that makes this usable: errors block, warnings inform.
      const orgId = (await signUp('Unusual But Real')).json().org.id;

      const res = await app.inject({
        method: 'PUT',
        url: '/v1/org/operating-facts',
        headers: as(orgId),
        payload: { costPerMileCents: 50, fixedWeeklyCostCents: 80_000 },
      });

      assert.equal(res.json().saved, true);
      assert.ok(res.json().issues.some((i: { severity: string }) => i.severity === 'warning'));
    });

    it('merges across sittings instead of blanking what is absent', async () => {
      // Carriers fill these in twice — once at signup, once after the import
      // gives them real numbers. A replacing PUT would erase the first half.
      const orgId = (await signUp('Two Sittings')).json().org.id;

      await app.inject({
        method: 'PUT',
        url: '/v1/org/operating-facts',
        headers: as(orgId),
        payload: { costPerMileCents: 140 },
      });
      await app.inject({
        method: 'PUT',
        url: '/v1/org/operating-facts',
        headers: as(orgId),
        payload: { fixedWeeklyCostCents: 90_000 },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/org/operating-facts',
        headers: as(orgId),
      });
      assert.equal(res.json().facts.costPerMileCents, 140);
      assert.equal(res.json().facts.fixedWeeklyCostCents, 90_000);
      assert.equal(res.json().completeForScoring, true);
    });

    it('says in the timeline whether scoring is now using real figures', async () => {
      const orgId = (await signUp('Partial Facts')).json().org.id;

      await app.inject({
        method: 'PUT',
        url: '/v1/org/operating-facts',
        headers: as(orgId),
        payload: { costPerMileCents: 140 },
      });

      const timeline = await app.inject({
        method: 'GET',
        url: '/v1/timeline?subjectType=org',
        headers: as(orgId),
      });
      const entry = (timeline.json().items as Array<{ explanation: string }>)[0]!;
      assert.match(entry.explanation, /still use defaults/);
    });

    it('returns warnings on read, not only after an edit', async () => {
      // A bad number entered six months ago should warn every time the screen
      // is opened, not stay silent until someone touches it.
      const orgId = (await signUp('Stale Warning')).json().org.id;
      await app.inject({
        method: 'PUT',
        url: '/v1/org/operating-facts',
        headers: as(orgId),
        payload: { costPerMileCents: 50, fixedWeeklyCostCents: 0 },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/org/operating-facts',
        headers: as(orgId),
      });
      assert.ok(res.json().issues.length >= 2);
    });

    it('refuses a driver from changing the numbers', async () => {
      const orgId = (await signUp('Role Check')).json().org.id;

      // A real driver membership rather than a role header — the dev
      // authenticator reads the role from org_memberships, so a header on a
      // user who is actually the owner would be overridden.
      const driver = await createTestUser(app.db);
      driverIds.push(driver.id);
      await addTestMembership(app.db, { orgId, userId: driver.id, role: 'driver' });

      const res = await app.inject({
        method: 'PUT',
        url: '/v1/org/operating-facts',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': driver.id },
        payload: { costPerMileCents: 1 },
      });
      assert.equal(res.statusCode, 403);
    });
  });

  // --- checklist -----------------------------------------------------------

  describe('GET /v1/onboarding', () => {
    it('starts with only the identity step outstanding for a new signup', async () => {
      const orgId = (await signUp('Fresh Start', { mcNumber: '654321' })).json().org
        .id;

      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding',
        headers: as(orgId),
      });
      const status = res.json();

      assert.equal(status.ready, false);
      assert.equal(status.totalRequired, 3);
      // Identity is satisfied by the MC number given at signup.
      const identity = status.steps.find((s: { id: string }) => s.id === 'identity');
      assert.equal(identity.done, true);
    });

    it('says what each incomplete step is costing them', async () => {
      // The parity bar is not a progress bar. A carrier needs to know that
      // skipping capabilities silently hides loads.
      const orgId = (await signUp('Consequences')).json().org.id;
      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding',
        headers: as(orgId),
      });

      const capabilities = res
        .json()
        .steps.find((s: { id: string }) => s.id === 'capabilities');
      assert.equal(capabilities.done, false);
      assert.match(capabilities.consequence, /may be hidden/);
      assert.ok(capabilities.unlocks.length > 0, 'unlocks is present even when undone');
    });

    it('becomes ready once identity, a truck and costs are in', async () => {
      const orgId = (await signUp('Ready Co', { usdotNumber: '1234567' })).json().org
        .id;

      await app.inject({
        method: 'POST',
        url: '/v1/trucks',
        headers: as(orgId),
        payload: { label: 'Unit 1', capabilities: { liftgate: true } },
      });
      await app.inject({
        method: 'PUT',
        url: '/v1/org/operating-facts',
        headers: as(orgId),
        payload: { costPerMileCents: 140, fixedWeeklyCostCents: 85_000 },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/onboarding',
        headers: as(orgId),
      });
      const status = res.json();

      assert.equal(status.ready, true);
      assert.equal(status.completedRequired, 3);
      // Still false: nothing has been checked against real loads. That is the
      // Phase 0 exit gate and it is deliberately not part of `ready`.
      assert.equal(status.factsReconciled, false);
    });
  });

  // --- drivers -------------------------------------------------------------

  describe('drivers', () => {
    it('creates a driver with endorsements and logs it', async () => {
      const orgId = (await signUp('Driver Co')).json().org.id;

      const res = await app.inject({
        method: 'POST',
        url: '/v1/drivers',
        headers: as(orgId),
        payload: { fullName: 'Ray Mendez', endorsements: ['twic', 'hazmat'] },
      });

      assert.equal(res.statusCode, 201);
      assert.deepEqual(res.json().endorsements, ['twic', 'hazmat']);

      const timeline = await app.inject({
        method: 'GET',
        url: '/v1/timeline?subjectType=driver',
        headers: as(orgId),
      });
      assert.match(
        (timeline.json().items as Array<{ explanation: string }>)[0]!.explanation,
        /Added driver Ray Mendez/,
      );
    });

    it('surfaces a medical card about to lapse', async () => {
      // An expired medical card is a load that cannot be covered, not a
      // paperwork problem.
      const orgId = (await signUp('Expiring Co')).json().org.id;
      const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

      await app.inject({
        method: 'POST',
        url: '/v1/drivers',
        headers: as(orgId),
        payload: { fullName: 'Dale Cooper', medicalCardExpiresAt: soon },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/drivers/expiring?days=30',
        headers: as(orgId),
      });
      assert.equal(res.json().items.length, 1);
      assert.equal(res.json().items[0].what, 'medical_card');
    });

    it('rejects an unknown endorsement', async () => {
      const orgId = (await signUp('Bad Endorsement')).json().org.id;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/drivers',
        headers: as(orgId),
        payload: { fullName: 'X', endorsements: ['forklift'] },
      });
      assert.equal(res.statusCode, 400);
    });
  });

  // --- isolation -----------------------------------------------------------

  it('keeps two carriers\' profiles apart', async () => {
    const a = (await signUp('Tenant A')).json().org.id;
    const b = (await signUp('Tenant B')).json().org.id;

    await app.inject({
      method: 'PATCH',
      url: '/v1/org/profile',
      headers: as(a),
      payload: { dbaName: 'A Trucking' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/org/profile',
      headers: as(b),
    });
    assert.notEqual(res.json().dbaName, 'A Trucking');
  });
});
