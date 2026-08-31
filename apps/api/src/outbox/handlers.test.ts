/**
 * The verification-changed outbox handler, against a real database.
 *
 * `verificationChangedHandler` reads org membership through `@haulq/db`
 * (`getOrg`/`listAllMembers`), which needs real rows to read — hence
 * Postgres rather than a stub, the same reason `exceptionAlertHandler` has
 * no equivalent dedicated file and is instead exercised end to end in
 * `pipeline.test.ts`/`track.test.ts`. This file covers the one thing worth
 * a database for here: who actually gets the email.
 *
 * Skips without DATABASE_URL, same as the rest of the package.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addTestMembership,
  closeDatabase,
  createDatabase,
  createTestOrg,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  type Database,
  type OutboxMessage,
} from '@haulq/db';
import type { Email, Mailer } from '../email/postmark.ts';
import { buildOutboxHandlers, type HandlerDeps } from './handlers.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

class FakeMailer implements Mailer {
  readonly name = 'fake';
  readonly sent: Email[] = [];
  async send(email: Email): Promise<void> {
    this.sent.push(email);
  }
}

let db: Database;
let orgId: string;
let ownerId: string;
let ownerEmail: string;
let dispatcherId: string;
let dispatcherEmail: string;
let driverId: string;
let driverEmail: string;

function aMessage(overrides: Partial<OutboxMessage> = {}): OutboxMessage {
  return {
    seq: 1n,
    orgId,
    eventSeq: null,
    topic: 'broker.verification_changed',
    attempts: 1,
    payload: {
      brokerName: 'Prairie Freight',
      previousStatus: 'Authorized',
      newStatus: 'Not authorized',
    },
    ...overrides,
  };
}

suite('verificationChangedHandler', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    const org = await createTestOrg(db, 'Watchlist Test Carrier');
    orgId = org.id;

    const owner = await createTestUser(db);
    ownerId = owner.id;
    ownerEmail = owner.email;
    const dispatcher = await createTestUser(db);
    dispatcherId = dispatcher.id;
    dispatcherEmail = dispatcher.email;
    const driver = await createTestUser(db);
    driverId = driver.id;
    driverEmail = driver.email;

    await addTestMembership(db, { orgId, userId: ownerId, role: 'owner' });
    await addTestMembership(db, { orgId, userId: dispatcherId, role: 'dispatcher' });
    await addTestMembership(db, { orgId, userId: driverId, role: 'driver' });
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    await destroyTestUser(db, ownerId);
    await destroyTestUser(db, dispatcherId);
    await destroyTestUser(db, driverId);
    await closeDatabase(db);
  });

  function handler() {
    const mailer = new FakeMailer();
    const deps: HandlerDeps = {
      mailer,
      webOrigin: 'http://localhost:5173',
      db,
      storage: {} as never,
      reader: {} as never,
      log: { info: () => {}, warn: () => {} },
    };
    return { mailer, handle: buildOutboxHandlers(deps)['broker.verification_changed']! };
  }

  it('emails every owner and dispatcher, and not the driver', async () => {
    const { mailer, handle } = handler();
    await handle(aMessage());

    const recipients = mailer.sent.map((e) => e.to).sort();
    assert.deepEqual(recipients, [dispatcherEmail, ownerEmail].sort());
    assert.ok(!recipients.includes(driverEmail));
  });

  it('names the broker and both statuses in the email', async () => {
    const { mailer, handle } = handler();
    await handle(aMessage());

    const email = mailer.sent[0]!;
    assert.match(email.subject, /Prairie Freight/);
    assert.match(email.text, /authorized/);
    assert.match(email.text, /not authorized/);
  });

  it('skips a message missing brokerName rather than throwing', async () => {
    const { mailer, handle } = handler();
    await handle(aMessage({ payload: { previousStatus: 'Authorized', newStatus: 'Not authorized' } }));
    assert.equal(mailer.sent.length, 0);
  });
});
