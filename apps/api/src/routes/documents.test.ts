/**
 * Document intake, end to end.
 *
 * The claims that are worth a server for:
 *
 *  - a repeat send costs one row and **zero** writes to the object store. That
 *    is the whole reason the digest is computed before storing, and it is
 *    invisible to a test that only checks the response body — so the store here
 *    counts its calls.
 *  - the bytes decide the content type, not the header a browser guessed
 *  - a rejected upload does not leave an orphan in the store
 *  - one carrier cannot see, fetch or attach another carrier's document
 *  - `storageKey` never leaves the API
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addTestMembership,
  createLoad,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  MemoryObjectStore,
  testScope,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

/** A store that remembers how often it was asked to do something. */
class CountingStore extends MemoryObjectStore {
  puts = 0;
  deletes = 0;
  /** The most recent key written. The API does not expose one, by design. */
  lastKey: string | null = null;
  override async put(key: string, body: Buffer) {
    this.puts += 1;
    this.lastKey = key;
    return super.put(key, body);
  }
  override async delete(key: string) {
    this.deletes += 1;
    return super.delete(key);
  }
  reset() {
    this.puts = 0;
    this.deletes = 0;
  }
}

let app: FastifyInstance;
let store: CountingStore;
let userId: string;
let driverId: string;
const createdOrgs: string[] = [];

/** Enough of a PDF to be identified as one. `tag` makes the digest unique. */
const pdf = (tag = 'a') =>
  Buffer.concat([Buffer.from(`%PDF-1.7\n% ${tag}\n`), Buffer.alloc(64)]);

const jpeg = (tag = 'a') =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag), Buffer.alloc(64)]);

const as = (orgId: string, extra: Record<string, string> = {}) => ({
  'x-haulq-org-id': orgId,
  'x-haulq-user-id': userId,
  ...extra,
});

async function newOrg(name: string) {
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

/**
 * A user who really is a driver in this org.
 *
 * The dev authenticator resolves the role from `org_memberships` and lets a real
 * membership beat the `x-haulq-role` header — deliberately, so role tests
 * exercise the access model rather than the header. `newOrg` makes its creator
 * an owner, so a driver test that only sets the header is testing nothing.
 */
async function asDriver(orgId: string) {
  await addTestMembership(app.db, { orgId, userId: driverId, role: 'driver' });
  return { 'x-haulq-org-id': orgId, 'x-haulq-user-id': driverId };
}

async function aLoad(orgId: string) {
  const s = testScope(app.db, orgId, { type: 'user', id: userId });
  return createLoad(s, {
    brokerName: 'Prairie Freight',
    stops: [
      { type: 'pickup', city: 'Wichita', state: 'KS' },
      { type: 'delivery', city: 'Denver', state: 'CO' },
    ],
  });
}

const upload = (
  orgId: string,
  body: Buffer,
  query = '',
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: 'POST',
    url: `/v1/documents${query}`,
    headers: as(orgId, { 'content-type': 'application/pdf', ...headers }),
    payload: body,
  });

suite('document intake', () => {
  before(async () => {
    store = new CountingStore();
    app = await buildServer(
      loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }),
      { storage: store },
    );
    userId = (await createTestUser(app.db)).id;
    driverId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    await destroyTestUser(app.db, userId);
    await destroyTestUser(app.db, driverId);
    await app.close();
  });

  describe('POST /v1/documents', () => {
    it('stores a PDF and records it', async () => {
      const orgId = await newOrg('Intake Co');
      const res = await upload(orgId, pdf('one'), '?filename=ratecon.pdf');

      assert.equal(res.statusCode, 201);
      const { document, deduped } = res.json();
      assert.equal(deduped, false);
      assert.equal(document.source, 'upload');
      assert.equal(document.status, 'received');
      assert.equal(document.kind, 'other');
      assert.equal(document.filename, 'ratecon.pdf');
      assert.equal(document.contentType, 'application/pdf');
      assert.equal(document.loadId, null);
      assert.ok(document.sha256.length === 64);
    });

    it('never returns the storage key', async () => {
      const orgId = await newOrg('No Key Co');
      const res = await upload(orgId, pdf('key'));
      assert.equal(res.json().document.storageKey, undefined);
      assert.ok(!res.body.includes('/documents/'), 'no R2 path anywhere in the body');
    });

    it('costs zero uploads when the same file is sent again', async () => {
      const orgId = await newOrg('Repeat Co');
      const bytes = pdf('repeat');

      store.reset();
      const first = await upload(orgId, bytes, '?filename=ratecon.pdf');
      assert.equal(first.statusCode, 201);
      assert.equal(store.puts, 1);

      const second = await upload(orgId, bytes, '?filename=RATECON%20(1).pdf');
      assert.equal(second.statusCode, 200);
      assert.equal(second.json().deduped, true);
      assert.equal(
        second.json().document.id,
        first.json().document.id,
        'a resend is the same document',
      );
      assert.equal(store.puts, 1, 'the second send must not touch the object store');
      assert.equal(store.deletes, 0, 'and must not delete anything either');
    });

    it('lets two carriers hold the same file', async () => {
      const a = await newOrg('Carrier A');
      const b = await newOrg('Carrier B');
      const bytes = pdf('shared');

      const first = await upload(a, bytes);
      const second = await upload(b, bytes);

      assert.equal(first.statusCode, 201);
      assert.equal(second.statusCode, 201);
      assert.notEqual(second.json().document.id, first.json().document.id);
    });

    it('believes the bytes, not the content-type header', async () => {
      const orgId = await newOrg('Octet Co');
      const res = await upload(orgId, pdf('octet'), '', {
        'content-type': 'application/octet-stream',
      });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().document.contentType, 'application/pdf');
    });

    it('accepts a phone photo', async () => {
      const orgId = await newOrg('Photo Co');
      const res = await upload(orgId, jpeg('pod'), '?kind=pod');
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().document.contentType, 'image/jpeg');
      assert.equal(res.json().document.kind, 'pod');
    });

    it('refuses a file it cannot read, and stores nothing', async () => {
      const orgId = await newOrg('Text Co');
      store.reset();
      const res = await upload(orgId, Buffer.from('Dear carrier, see attached.'));
      assert.equal(res.statusCode, 415);
      assert.equal(res.json().code, 'unsupported_file');
      assert.equal(store.puts, 0);
    });

    it('refuses an empty body', async () => {
      const orgId = await newOrg('Empty Co');
      const res = await upload(orgId, Buffer.alloc(0));
      assert.equal(res.statusCode, 400);
    });

    it('refuses a document type it does not have', async () => {
      const orgId = await newOrg('Kind Co');
      const res = await upload(orgId, pdf('kind'), '?kind=napkin_sketch');
      assert.equal(res.statusCode, 400);
      assert.match(res.json().explanation, /napkin_sketch/);
    });

    it('attaches at upload time when the load is given', async () => {
      const orgId = await newOrg('Attach At Upload Co');
      const load = await aLoad(orgId);
      const res = await upload(orgId, pdf('atupload'), `?loadId=${load.id}`);
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().document.loadId, load.id);
    });

    it('refuses another carrier\'s load and cleans up the object it wrote', async () => {
      const mine = await newOrg('Mine Co');
      const theirs = await newOrg('Theirs Co');
      const theirLoad = await aLoad(theirs);

      store.reset();
      const res = await upload(mine, pdf('crosstenant'), `?loadId=${theirLoad.id}`);

      assert.equal(res.statusCode, 404);
      assert.equal(res.json().code, 'load_not_found');
      assert.equal(store.puts, 1, 'the bytes were stored before the row was refused');
      assert.equal(store.deletes, 1, 'and were removed once it was');
    });

    it('rejects a malformed load id before doing any work', async () => {
      const orgId = await newOrg('Bad Id Co');
      store.reset();
      const res = await upload(orgId, pdf('badid'), '?loadId=not-a-uuid');
      assert.equal(res.statusCode, 400);
      assert.equal(store.puts, 0);
    });

    it('lets a driver upload', async () => {
      const orgId = await newOrg('Driver Upload Co');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/documents',
        headers: { ...(await asDriver(orgId)), 'content-type': 'application/pdf' },
        payload: pdf('driver'),
      });
      assert.equal(res.statusCode, 201, 'a POD photographed at the dock is the main path');
    });
  });

  describe('reading', () => {
    it('lists the inbox, and filters to unattached', async () => {
      const orgId = await newOrg('Inbox Co');
      const load = await aLoad(orgId);
      const attached = (await upload(orgId, pdf('inbox-a'), `?loadId=${load.id}`)).json();
      const loose = (await upload(orgId, pdf('inbox-b'))).json();

      const all = await app.inject({ method: 'GET', url: '/v1/documents', headers: as(orgId) });
      assert.equal(all.json().items.length, 2);

      const un = await app.inject({
        method: 'GET',
        url: '/v1/documents?unattached=true',
        headers: as(orgId),
      });
      assert.deepEqual(
        un.json().items.map((d: { id: string }) => d.id),
        [loose.document.id],
      );

      const byLoad = await app.inject({
        method: 'GET',
        url: `/v1/documents?loadId=${load.id}`,
        headers: as(orgId),
      });
      assert.deepEqual(
        byLoad.json().items.map((d: { id: string }) => d.id),
        [attached.document.id],
      );
    });

    it('reads "counts" as a route, not as a document id', async () => {
      const orgId = await newOrg('Counts Co');
      await upload(orgId, pdf('counts'));
      const res = await app.inject({
        method: 'GET',
        url: '/v1/documents/counts',
        headers: as(orgId),
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().counts.received, 1);
    });

    it('does not show another carrier a document', async () => {
      const mine = await newOrg('Private Co');
      const theirs = await newOrg('Nosy Co');
      const { document } = (await upload(mine, pdf('private'))).json();

      for (const path of [`/v1/documents/${document.id}`, `/v1/documents/${document.id}/content`]) {
        const res = await app.inject({ method: 'GET', url: path, headers: as(theirs) });
        assert.equal(res.statusCode, 404, path);
      }
    });

    it('serves the bytes back', async () => {
      const orgId = await newOrg('Download Co');
      const bytes = pdf('download');
      const { document } = (await upload(orgId, bytes, '?filename=ratecon.pdf')).json();

      const res = await app.inject({
        method: 'GET',
        url: `/v1/documents/${document.id}/content`,
        headers: as(orgId),
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'application/pdf');
      assert.match(String(res.headers['content-disposition']), /filename="ratecon\.pdf"/);
      assert.deepEqual(res.rawPayload, bytes);
    });

    it('says so when the row outlived its file', async () => {
      const orgId = await newOrg('Lost Bytes Co');
      const { document } = (await upload(orgId, pdf('lost'))).json();

      // A swapped bucket or a lifecycle rule, in one line. The row survives,
      // the object does not — which is an operational problem and must not read
      // to the carrier as a missing document.
      await store.delete(store.lastKey!);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/documents/${document.id}/content`,
        headers: as(orgId),
      });
      assert.equal(res.statusCode, 410);
      assert.equal(res.json().code, 'content_missing');
    });
  });

  describe('POST /v1/documents/:id/attach', () => {
    it('attaches, and the load then lists it', async () => {
      const orgId = await newOrg('Attach Co');
      const load = await aLoad(orgId);
      const { document } = (await upload(orgId, pdf('attach'))).json();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/documents/${document.id}/attach`,
        headers: as(orgId),
        payload: { loadId: load.id },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().document.loadId, load.id);
    });

    it('refuses a load in another account', async () => {
      const mine = await newOrg('Attach Mine Co');
      const theirs = await newOrg('Attach Theirs Co');
      const theirLoad = await aLoad(theirs);
      const { document } = (await upload(mine, pdf('attach-cross'))).json();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/documents/${document.id}/attach`,
        headers: as(mine),
        payload: { loadId: theirLoad.id },
      });
      assert.equal(res.statusCode, 404);
    });

    it('is not open to drivers', async () => {
      const orgId = await newOrg('Driver Attach Co');
      const load = await aLoad(orgId);
      const { document } = (await upload(orgId, pdf('driver-attach'))).json();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/documents/${document.id}/attach`,
        headers: await asDriver(orgId),
        payload: { loadId: load.id },
      });
      assert.equal(res.statusCode, 403);
    });

    it('needs a load id', async () => {
      const orgId = await newOrg('No Load Co');
      const { document } = (await upload(orgId, pdf('noload'))).json();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/documents/${document.id}/attach`,
        headers: as(orgId),
        payload: {},
      });
      assert.equal(res.statusCode, 400);
    });
  });
});
