/**
 * CSV import, end to end.
 *
 * The fixture below is deliberately awful, and every defect in it is one a real
 * carrier export actually has: a title block above the headers, mixed date
 * formats, accounting parentheses, an unquoted comma, a totals row, the same
 * broker written three ways, and one row that cannot be salvaged.
 *
 * The test is not "does it parse" — it is "does a carrier get their 90 days of
 * history in, and does HaulQ tell the truth about what it could not read."
 * Phase 0's exit gate depends on the answer.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addTestMembership,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  MemoryObjectStore,
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

/**
 * A carrier's real export, warts and all.
 *
 *  - two title rows and a blank line above the headers
 *  - "Rate" in three formats, one of them unreadable
 *  - dates in ISO, US slash, and named-month form
 *  - Acme written three ways — one broker, not three
 *  - an unquoted comma in row 4's origin
 *  - a totals row at the bottom
 */
const MESSY_CSV = [
  'Load History Report',
  'Prairie Freight LLC — 01 Mar 2026 to 31 May 2026',
  '',
  'Load #,Broker,Pickup City,Pickup State,Delivery City,Delivery State,Pickup Date,Delivery Date,Rate,Miles',
  '1001,Acme Logistics,Wichita,KS,Denver,CO,2026-03-02,2026-03-04,"$2,400.00",520',
  '1002,"ACME LOGISTICS, INC.",Tulsa,OK,Dallas,TX,3/5/2026,3/6/2026,1800,290',
  '1003,Apex Freight Co,Omaha,NE,Des Moines,IA,10 Mar 2026,11 Mar 2026,"$1,150.50",135',
  '1004,Acme Logistics LLC,Kansas City, MO,Chicago,IL,3/15/2026,3/16/2026,2100,510',
  '1005,Beta Transport,Springfield,MO,Memphis,TN,3/20/2026,ASAP,975,285',
  '1006,Apex Freight,Wichita,KS,Amarillo,TX,3/22/2026,3/23/2026,see invoice,340',
  ',,,,,,,,"$8,425.50",2080',
].join('\n');

const upload = async (orgId: string, csv: string, filename = 'history.csv') =>
  app.inject({
    method: 'POST',
    url: `/v1/imports?filename=${filename}`,
    headers: {
      'x-haulq-org-id': orgId,
      'x-haulq-user-id': userId,
      'content-type': 'text/csv',
    },
    payload: csv,
  });

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

/** Upload, confirm the guessed mapping, commit. The whole happy path. */
async function importAll(orgId: string, csv = MESSY_CSV) {
  const uploaded = await upload(orgId, csv);
  const { batch, suggestedMapping } = uploaded.json();

  const mapping = Object.fromEntries(
    (suggestedMapping as Array<{ header: string; field: string | null }>).map((g) => [
      g.header,
      g.field,
    ]),
  );

  const mapped = await app.inject({
    method: 'PUT',
    url: `/v1/imports/${batch.id}/mapping`,
    headers: as(orgId),
    payload: mapping,
  });

  const committed = await app.inject({
    method: 'POST',
    url: `/v1/imports/${batch.id}/commit`,
    headers: as(orgId),
  });

  return { batchId: batch.id, uploaded, mapped, committed };
}

suite('csv import', () => {
  before(async () => {
    app = await buildServer(
      loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }),
      { storage: new MemoryObjectStore() },
    );
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    for (const id of driverIds) await destroyTestUser(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  // --- upload and mapping --------------------------------------------------

  describe('upload', () => {
    it('finds the headers under a title block and proposes a mapping', async () => {
      const orgId = await newOrg('Upload Co');
      const res = await upload(orgId, MESSY_CSV);

      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.equal(body.batch.status, 'mapping');
      assert.equal(body.headers[0], 'Load #');

      const mapping = Object.fromEntries(
        (body.suggestedMapping as Array<{ header: string; field: string | null }>).map(
          (g) => [g.header, g.field],
        ),
      );
      assert.equal(mapping['Broker'], 'brokerName');
      assert.equal(mapping['Delivery Date'], 'deliveryDate');
    });

    it('returns sample rows so the operator can check the guess', async () => {
      // Column names alone are how "Rate" gets mapped to linehaul when it is
      // all-in. Real values beside each header prevent that.
      const orgId = await newOrg('Sample Co');
      const res = await upload(orgId, MESSY_CSV);
      const samples = res.json().sampleRows as Record<string, string>[];

      assert.equal(samples.length, 5);
      assert.equal(samples[0]!['Broker'], 'Acme Logistics');
    });

    it('writes no rows until a mapping is confirmed', async () => {
      const orgId = await newOrg('No Rows Yet');
      const { batch } = (await upload(orgId, MESSY_CSV)).json();

      const detail = await app.inject({
        method: 'GET',
        url: `/v1/imports/${batch.id}`,
        headers: as(orgId),
      });
      assert.equal(detail.json().rows.length, 0);
    });

    it('explains a file it cannot read', async () => {
      const orgId = await newOrg('Bad File');
      const res = await upload(orgId, 'this is not a csv at all');
      assert.equal(res.statusCode, 400);
      assert.match(res.json().explanation, /opens as a spreadsheet/);
    });

    it('refuses an empty body', async () => {
      const orgId = await newOrg('Empty Body');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/imports',
        headers: as(orgId, { 'content-type': 'text/csv' }),
        payload: '',
      });
      assert.equal(res.statusCode, 400);
    });
  });

  // --- validation ----------------------------------------------------------

  describe('validation', () => {
    it('separates the salvageable rows from the broken ones', async () => {
      const orgId = await newOrg('Validation Co');
      const { batch, suggestedMapping } = (await upload(orgId, MESSY_CSV)).json();

      const mapping = Object.fromEntries(
        (suggestedMapping as Array<{ header: string; field: string | null }>).map(
          (g) => [g.header, g.field],
        ),
      );

      const res = await app.inject({
        method: 'PUT',
        url: `/v1/imports/${batch.id}/mapping`,
        headers: as(orgId),
        payload: mapping,
      });

      const updated = res.json().batch;
      assert.equal(updated.status, 'ready');
      // Six loads; the totals row is not one. Two are broken: "ASAP" as a
      // delivery date and "see invoice" as a rate.
      assert.equal(updated.totalRows, 6);
      assert.equal(updated.invalidRows, 2);
      assert.equal(updated.validRows, 4);
    });

    it('says which row and which column, in words', async () => {
      const orgId = await newOrg('Row Errors Co');
      const { batch, suggestedMapping } = (await upload(orgId, MESSY_CSV)).json();
      const mapping = Object.fromEntries(
        (suggestedMapping as Array<{ header: string; field: string | null }>).map(
          (g) => [g.header, g.field],
        ),
      );

      const res = await app.inject({
        method: 'PUT',
        url: `/v1/imports/${batch.id}/mapping`,
        headers: as(orgId),
        payload: mapping,
      });

      const invalid = res.json().invalidRows as Array<{
        rowNumber: number;
        errors: Array<{ field: string; message: string }>;
      }>;

      const messages = invalid.flatMap((r) => r.errors.map((e) => e.message)).join('\n');
      assert.match(messages, /"ASAP" is not a date/);
      assert.match(messages, /"see invoice" is not an amount/);
    });

    it('keeps the original cells for every row', async () => {
      // "Your file said $1,800" versus "we parsed it wrong" — without the
      // source values there is no way to tell which, and the whole import
      // becomes untrustworthy at the moment trust matters.
      const orgId = await newOrg('Provenance Co');
      const { batchId } = await importAll(orgId);

      const detail = await app.inject({
        method: 'GET',
        url: `/v1/imports/${batchId}`,
        headers: as(orgId),
      });
      const rows = detail.json().rows as Array<{ raw: Record<string, string> }>;
      assert.equal(rows[0]!.raw['Rate'], '$2,400.00');
    });
  });

  // --- commit --------------------------------------------------------------

  describe('commit', () => {
    it('creates loads and skips the rows it could not read', async () => {
      const orgId = await newOrg('Commit Co');
      const { committed } = await importAll(orgId);

      assert.equal(committed.statusCode, 200);
      const result = committed.json();
      assert.equal(result.committed, 4);
      assert.equal(result.skipped, 2);
    });

    it('collapses one broker written three ways into one record', async () => {
      // Acme appears as "Acme Logistics", "ACME LOGISTICS, INC." and "Acme
      // Logistics LLC". Three rows would split broker profitability three ways
      // and leave the carrier merging duplicates by hand.
      const orgId = await newOrg('Broker Matching Co');
      const { committed } = await importAll(orgId);

      // Acme (3 rows, one of which is invalid) and Apex — two brokers, not five.
      assert.equal(committed.json().brokersCreated, 2);
    });

    it('stores imported miles and revenue as actuals, never as predictions', async () => {
      // HaulQ never predicted these. Putting them in expected_ would fake a
      // closed loop and poison the tuning data the import exists to provide.
      const orgId = await newOrg('Actuals Co');
      await importAll(orgId);

      const summary = await app.inject({
        method: 'GET',
        url: '/v1/imports/history-summary',
        headers: as(orgId),
      });
      const body = summary.json();

      assert.equal(body.loadCount, 4);
      assert.equal(body.totalRevenueCents, 240_000 + 180_000 + 115_050 + 210_000);
      assert.equal(body.totalMiles, 520 + 290 + 135 + 510);
      assert.ok(body.revenuePerMileCents > 0);
    });

    it('logs one event for the batch, not one per load', async () => {
      // Ninety events saying "created load 12" would bury every other entry in
      // the carrier's timeline. Per-load provenance is in import_rows.load_id.
      const orgId = await newOrg('Timeline Co');
      await importAll(orgId);

      const timeline = await app.inject({
        method: 'GET',
        url: '/v1/timeline?subjectType=import',
        headers: as(orgId),
      });
      const items = timeline.json().items as Array<{ explanation: string }>;

      assert.equal(items.length, 2, 'uploaded and committed');
      assert.match(
        items[0]!.explanation,
        /Imported 4 loads from history\.csv, skipping 2 rows with errors\./,
      );
    });

    it('refuses to commit twice', async () => {
      const orgId = await newOrg('Double Commit Co');
      const { batchId } = await importAll(orgId);

      const again = await app.inject({
        method: 'POST',
        url: `/v1/imports/${batchId}/commit`,
        headers: as(orgId),
      });
      assert.equal(again.statusCode, 409);
      assert.match(again.json().explanation, /already been committed/);
    });

    it('refuses to commit before the mapping is confirmed', async () => {
      const orgId = await newOrg('Premature Co');
      const { batch } = (await upload(orgId, MESSY_CSV)).json();

      const res = await app.inject({
        method: 'POST',
        url: `/v1/imports/${batch.id}/commit`,
        headers: as(orgId),
      });
      assert.equal(res.statusCode, 409);
      assert.match(res.json().explanation, /column mapping/);
    });

    it('refuses a driver from committing financial history', async () => {
      const orgId = await newOrg('Role Co');
      const { batch, suggestedMapping } = (await upload(orgId, MESSY_CSV)).json();
      const mapping = Object.fromEntries(
        (suggestedMapping as Array<{ header: string; field: string | null }>).map(
          (g) => [g.header, g.field],
        ),
      );
      await app.inject({
        method: 'PUT',
        url: `/v1/imports/${batch.id}/mapping`,
        headers: as(orgId),
        payload: mapping,
      });

      // A real driver membership, not a role header. The dev authenticator
      // resolves the role from org_memberships the same way Clerk does, so a
      // header alone would be overridden and this would test nothing.
      const driver = await createTestUser(app.db);
      driverIds.push(driver.id);
      await addTestMembership(app.db, { orgId, userId: driver.id, role: 'driver' });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/imports/${batch.id}/commit`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': driver.id },
      });
      assert.equal(res.statusCode, 403);
    });
  });

  // --- re-mapping ----------------------------------------------------------

  it('lets the operator correct a mapping and re-validate', async () => {
    // The whole point of staging. Getting the mapping wrong should cost a
    // click, not a re-upload and a half-written database.
    const orgId = await newOrg('Remap Co');
    const { batch } = (await upload(orgId, MESSY_CSV)).json();

    const wrong = await app.inject({
      method: 'PUT',
      url: `/v1/imports/${batch.id}/mapping`,
      headers: as(orgId),
      payload: { 'Load #': 'reference', Broker: 'brokerName' },
    });
    // No location and no delivery date mapped, so every row fails.
    assert.equal(wrong.json().batch.validRows, 0);

    const right = await app.inject({
      method: 'PUT',
      url: `/v1/imports/${batch.id}/mapping`,
      headers: as(orgId),
      payload: {
        'Load #': 'reference',
        Broker: 'brokerName',
        'Pickup City': 'originCity',
        'Pickup State': 'originState',
        'Delivery City': 'destCity',
        'Delivery State': 'destState',
        'Delivery Date': 'deliveryDate',
        Rate: 'rate',
        Miles: 'loadedMiles',
      },
    });
    assert.equal(right.json().batch.validRows, 4);
  });

  // --- the exit gate -------------------------------------------------------

  describe('reconciliation', () => {
    it('refuses on too little history to mean anything', async () => {
      // A reconciliation against four loads is a rubber stamp, and the
      // timestamp it writes would misrepresent how well-founded the numbers are.
      const orgId = await newOrg('Thin History Co');
      await importAll(orgId);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/imports/reconcile',
        headers: as(orgId),
      });
      assert.equal(res.statusCode, 409);
      assert.match(res.json().explanation, /Only 4 imported loads/);
    });

    it('completes the Phase 0 exit gate on a real dataset', async () => {
      const orgId = await newOrg('Exit Gate Co');

      // 30 loads, clean, spread across three months.
      const header =
        'Load #,Broker,Pickup City,Pickup State,Delivery City,Delivery State,Delivery Date,Rate,Miles';
      const rows = Array.from({ length: 30 }, (_, i) => {
        const day = String((i % 28) + 1).padStart(2, '0');
        const month = String((i % 3) + 3).padStart(2, '0');
        return `${2000 + i},Broker ${i % 5},Wichita,KS,Denver,CO,2026-${month}-${day},1${800 + i * 10},520`;
      });
      await importAll(orgId, [header, ...rows].join('\n'));

      await app.inject({
        method: 'PUT',
        url: '/v1/org/operating-facts',
        headers: as(orgId),
        payload: { costPerMileCents: 140, fixedWeeklyCostCents: 85_000 },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/imports/reconcile',
        headers: as(orgId),
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().summary.loadCount, 30);

      const onboarding = await app.inject({
        method: 'GET',
        url: '/v1/onboarding',
        headers: as(orgId),
      });
      const status = onboarding.json();
      assert.equal(status.factsReconciled, true);

      const reconcileStep = status.steps.find((s: { id: string }) => s.id === 'reconcile');
      assert.equal(reconcileStep.done, true);

      const timeline = await app.inject({
        method: 'GET',
        url: '/v1/timeline?subjectType=org',
        headers: as(orgId),
      });
      assert.match(
        (timeline.json().items as Array<{ explanation: string }>)[0]!.explanation,
        /Scoring now uses measured figures rather than estimates/,
      );
    });
  });

  // --- isolation -----------------------------------------------------------

  it('never shows one carrier another\'s import', async () => {
    const a = await newOrg('Import Tenant A');
    const b = await newOrg('Import Tenant B');
    const { batchId } = await importAll(a);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/imports/${batchId}`,
      headers: as(b),
    });
    assert.equal(res.statusCode, 404);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/imports',
      headers: as(b),
    });
    assert.equal(list.json().items.length, 0);
  });
});
