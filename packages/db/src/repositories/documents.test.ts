/**
 * The documents repository, against a real database.
 *
 * The claims worth a suite are the ones a unit test cannot reach, because they
 * live in a constraint, a trigger or a transaction:
 *
 *  - a repeat send produces one row, one event, and no modification to the first
 *  - dedupe is per tenant, so two carriers can hold the same PDF
 *  - a rejection carries a reason, because `documents_rejected_has_reason` will
 *    otherwise refuse the write
 *  - `kind` agrees with the check constraint, which is the authority for a list
 *    that contracts only keeps a copy of
 *  - nothing touches a quarantined document
 *
 * Skips without DATABASE_URL, same as the rest of the package.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DOCUMENT_KINDS, type ValidationFinding } from '@haulq/contracts';
import { closeDatabase, createDatabase, type Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { readTimeline } from '../events/record.ts';
import {
  createTestOrg,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  testScope,
} from '../testing.ts';
import { createLoad } from './loads.ts';
import {
  attachToLoad,
  createDocument,
  documentCounts,
  DocumentError,
  findDocumentBySha,
  getDocument,
  listDocuments,
  quarantineDocument,
  recordExtraction,
  recordManualFields,
  recordValidation,
} from './documents.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let db: Database;
let orgId: string;
let otherOrgId: string;
let s: Scope;
let other: Scope;
let userId: string;
let userEmail: string;

/** A distinct digest per call, so tests do not dedupe into each other. */
const digest = () => randomUUID().replace(/-/g, '').repeat(2).slice(0, 64);

async function upload(overrides: Partial<Parameters<typeof createDocument>[1]> = {}) {
  const sha256 = overrides.sha256 ?? digest();
  return createDocument(s, {
    storageKey: `${orgId}/documents/${randomUUID()}.pdf`,
    sha256,
    source: 'upload',
    filename: 'rate-confirmation.pdf',
    contentType: 'application/pdf',
    byteSize: 12_345,
    ...overrides,
  });
}

async function aLoad(scope_: Scope = s) {
  const load = await createLoad(scope_, {
    brokerName: 'Prairie Freight',
    stops: [
      { type: 'pickup', city: 'Wichita', state: 'KS' },
      { type: 'delivery', city: 'Denver', state: 'CO' },
    ],
  });
  return load;
}

const agreeing: ValidationFinding[] = [
  {
    field: 'rateAmount',
    documentValue: '$2,400.00',
    loadValue: '$2,400.00',
    agrees: true,
    severity: 'info',
  },
];

const disagreeing: ValidationFinding[] = [
  {
    field: 'rateAmount',
    documentValue: '$2,400.00',
    loadValue: '$2,600.00',
    agrees: false,
    severity: 'error',
  },
];

suite('documents repository', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    const org = await createTestOrg(db, 'Docs Test Carrier');
    const second = await createTestOrg(db, 'Other Carrier');
    orgId = org.id;
    otherOrgId = second.id;

    // A real row: `documents.uploaded_by_user_id` and `event_log.actor_user_id`
    // are both foreign keys, so a made-up uuid fails the insert rather than the
    // assertion, and the failure reads like a repository bug.
    const user = await createTestUser(db);
    userId = user.id;
    userEmail = user.email;

    s = testScope(db, orgId, { type: 'user', id: userId, email: user.email });
    other = testScope(db, otherOrgId, { type: 'system', name: 'test' });
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    await destroyTestOrg(db, otherOrgId);
    await destroyTestUser(db, userId);
    await closeDatabase(db);
  });

  describe('createDocument', () => {
    it('stores the pointer and reports it as new', async () => {
      const { document, deduped } = await upload();
      assert.equal(deduped, false);
      assert.equal(document.orgId, orgId);
      assert.equal(document.status, 'received');
      assert.equal(document.source, 'upload');
      assert.equal(document.kind, 'other', 'unclassified documents are `other`');
      assert.equal(document.loadId, null);
      assert.ok(document.receivedAt instanceof Date);
    });

    it('returns the first row for a repeat send, without writing a second', async () => {
      const sha256 = digest();
      const first = await upload({ sha256 });
      const second = await upload({ sha256, filename: 'RATECON (1).pdf' });

      assert.equal(second.deduped, true);
      assert.equal(second.document.id, first.document.id);
      // The repeat carried a different filename. A resend is not an edit.
      assert.equal(second.document.filename, 'rate-confirmation.pdf');
      assert.deepEqual(
        second.document.updatedAt,
        first.document.updatedAt,
        'a repeat send must not touch updated_at on the original',
      );
    });

    it('dedupes per tenant, not globally', async () => {
      const sha256 = digest();
      const mine = await upload({ sha256 });
      const theirs = await createDocument(other, {
        storageKey: `${otherOrgId}/documents/${randomUUID()}.pdf`,
        sha256,
        source: 'email_intake',
      });

      assert.equal(theirs.deduped, false);
      assert.notEqual(theirs.document.id, mine.document.id);
    });

    it('records the sender for an email intake', async () => {
      const { document } = await upload({
        source: 'email_intake',
        receivedFrom: 'dispatch@prairie-freight.test',
        intakeMessageId: 'msg-1',
      });
      assert.equal(document.source, 'email_intake');
      assert.equal(document.receivedFrom, 'dispatch@prairie-freight.test');
    });

    it('accepts every kind the check constraint allows', async () => {
      // contracts keeps a copy of this list and cannot verify it from there.
      // If the two drift, this fails on the kind that was added to only one.
      for (const kind of DOCUMENT_KINDS) {
        const { document } = await upload({ kind });
        assert.equal(document.kind, kind);
      }
    });

    it('refuses a load in another tenant', async () => {
      // The foreign key alone does not stop this: it is satisfied by any row in
      // `loads`, whoever owns it. Without the explicit check a document could be
      // hung on another carrier's load at creation.
      const theirLoad = await aLoad(other);
      await assert.rejects(
        () => upload({ loadId: theirLoad.id }),
        (e: DocumentError) => e.code === 'load_not_found',
      );
    });

    it('accepts a load in this tenant', async () => {
      const load = await aLoad();
      const { document } = await upload({ loadId: load.id });
      assert.equal(document.loadId, load.id);
    });

    it('refuses a kind the check constraint does not know', async () => {
      await assert.rejects(
        // @ts-expect-error deliberately outside DocumentKind
        () => upload({ kind: 'napkin_sketch' }),
        /documents_kind_ck|violates check constraint/,
      );
    });
  });

  describe('reading', () => {
    it('does not return another tenant\'s document', async () => {
      const { document } = await upload();
      assert.ok(await getDocument(s, document.id));
      assert.equal(await getDocument(other, document.id), undefined);
    });

    it('finds a document by digest, within the tenant', async () => {
      const sha256 = digest();
      const { document } = await upload({ sha256 });
      assert.equal((await findDocumentBySha(s, sha256))?.id, document.id);
      assert.equal(await findDocumentBySha(other, sha256), undefined);
    });

    it('lists only unattached documents when asked', async () => {
      const load = await aLoad();
      const attached = await upload();
      await attachToLoad(s, attached.document.id, load.id);
      const loose = await upload();

      const unattached = await listDocuments(s, { unattached: true, limit: 200 });
      const ids = unattached.map((d) => d.id);
      assert.ok(ids.includes(loose.document.id));
      assert.ok(!ids.includes(attached.document.id));
    });

    it('lists a load\'s documents', async () => {
      const load = await aLoad();
      const mine = await upload();
      await attachToLoad(s, mine.document.id, load.id);
      await upload();

      const rows = await listDocuments(s, { loadId: load.id });
      assert.deepEqual(rows.map((d) => d.id), [mine.document.id]);
    });

    it('counts by status', async () => {
      const counts = await documentCounts(s);
      assert.ok((counts['received'] ?? 0) > 0);
      assert.equal(counts['nonexistent_status'], undefined);
    });
  });

  describe('attachToLoad', () => {
    it('attaches and records the load reference', async () => {
      const load = await aLoad();
      const { document } = await upload();
      const attached = await attachToLoad(s, document.id, load.id);
      assert.equal(attached.loadId, load.id);
    });

    it('is a no-op when it is already on that load', async () => {
      const load = await aLoad();
      const { document } = await upload();
      const once = await attachToLoad(s, document.id, load.id);
      const twice = await attachToLoad(s, document.id, load.id);
      assert.deepEqual(twice.updatedAt, once.updatedAt);
    });

    it('moves a document to a different load', async () => {
      const wrong = await aLoad();
      const right = await aLoad();
      const { document } = await upload();
      await attachToLoad(s, document.id, wrong.id);
      const moved = await attachToLoad(s, document.id, right.id);
      assert.equal(moved.loadId, right.id);
    });

    it('refuses a load in another tenant', async () => {
      const theirLoad = await aLoad(other);
      const { document } = await upload();
      await assert.rejects(
        () => attachToLoad(s, document.id, theirLoad.id),
        (e: DocumentError) => e.code === 'load_not_found',
      );
    });

    it('refuses a document that is not there', async () => {
      const load = await aLoad();
      await assert.rejects(
        () => attachToLoad(s, randomUUID(), load.id),
        (e: DocumentError) => e.code === 'not_found',
      );
    });
  });

  describe('recordExtraction', () => {
    it('stores the reading and moves the document to extracted', async () => {
      const { document } = await upload();
      const row = await recordExtraction(s, document.id, {
        extracted: { rate: 240000, weight: 42000, broker: 'Prairie Freight' },
        extractorVersion: 'azure-di-2024-11-30/rateconf-v3',
        kind: 'rate_confirmation',
        kindConfidence: 0.97,
        pageCount: 2,
      });

      assert.equal(row.status, 'extracted');
      assert.equal(row.kind, 'rate_confirmation');
      assert.equal(row.kindConfidence, 0.97);
      assert.equal(row.pageCount, 2);
      assert.equal(row.extractorVersion, 'azure-di-2024-11-30/rateconf-v3');
      assert.ok(row.extractedAt instanceof Date);
      assert.deepEqual(row.extracted, {
        rate: 240000,
        weight: 42000,
        broker: 'Prairie Freight',
      });
    });

    it('overwrites, because re-running an extractor is the point of versioning it', async () => {
      const { document } = await upload();
      await recordExtraction(s, document.id, {
        extracted: { rate: 1 },
        extractorVersion: 'v1',
      });
      const again = await recordExtraction(s, document.id, {
        extracted: { rate: 2 },
        extractorVersion: 'v2',
      });
      assert.deepEqual(again.extracted, { rate: 2 });
      assert.equal(again.extractorVersion, 'v2');
    });

    it('does not need a load', async () => {
      const { document } = await upload();
      const row = await recordExtraction(s, document.id, {
        extracted: {},
        extractorVersion: 'v1',
      });
      assert.equal(row.loadId, null);
      assert.equal(row.status, 'extracted');
    });
  });

  describe('recordManualFields', () => {
    it('writes the fields, tagged as manual entry', async () => {
      const { document } = await upload();
      const row = await recordManualFields(s, document.id, {
        fields: { rateAmount: { value: 240000, raw: '$2,400.00', label: 'manual-entry' } },
      });

      assert.equal(row.status, 'extracted');
      assert.equal(row.extractorVersion, 'manual-entry');
      assert.ok(row.extractedAt instanceof Date);
      assert.deepEqual(row.extracted, {
        rateAmount: { value: 240000, raw: '$2,400.00', label: 'manual-entry' },
      });
    });

    it('merges into an existing reading rather than replacing it', async () => {
      const { document } = await upload();
      await recordExtraction(s, document.id, {
        extracted: {
          rateAmount: { value: 1, raw: '$0.01', label: 'rate' },
          weightLbs: { value: 42000, raw: '42,000', label: 'weight' },
        },
        extractorVersion: 'deterministic-v1',
      });

      const row = await recordManualFields(s, document.id, {
        fields: { rateAmount: { value: 240000, raw: '$2,400.00', label: 'manual-entry' } },
      });

      // The corrected field wins, but the field the pipeline already got
      // right survives — a correction is not a do-over.
      assert.deepEqual(row.extracted, {
        rateAmount: { value: 240000, raw: '$2,400.00', label: 'manual-entry' },
        weightLbs: { value: 42000, raw: '42,000', label: 'weight' },
      });
      assert.equal(row.extractorVersion, 'manual-entry');
    });

    it('records the real signed-in user as the actor, not a synthesized one', async () => {
      const { document } = await upload();
      await recordManualFields(s, document.id, {
        fields: { rateAmount: { value: 240000, raw: '$2,400.00', label: 'manual-entry' } },
      });

      const events = await readTimeline(s, { subjectId: document.id });
      const entry = events.find((e) => e.verb === 'document.extracted');
      assert.ok(entry);
      assert.equal(entry.actorType, 'user');
      // `event_log.actor_id` is the display string — a user's email, same as
      // every other user-authored event — not the raw uuid.
      assert.equal(entry.actorId, userEmail);
      assert.match(entry.explanation, /manual-entry/);
    });

    it('refuses a quarantined document', async () => {
      const { document } = await upload();
      await quarantineDocument(s, document.id, 'failed the content check');
      await assert.rejects(
        () =>
          recordManualFields(s, document.id, {
            fields: { rateAmount: { value: 1, raw: '$0.01', label: 'manual-entry' } },
          }),
        (e: DocumentError) => e.code === 'quarantined',
      );
    });
  });

  describe('recordValidation', () => {
    it('validates when everything agrees, and leaves no reason behind', async () => {
      const load = await aLoad();
      const { document } = await upload();
      await attachToLoad(s, document.id, load.id);

      const { document: row, verdict } = await recordValidation(s, document.id, agreeing);
      assert.equal(verdict.outcome, 'validated');
      assert.equal(row.status, 'validated');
      assert.equal(row.rejectionReason, null);
      assert.ok(row.validatedAt instanceof Date);
      assert.deepEqual(row.validation, agreeing);
    });

    it('rejects with a sentence a carrier can act on', async () => {
      const load = await aLoad();
      const { document } = await upload();
      await attachToLoad(s, document.id, load.id);

      const { document: row, verdict } = await recordValidation(
        s,
        document.id,
        disagreeing,
      );
      assert.equal(verdict.outcome, 'rejected');
      assert.equal(row.status, 'rejected');
      assert.equal(
        row.rejectionReason,
        'rateAmount is $2,400.00 on the document but $2,600.00 on the load.',
      );
    });

    it('clears the reason when a corrected document passes', async () => {
      const load = await aLoad();
      const { document } = await upload();
      await attachToLoad(s, document.id, load.id);

      await recordValidation(s, document.id, disagreeing);
      const { document: fixed } = await recordValidation(s, document.id, agreeing);
      assert.equal(fixed.status, 'validated');
      assert.equal(
        fixed.rejectionReason,
        null,
        'a document that no longer disagrees must stop explaining a problem it does not have',
      );
    });

    it('does not reject on a warning', async () => {
      const load = await aLoad();
      const { document } = await upload();
      await attachToLoad(s, document.id, load.id);

      const { document: row } = await recordValidation(s, document.id, [
        { ...disagreeing[0]!, severity: 'warning' },
      ]);
      assert.equal(row.status, 'validated');
      assert.equal(row.rejectionReason, null);
    });

    it('refuses to validate a document no load claims', async () => {
      const { document } = await upload();
      await assert.rejects(
        () => recordValidation(s, document.id, agreeing),
        (e: DocumentError) => e.code === 'not_attached',
      );
    });
  });

  describe('quarantine', () => {
    it('refuses every further write', async () => {
      const load = await aLoad();
      const { document } = await upload();
      await attachToLoad(s, document.id, load.id);
      await quarantineDocument(s, document.id, 'failed the content check');

      const quarantined = (e: DocumentError) => e.code === 'quarantined';
      await assert.rejects(() => attachToLoad(s, document.id, load.id), quarantined);
      await assert.rejects(
        () => recordExtraction(s, document.id, { extracted: {}, extractorVersion: 'v1' }),
        quarantined,
      );
      await assert.rejects(
        () => recordValidation(s, document.id, agreeing),
        quarantined,
      );
    });
  });
});
