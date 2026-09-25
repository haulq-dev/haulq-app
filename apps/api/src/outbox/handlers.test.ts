/**
 * Outbox handlers that read org membership through `@haulq/db`
 * (`getOrg`/`listAllMembers`), which needs real rows to read — hence
 * Postgres rather than a stub. Covers the one thing worth a database for
 * here: who actually gets the email.
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
import { buildOutboxGroups, buildOutboxHandlers, type HandlerDeps } from './handlers.ts';

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

suite('detentionAlertHandler', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    const org = await createTestOrg(db, 'Detention Handler Test Carrier');
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

  function detentionMessage(overrides: Partial<OutboxMessage> = {}): OutboxMessage {
    return {
      seq: 1n,
      orgId,
      eventSeq: null,
      topic: 'track.detention_alerted',
      attempts: 1,
      payload: {
        reference: 42,
        stopId: 'stop-1',
        stopSeq: 1,
        city: 'Kansas City',
        state: 'MO',
        detentionMinutes: 45,
      },
      ...overrides,
    };
  }

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
    return { mailer, handle: buildOutboxHandlers(deps)['track.detention_alerted']! };
  }

  it('emails every owner and dispatcher, and not the driver', async () => {
    const { mailer, handle } = handler();
    await handle(detentionMessage());

    const recipients = mailer.sent.map((e) => e.to).sort();
    assert.deepEqual(recipients, [dispatcherEmail, ownerEmail].sort());
    assert.ok(!recipients.includes(driverEmail));
  });

  it('names the load, the stop and the minutes over in the email', async () => {
    const { mailer, handle } = handler();
    await handle(detentionMessage());

    const email = mailer.sent[0]!;
    assert.match(email.subject, /Load 42/);
    assert.match(email.text, /stop\s+1/);
    assert.match(email.text, /Kansas City, MO/);
    assert.match(email.text, /45 minutes/);
  });

  it('skips a message missing a required field rather than throwing', async () => {
    const { mailer, handle } = handler();
    await handle(detentionMessage({ payload: { reference: 42, stopSeq: 1 } }));
    assert.equal(mailer.sent.length, 0);
  });
});

let accountantId: string;
let accountantEmail: string;

suite('awaitingApprovalHandler', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    const org = await createTestOrg(db, 'Awaiting Approval Test Carrier');
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
    const accountant = await createTestUser(db);
    accountantId = accountant.id;
    accountantEmail = accountant.email;
    await addTestMembership(db, { orgId, userId: accountantId, role: 'accountant' });
    await addTestMembership(db, { orgId, userId: ownerId, role: 'owner' });
    await addTestMembership(db, { orgId, userId: dispatcherId, role: 'dispatcher' });
    await addTestMembership(db, { orgId, userId: driverId, role: 'driver' });
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    await destroyTestUser(db, ownerId);
    await destroyTestUser(db, dispatcherId);
    await destroyTestUser(db, driverId);
    await destroyTestUser(db, accountantId);
    await closeDatabase(db);
  });

  const notice = (payload: Record<string, unknown> = { count: 2, waiting: 5 }): OutboxMessage => ({
    seq: 1n,
    orgId,
    eventSeq: null,
    topic: 'outbound.awaiting_approval',
    attempts: 1,
    payload,
  });

  function deps(mailer: FakeMailer): HandlerDeps {
    return {
      mailer,
      webOrigin: 'http://localhost:5173',
      db,
      storage: {} as never,
      reader: {} as never,
      log: { info: () => {}, warn: () => {} },
    };
  }

  function handler() {
    const mailer = new FakeMailer();
    return { mailer, handle: buildOutboxHandlers(deps(mailer))['outbound.awaiting_approval']! };
  }

  it('emails every owner, dispatcher and accountant once, and not the driver', async () => {
    const { mailer, handle } = handler();
    await handle(notice());

    const recipients = mailer.sent.map((e) => e.to).sort();
    assert.deepEqual(recipients, [accountantEmail, dispatcherEmail, ownerEmail].sort());
    assert.ok(!recipients.includes(driverEmail));
  });

  it('says how many, links to the Autopilot screen, and names no amount or broker', async () => {
    const { mailer, handle } = handler();
    await handle(notice());

    const email = mailer.sent[0]!;
    assert.match(email.subject, /5 messages waiting/);
    assert.match(email.text, /2 messages/);
    assert.match(email.text, /3 from before/);
    assert.match(email.text, /http:\/\/localhost:5173\/autopilot/);
    assert.doesNotMatch(email.text + email.html, /\$\d/);
  });

  it('reads singular when there is exactly one', async () => {
    const { mailer, handle } = handler();
    await handle(notice({ count: 1, waiting: 1 }));
    assert.match(mailer.sent[0]!.subject, /^1 message waiting/);
  });

  it('is registered in the fast group, so it is not stuck behind document reading', () => {
    const fast = buildOutboxGroups(deps(new FakeMailer())).find((g) => g.name === 'fast')!;
    assert.ok('outbound.awaiting_approval' in fast.handlers);
  });

  it('skips a message missing its counts rather than throwing', async () => {
    const { mailer, handle } = handler();
    await handle(notice({}));
    assert.equal(mailer.sent.length, 0);
  });
});

suite('loadProposalReadyHandler', () => {
  let accountantId2: string;

  before(async () => {
    db = createDatabase({ url: url! });
    const org = await createTestOrg(db, 'Load Proposal Notice Carrier');
    orgId = org.id;
    const owner = await createTestUser(db);
    ownerId = owner.id;
    ownerEmail = owner.email;
    const dispatcher = await createTestUser(db);
    dispatcherId = dispatcher.id;
    dispatcherEmail = dispatcher.email;
    const accountant = await createTestUser(db);
    accountantId2 = accountant.id;
    const driver = await createTestUser(db);
    driverId = driver.id;
    driverEmail = driver.email;
    await addTestMembership(db, { orgId, userId: ownerId, role: 'owner' });
    await addTestMembership(db, { orgId, userId: dispatcherId, role: 'dispatcher' });
    await addTestMembership(db, { orgId, userId: accountantId2, role: 'accountant' });
    await addTestMembership(db, { orgId, userId: driverId, role: 'driver' });
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    await destroyTestUser(db, ownerId);
    await destroyTestUser(db, dispatcherId);
    await destroyTestUser(db, accountantId2);
    await destroyTestUser(db, driverId);
    await closeDatabase(db);
  });

  const notice = (payload: Record<string, unknown> = { proposalId: 'p-123', filename: 'ratecon.pdf', stops: 2 }): OutboxMessage => ({
    seq: 1n,
    orgId,
    eventSeq: null,
    topic: 'load_proposal.created',
    attempts: 1,
    payload,
  });

  function setup() {
    const mailer = new FakeMailer();
    const deps: HandlerDeps = {
      mailer,
      webOrigin: 'http://localhost:5173',
      db,
      storage: {} as never,
      reader: {} as never,
      log: { info: () => {}, warn: () => {} },
    };
    return { mailer, handle: buildOutboxHandlers(deps)['load_proposal.created']!, deps };
  }

  it('tells the owner and the dispatcher, who can create a load, and nobody else', async () => {
    const { mailer, handle } = setup();
    await handle(notice());

    const recipients = mailer.sent.map((e) => e.to).sort();
    assert.deepEqual(recipients, [dispatcherEmail, ownerEmail].sort());
    assert.ok(!recipients.includes(driverEmail));
  });

  it('links to that proposal, says which document and how many stops, and names no broker or rate', async () => {
    const { mailer, handle } = setup();
    await handle(notice());

    const email = mailer.sent[0]!;
    assert.match(email.subject, /ready to become a load/);
    assert.match(email.text, /ratecon\.pdf/);
    assert.match(email.text, /2 stops/);
    assert.match(email.text, /http:\/\/localhost:5173\/proposals\/p-123/);
    assert.match(email.text, /Nothing has been created/);
    assert.doesNotMatch(email.text + email.html, /\$\d/);
  });

  it('reads singular for one stop, and escapes a file name in the html', async () => {
    const { mailer, handle } = setup();
    await handle(notice({ proposalId: 'p-1', filename: '<b>x</b>.pdf', stops: 1 }));

    assert.match(mailer.sent[0]!.text, /\(1 stop\)/);
    assert.doesNotMatch(mailer.sent[0]!.html, /<b>x<\/b>/);
    assert.match(mailer.sent[0]!.html, /&lt;b&gt;x/);
  });

  it('is in the fast group, so it is not stuck behind document reading', () => {
    const { deps } = setup();
    const fast = buildOutboxGroups(deps).find((g) => g.name === 'fast')!;
    assert.ok('load_proposal.created' in fast.handlers);
  });

  it('skips a message missing its proposal rather than throwing', async () => {
    const { mailer, handle } = setup();
    await handle(notice({ filename: 'ratecon.pdf' }));
    assert.equal(mailer.sent.length, 0);
  });
});
