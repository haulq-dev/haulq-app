/**
 * A new carrier signing up emails the HaulQ team, through the outbox.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createTestUser, destroyTestOrg, destroyTestUser, drainOutbox, MemoryObjectStore } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { Email } from '../email/postmark.ts';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';
import { buildOutboxHandlers } from './handlers.ts';
import { LocalDocumentReader } from '../documents/reader.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

suite('sign-up alert', () => {
  let app: FastifyInstance;
  let userId: string;
  const createdOrgs: string[] = [];

  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }), {
      storage: new MemoryObjectStore(),
    });
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  async function drain(opts: { signupAlertEmail?: string; requirePilotApproval?: boolean }) {
    const sent: Email[] = [];
    const handlers = buildOutboxHandlers({
      mailer: { name: 'test', send: async (e: Email) => void sent.push(e) },
      webOrigin: 'http://localhost:5173',
      db: app.db,
      storage: app.storage,
      reader: new LocalDocumentReader(),
      ...opts,
      log: { info: () => {}, warn: () => {} },
    });
    await drainOutbox(app.db, { handlers });
    return sent;
  }

  async function signUp(name: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { 'x-haulq-user-id': userId },
      payload: { name, contactEmail: 'owner@example.com' },
    });
    const id = res.json().org.id as string;
    createdOrgs.push(id);
    return id;
  }

  it('emails the team with who signed up and how to approve them', async () => {
    const orgId = await signUp('Signup Alert Freight');
    const sent = (await drain({ signupAlertEmail: 'team@example.com', requirePilotApproval: true })).filter(
      (e) => e.tag === 'signup-alert',
    );

    const mine = sent.find((e) => e.text.includes(orgId));
    assert.ok(mine, JSON.stringify(sent.map((e) => e.subject)));
    assert.equal(mine!.to, 'team@example.com');
    assert.equal(mine!.subject, 'New HaulQ sign-up: Signup Alert Freight');
    assert.match(mine!.text, /Contact email: owner@example\.com/);
    assert.match(mine!.text, new RegExp(`approve-pilot\.ts --org ${orgId.slice(0, 8)} --apply`));
  });

  it('sends nothing when no address is configured', async () => {
    await signUp('Signup Quiet Freight');
    const sent = await drain({});
    assert.equal(sent.filter((e) => e.tag === 'signup-alert').length, 0);
  });
});
