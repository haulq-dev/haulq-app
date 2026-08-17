/**
 * The API, end to end.
 *
 * Driven with `app.inject()` rather than a listening socket, so these run
 * without a port and without a client.
 *
 * Needs DATABASE_URL — every route below touches the database, and a test that
 * mocks it would be testing the mock. Skips without one, same as the other
 * integration suites.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  createTestOrg,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from './env.ts';
import { buildServer } from './server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let app: FastifyInstance;
let orgId: string;
let userId: string;

const as = (extra: Record<string, string> = {}) => ({
  'x-haulq-org-id': orgId,
  'x-haulq-user-id': userId,
  ...extra,
});

suite('api', () => {
  before(async () => {
    app = await buildServer(
      loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }),
    );

    orgId = (await createTestOrg(app.db, 'API Test Carrier')).id;
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    await destroyTestOrg(app.db, orgId);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  // --- public routes -------------------------------------------------------

  it('answers health without a tenant', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
  });

  it('checks the database on readiness, not just the process', async () => {
    // A health check that does not touch its dependencies reports green
    // through the outage it exists to catch.
    const res = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().database, 'ok');
  });

  // --- authentication ------------------------------------------------------

  it('refuses an unauthenticated request with an explanation', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/trucks' });
    assert.equal(res.statusCode, 401);
    // Guardrail 6's readability requirement applies to errors too. A bare code
    // gives the UI nothing to show.
    assert.ok(res.json().explanation.length > 0);
  });

  it('refuses a driver from adding a truck', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/trucks',
      headers: as({ 'x-haulq-role': 'driver' }),
      payload: { label: 'Nope' },
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().explanation, /owner or dispatcher/);
  });

  // --- writes --------------------------------------------------------------

  describe('POST /v1/trucks', () => {
    it('creates a truck and its timeline entries together', async () => {
      const label = `Unit ${Date.now()}`;
      const res = await app.inject({
        method: 'POST',
        url: '/v1/trucks',
        headers: as(),
        payload: {
          label,
          maxWeightLbs: 12000,
          capabilities: { liftgate: true, palletJack: true, dockHigh: false },
        },
      });

      assert.equal(res.statusCode, 201);
      const truck = res.json();
      assert.equal(truck.label, label);

      const timeline = await app.inject({
        method: 'GET',
        url: `/v1/timeline?subjectType=truck&subjectId=${truck.id}`,
        headers: as(),
      });

      const items = timeline.json().items as Array<{ explanation: string }>;
      assert.equal(items.length, 2, 'the add and the capability change');

      const text = items.map((i) => i.explanation).join('\n');
      assert.match(text, new RegExp(`Added ${label}`));
      // Only the enabled capabilities, and dockHigh: false is not one.
      assert.match(text, /added liftgate, palletJack/);
      assert.doesNotMatch(text, /dockHigh/);
    });

    it('explains what is wrong with a bad payload', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/trucks',
        headers: as(),
        payload: { label: '', maxWeightLbs: 900000 },
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().explanation, /label/);
    });

    it('does not leak another tenant\'s trucks', async () => {
      const otherOrgId = (await createTestOrg(app.db, 'Other')).id;

      await app.inject({
        method: 'POST',
        url: '/v1/trucks',
        headers: { 'x-haulq-org-id': otherOrgId, 'x-haulq-user-id': userId },
        payload: { label: 'Their Truck' },
      });

      const mine = await app.inject({
        method: 'GET',
        url: '/v1/trucks',
        headers: as(),
      });
      const labels = (mine.json().items as Array<{ label: string }>).map(
        (t) => t.label,
      );
      assert.ok(!labels.includes('Their Truck'));

      await destroyTestOrg(app.db, otherOrgId);
    });
  });

  // --- guardrail 5 ---------------------------------------------------------

  it('attributes an agent\'s write to the agent, not to a person', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/trucks',
      headers: as({ 'x-haulq-agent': 'claude-haiku-4-5-20251001' }),
      payload: { label: `Agent ${Date.now()}` },
    });
    assert.equal(res.statusCode, 201);

    const timeline = await app.inject({
      method: 'GET',
      url: `/v1/timeline?subjectType=truck&subjectId=${res.json().id}`,
      headers: as(),
    });
    const entry = (timeline.json().items as Array<{
      actorType: string;
      actorId: string;
    }>)[0]!;

    assert.equal(entry.actorType, 'agent');
    assert.equal(entry.actorId, 'claude-haiku-4-5-20251001');
  });

  // --- timeline ------------------------------------------------------------

  it('serializes seq as a string so the cursor keeps its precision', async () => {
    // JSON numbers lose integer precision past 2^53. A cursor that silently
    // rounds is a cursor that silently skips rows.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/timeline?limit=1',
      headers: as(),
    });
    const body = res.json();
    assert.equal(typeof body.items[0].seq, 'string');
    assert.equal(typeof body.nextCursor, 'string');
  });

  it('rejects a malformed cursor rather than ignoring it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/timeline?before=banana',
      headers: as(),
    });
    assert.equal(res.statusCode, 400);
  });
});
