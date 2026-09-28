/**
 * Push as a second channel on the outbox handlers (MOBILE_PARITY_PLAN.md
 * section 7). Who gets which notification, that a muted category is
 * respected, that a dead token is disabled, and that the lock screen never
 * carries a dollar amount or a broker name.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  addTestMembership,
  closeDatabase,
  createDatabase,
  createDriver,
  createLoad,
  createTestOrg,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  linkDriverToUserForTest,
  pendingOutboxTopics,
  pushDeviceForTest,
  registerPushDevice,
  setPushPreferences,
  testScope,
  type Database,
  type OutboxMessage,
} from '@haulq/db';
import type { Email, Mailer } from '../email/postmark.ts';
import { FakePushSender } from '../push/sender.ts';
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

const TOKENS = { owner: '1'.repeat(64), dispatcher: '2'.repeat(64), accountant: '3'.repeat(64), driver: '4'.repeat(64) };

suite('push from outbox handlers', () => {
  let db: Database;
  let orgId: string;
  const users: Record<keyof typeof TOKENS, string> = { owner: '', dispatcher: '', accountant: '', driver: '' };
  let push: FakePushSender;
  let handlers: ReturnType<typeof buildOutboxHandlers>;

  const msg = (topic: string, payload: Record<string, unknown>): OutboxMessage => ({
    seq: 7n,
    orgId,
    eventSeq: null,
    topic,
    attempts: 1,
    payload,
  });
  const recipients = () => push.sent.map((s) => s.device.token).sort();

  before(async () => {
    db = createDatabase({ url: url! });
    orgId = (await createTestOrg(db, 'Push Handlers Co')).id;
    for (const role of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) {
      users[role] = (await createTestUser(db)).id;
      await addTestMembership(db, { orgId, userId: users[role], role });
    }
  });

  beforeEach(async () => {
    for (const role of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) {
      await registerPushDevice(db, { userId: users[role], token: TOKENS[role], platform: 'ios' });
      await setPushPreferences(db, users[role], []);
    }
    push = new FakePushSender();
    const deps: HandlerDeps = {
      mailer: new FakeMailer(),
      push,
      webOrigin: 'http://localhost:5173',
      db,
      storage: {} as never,
      reader: {} as never,
      log: { info: () => {}, warn: () => {} },
    };
    handlers = buildOutboxHandlers(deps);
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    for (const id of Object.values(users)) await destroyTestUser(db, id);
    await closeDatabase(db);
  });

  it('tells owners and dispatchers a load went quiet, and not the driver or accountant', async () => {
    await handlers['track.exception_alerted']!(msg('track.exception_alerted', { reference: 1042, hoursSinceActivity: 4 }));
    assert.deepEqual(recipients(), [TOKENS.owner, TOKENS.dispatcher].sort());
    assert.deepEqual(push.sent[0]!.message, {
      title: 'Load 1042',
      body: 'No check-in or position in 4 hours.',
      path: '/',
      orgId,
      collapseId: 'track.exception_alerted-7',
    });
  });

  it('respects a muted category, per person', async () => {
    await setPushPreferences(db, users.dispatcher, ['load_quiet']);
    await handlers['track.exception_alerted']!(msg('track.exception_alerted', { reference: 1042, hoursSinceActivity: 4 }));
    assert.deepEqual(recipients(), [TOKENS.owner]);
  });

  it('disables a token Apple says is dead, and still emails', async () => {
    push.deadTokens.add(TOKENS.owner);
    const mailer = new FakeMailer();
    const deps: HandlerDeps = { mailer, push, webOrigin: 'x', db, storage: {} as never, reader: {} as never, log: { info: () => {}, warn: () => {} } };
    await buildOutboxHandlers(deps)['track.exception_alerted']!(msg('track.exception_alerted', { reference: 1042, hoursSinceActivity: 4 }));
    assert.ok((await pushDeviceForTest(db, TOKENS.owner))?.disabledAt);
    assert.equal(mailer.sent.length, 2);
  });

  it('never puts a dollar amount or broker name on the lock screen', async () => {
    await handlers['broker.verification_changed']!(
      msg('broker.verification_changed', { brokerName: 'Prairie Freight', previousStatus: 'Authorized', newStatus: 'Not authorized' }),
    );
    await handlers['invoice.paid']!(msg('invoice.paid', { reference: 1001, loadReference: 1030, totalAmount: 240_000, totalCurrency: 'USD' }));
    for (const { message } of push.sent) {
      assert.doesNotMatch(`${message.title} ${message.body}`, /Prairie|\$|2,400/);
    }
    // Invoice paid goes to the owner and accountant only.
    const paid = push.sent.filter((s) => s.message.title === 'Invoice 1001 paid').map((s) => s.device.token).sort();
    assert.deepEqual(paid, [TOKENS.owner, TOKENS.accountant].sort());
  });

  it("counts Autopilot's waiting messages as messages, for the three roles that approve", async () => {
    await handlers['outbound.awaiting_approval']!(msg('outbound.awaiting_approval', { count: 1, waiting: 3 }));
    assert.deepEqual(recipients(), [TOKENS.owner, TOKENS.dispatcher, TOKENS.accountant].sort());
    assert.equal(push.sent[0]!.message.body, '3 messages are waiting for your OK.');
    assert.equal(push.sent[0]!.message.path, '/autopilot');
  });

  it('tells a driver about a load assigned to them, and only them', async () => {
    const s = testScope(db, orgId, { type: 'user', id: users.owner });
    const driver = await createDriver(s, { fullName: 'Rosa Diaz' });
    await linkDriverToUserForTest(db, driver.id, users.driver);

    await handlers['load.driver_assigned']!(msg('load.driver_assigned', { reference: 1042, driverId: driver.id, driverName: 'Rosa Diaz' }));
    assert.deepEqual(recipients(), [TOKENS.driver]);
    assert.equal(push.sent[0]!.message.body, "You've been assigned this load.");
  });

  it('records the driver-assigned event when a load is created with a driver', async () => {
    const s = testScope(db, orgId, { type: 'user', id: users.owner });
    const driver = await createDriver(s, { fullName: 'Sam Ortiz' });
    await createLoad(s, {
      driverId: driver.id,
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO' },
      ],
    } as never);
    assert.ok((await pendingOutboxTopics(db, orgId)).includes('load.driver_assigned'));
  });

  it('does nothing at all without a push sender', async () => {
    const deps: HandlerDeps = { mailer: new FakeMailer(), webOrigin: 'x', db, storage: {} as never, reader: {} as never, log: { info: () => {}, warn: () => {} } };
    await buildOutboxHandlers(deps)['invoice.paid']!(msg('invoice.paid', { reference: 1, loadReference: 2 }));
    assert.equal(push.sent.length, 0);
  });
});
