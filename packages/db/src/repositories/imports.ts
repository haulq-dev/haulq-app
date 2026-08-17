/**
 * CSV import.
 *
 * Phase 0's exit gate: a real carrier importing 30–90 days of loads so the
 * scoring weights have something to be tuned against. Build plan section 13 is
 * blunt that without this dataset they cannot be tuned at all.
 *
 * ---------------------------------------------------------------------------
 * Staged, not streamed
 * ---------------------------------------------------------------------------
 *
 *   uploaded → mapping → validating → ready → committing → committed
 *
 * The alternative — parse and insert in one pass — fails on row 400 of 900 with
 * half the data written and no way to resume. That is the outcome that makes a
 * carrier give up, and giving up here costs the tuning dataset.
 *
 * So: rows are parsed into `import_rows` with their errors attached, the
 * operator sees the damage and fixes their file or proceeds, and the commit is
 * one transaction that either produces every load or none.
 *
 * ---------------------------------------------------------------------------
 * The original cells are kept forever
 * ---------------------------------------------------------------------------
 *
 * `import_rows.raw` holds the source cells after commit, not just during. When
 * a carrier says "this load's rate is wrong", the answer is either "your file
 * said $1,800" or "we parsed it wrong", and without the original values there
 * is no way to tell which — which makes the whole import untrustworthy at
 * exactly the moment trust matters.
 */

import {
  brokerMatchKey,
  coerceRow,
  parseCsv,
  rowHasErrors,
  type ColumnMapping,
  type CoercedRow,
  type ParsedLoadRow,
} from '@haulq/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { brokers } from '../schema/brokers.ts';
import { importBatches, importRows } from '../schema/imports.ts';
import { loads, loadStops } from '../schema/loads.ts';
import { trucks } from '../schema/fleet.ts';
import { withTransaction } from '../transaction.ts';

export type ImportBatch = typeof importBatches.$inferSelect;
export type ImportRow = typeof importRows.$inferSelect;

export class ImportError extends Error {
  readonly explanation: string;

  constructor(message: string, explanation: string) {
    super(message);
    this.name = 'ImportError';
    this.explanation = explanation;
  }
}

// ---------------------------------------------------------------------------
// Stage 1–3: upload, parse, validate
// ---------------------------------------------------------------------------

export interface StartImportInput {
  filename: string;
  storageKey: string;
  sha256: string;
  text: string;
  /** Confirmed by the operator. When absent the batch stops at `mapping`. */
  mapping?: ColumnMapping | undefined;
}

/**
 * Parse an uploaded file into staged rows.
 *
 * Without a confirmed mapping the batch stops at `mapping` and no rows are
 * written — there is nothing meaningful to validate against a guess, and
 * writing rows twice (once on the guess, once on the confirmation) means the
 * second pass has to clean up after the first.
 */
export async function startImport(
  s: Scope,
  input: StartImportInput,
): Promise<{ batch: ImportBatch; headers: string[]; sampleRows: Record<string, string>[] }> {
  const parsed = parseCsv(input.text);

  if (parsed.headers.length === 0 || parsed.rows.length === 0) {
    throw new ImportError(
      'empty csv',
      'That file has no rows HaulQ could read. Check it opens as a spreadsheet and has a header row.',
    );
  }

  return withTransaction(s, async (tx) => {
    const [batch] = await tx.db
      .insert(importBatches)
      .values({
        orgId: tx.ctx.orgId,
        status: input.mapping ? 'validating' : 'mapping',
        entity: 'loads',
        filename: input.filename,
        storageKey: input.storageKey,
        sha256: input.sha256,
        dialect: parsed.dialect,
        columnMapping: input.mapping ?? {},
        totalRows: parsed.rows.length,
        ...(tx.ctx.actor.type === 'user' ? { uploadedByUserId: tx.ctx.actor.id } : {}),
      })
      .returning();
    if (!batch) throw new Error('import batch insert returned nothing');

    await recordEvent(tx, 'import.uploaded', {
      subjectId: batch.id,
      payload: { filename: input.filename, rowCount: parsed.rows.length },
    });

    if (input.mapping) {
      await stageRows(tx, batch.id, parsed.rows, input.mapping);
    }

    return {
      batch,
      headers: parsed.headers,
      // Enough to render the mapping screen with real values beside each
      // header. Guessing from column names alone is how "Rate" gets mapped to
      // linehaul when it is all-in.
      sampleRows: parsed.rows.slice(0, 5).map((r) => r.cells),
    };
  });
}

async function stageRows(
  s: Scope,
  batchId: string,
  rows: Array<{ rowNumber: number; cells: Record<string, string>; issues: string[] }>,
  mapping: ColumnMapping,
): Promise<{ valid: number; invalid: number }> {
  let valid = 0;
  let invalid = 0;

  const values = rows.map((row) => {
    const coerced: CoercedRow = coerceRow(row.cells, mapping);

    // Structural problems found by the parser — a ragged row — join the
    // coercion issues so the operator sees one list per row rather than two.
    const issues = [
      ...row.issues.map((message) => ({
        field: 'row',
        severity: 'warning' as const,
        message,
      })),
      ...coerced.issues,
    ];

    const bad = rowHasErrors(issues);
    if (bad) invalid++;
    else valid++;

    return {
      orgId: s.ctx.orgId,
      batchId,
      rowNumber: row.rowNumber,
      status: bad ? ('invalid' as const) : ('valid' as const),
      raw: row.cells,
      parsed: coerced.parsed,
      errors: issues,
    };
  });

  // Chunked because a 90-day import is a few thousand rows and a single insert
  // with that many parameter bindings exceeds what the driver will send.
  for (let i = 0; i < values.length; i += 500) {
    await s.db.insert(importRows).values(values.slice(i, i + 500));
  }

  await s.db
    .update(importBatches)
    .set({ status: 'ready', validRows: valid, invalidRows: invalid })
    .where(eq(importBatches.id, batchId));

  return { valid, invalid };
}

/**
 * Apply a mapping to a batch that was waiting for one.
 *
 * Re-reads the file rather than caching the parse. Imports are minutes apart at
 * most, the file is small, and holding a parsed copy in memory between two
 * requests is a cache that has to be invalidated and a memory ceiling that has
 * to be enforced — for a saving nobody will notice.
 */
export async function applyMapping(
  s: Scope,
  batchId: string,
  mapping: ColumnMapping,
  text: string,
): Promise<ImportBatch> {
  return withTransaction(s, async (tx) => {
    const batch = await getBatch(tx, batchId);
    if (!batch) throw new ImportError('batch not found', 'That import no longer exists.');
    if (batch.status === 'committed') {
      throw new ImportError(
        'already committed',
        'That import has already been committed. Upload the file again to import more.',
      );
    }

    await tx.db.delete(importRows).where(eq(importRows.batchId, batchId));

    const parsed = parseCsv(text);
    await tx.db
      .update(importBatches)
      .set({ columnMapping: mapping, status: 'validating' })
      .where(eq(importBatches.id, batchId));

    await stageRows(tx, batchId, parsed.rows, mapping);

    const updated = await getBatch(tx, batchId);
    return updated!;
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getBatch(s: Scope, id: string): Promise<ImportBatch | undefined> {
  const [row] = await s.db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.id, id), eq(importBatches.orgId, s.ctx.orgId)));
  return row;
}

export async function listBatches(s: Scope): Promise<ImportBatch[]> {
  return s.db
    .select()
    .from(importBatches)
    .where(eq(importBatches.orgId, s.ctx.orgId))
    .orderBy(asc(importBatches.createdAt));
}

export async function listRows(
  s: Scope,
  batchId: string,
  opts: { onlyInvalid?: boolean; limit?: number } = {},
): Promise<ImportRow[]> {
  const conditions = [
    eq(importRows.orgId, s.ctx.orgId),
    eq(importRows.batchId, batchId),
  ];
  if (opts.onlyInvalid) conditions.push(eq(importRows.status, 'invalid'));

  return s.db
    .select()
    .from(importRows)
    .where(and(...conditions))
    .orderBy(asc(importRows.rowNumber))
    .limit(Math.min(opts.limit ?? 100, 500));
}

// ---------------------------------------------------------------------------
// Stage 5: commit
// ---------------------------------------------------------------------------

export interface CommitResult {
  committed: number;
  skipped: number;
  brokersCreated: number;
}

/**
 * Turn staged rows into loads.
 *
 * One transaction for the whole batch. Partially-committed history is worse
 * than none: the carrier cannot tell which loads made it, re-running duplicates
 * the ones that did, and the margin figures drawn from it are wrong in a way
 * that looks plausible.
 *
 * Invalid rows are skipped, not fatal. The operator has already seen the count
 * and chosen to proceed — refusing at this point would mean a single unreadable
 * date in ninety days of history blocks the entire exit gate.
 */
export async function commitImport(s: Scope, batchId: string): Promise<CommitResult> {
  return withTransaction(s, async (tx) => {
    const batch = await getBatch(tx, batchId);
    if (!batch) throw new ImportError('batch not found', 'That import no longer exists.');
    if (batch.status === 'committed') {
      throw new ImportError(
        'already committed',
        'That import has already been committed.',
      );
    }
    if (batch.status !== 'ready') {
      throw new ImportError(
        `batch is ${batch.status}`,
        'That import is not ready to commit yet. Confirm the column mapping first.',
      );
    }

    await tx.db
      .update(importBatches)
      .set({ status: 'committing' })
      .where(eq(importBatches.id, batchId));

    const staged = await tx.db
      .select()
      .from(importRows)
      .where(and(eq(importRows.batchId, batchId), eq(importRows.status, 'valid')))
      .orderBy(asc(importRows.rowNumber));

    const brokerCache = await loadBrokerCache(tx);
    const truckCache = await loadTruckCache(tx);
    let brokersCreated = 0;
    let committed = 0;

    for (const row of staged) {
      const parsed = (row.parsed ?? {}) as ParsedLoadRow;

      let brokerId: string | null = null;
      if (parsed.brokerName) {
        const key = brokerMatchKey(parsed.brokerName);
        const existing = brokerCache.get(key);
        if (existing) {
          brokerId = existing;
        } else {
          const [created] = await tx.db
            .insert(brokers)
            .values({ orgId: tx.ctx.orgId, name: parsed.brokerName })
            .returning({ id: brokers.id });
          brokerId = created!.id;
          brokerCache.set(key, brokerId);
          brokersCreated++;
        }
      }

      const truckId = parsed.truckLabel
        ? (truckCache.get(parsed.truckLabel.trim().toLowerCase()) ?? null)
        : null;

      const [load] = await tx.db
        .insert(loads)
        .values({
          orgId: tx.ctx.orgId,
          source: 'csv_import',
          // Imported history is delivered by definition. The status machine
          // exempts csv_import from needing a truck, because a carrier's old
          // system frequently did not record one — see 0300_load_status.sql.
          status: 'delivered',
          ...(parsed.reference !== undefined ? { reference: parsed.reference } : {}),
          brokerId,
          truckId,
          ...(parsed.brokerLoadNumber ? { brokerLoadNumber: parsed.brokerLoadNumber } : {}),
          ...(parsed.commodity ? { commodity: parsed.commodity } : {}),
          ...(parsed.weightLbs !== undefined ? { weightLbs: parsed.weightLbs } : {}),
          ...(parsed.notes ? { comments: parsed.notes } : {}),
          ...(parsed.rateAmount !== undefined
            ? { rateAmount: parsed.rateAmount, rateCurrency: 'USD' }
            : {}),
          // Imported miles are what actually happened, not a prediction. They
          // go in the actual_ columns; leaving expected_ null is correct and
          // keeps the closed loop honest — HaulQ never predicted these.
          ...(parsed.loadedMiles !== undefined
            ? { actualLoadedMiles: parsed.loadedMiles }
            : {}),
          ...(parsed.deadheadMiles !== undefined
            ? { actualDeadheadMiles: parsed.deadheadMiles }
            : {}),
          ...(parsed.rateAmount !== undefined
            ? { actualRevenueAmount: parsed.rateAmount, actualRevenueCurrency: 'USD' }
            : {}),
          bookedAt: parsed.pickupDate ? new Date(parsed.pickupDate) : new Date(),
          deliveredAt: parsed.deliveryDate ? new Date(parsed.deliveryDate) : new Date(),
        })
        .returning({ id: loads.id });

      if (!load) throw new Error('load insert returned nothing');

      const stops: Array<typeof loadStops.$inferInsert> = [];
      if (parsed.originCity) {
        stops.push({
          orgId: tx.ctx.orgId,
          loadId: load.id,
          seq: 1,
          type: 'pickup',
          city: parsed.originCity,
          state: parsed.originState ?? '',
          ...(parsed.pickupDate ? { windowStart: new Date(parsed.pickupDate) } : {}),
        });
      }
      if (parsed.destCity) {
        stops.push({
          orgId: tx.ctx.orgId,
          loadId: load.id,
          seq: stops.length + 1,
          type: 'delivery',
          city: parsed.destCity,
          state: parsed.destState ?? '',
          ...(parsed.deliveryDate ? { windowStart: new Date(parsed.deliveryDate) } : {}),
        });
      }
      if (stops.length) await tx.db.insert(loadStops).values(stops);

      await tx.db
        .update(importRows)
        .set({ status: 'committed', loadId: load.id })
        .where(eq(importRows.id, row.id));

      committed++;
    }

    const skipped = batch.invalidRows;

    await tx.db
      .update(importBatches)
      .set({ status: 'committed', committedRows: committed, committedAt: new Date() })
      .where(eq(importBatches.id, batchId));

    // One event for the batch, not one per load. Ninety events saying "created
    // load 12" would bury every other entry in the carrier's timeline, and the
    // per-load provenance is already recoverable via import_rows.load_id.
    await recordEvent(tx, 'import.committed', {
      subjectId: batchId,
      payload: { filename: batch.filename, committed, skipped },
    });

    return { committed, skipped, brokersCreated };
  });
}

async function loadBrokerCache(s: Scope): Promise<Map<string, string>> {
  const rows = await s.db
    .select({ id: brokers.id, name: brokers.name })
    .from(brokers)
    .where(eq(brokers.orgId, s.ctx.orgId));

  const cache = new Map<string, string>();
  for (const r of rows) cache.set(brokerMatchKey(r.name), r.id);
  return cache;
}

async function loadTruckCache(s: Scope): Promise<Map<string, string>> {
  const rows = await s.db
    .select({ id: trucks.id, label: trucks.label })
    .from(trucks)
    .where(eq(trucks.orgId, s.ctx.orgId));

  const cache = new Map<string, string>();
  for (const r of rows) cache.set(r.label.trim().toLowerCase(), r.id);
  return cache;
}

// ---------------------------------------------------------------------------
// What the import produced
// ---------------------------------------------------------------------------

export interface ImportSummary {
  loadCount: number;
  periodDays: number;
  earliest: Date | null;
  latest: Date | null;
  totalRevenueCents: number;
  totalMiles: number;
  /** Revenue per total mile, in cents. The figure to check costs against. */
  revenuePerMileCents: number | null;
}

/**
 * Summarise a carrier's imported history.
 *
 * This is what makes the exit gate actionable rather than ceremonial. A carrier
 * who has entered $1.35/mi as their cost and whose imported history shows
 * $1.28/mi in revenue has a problem worth knowing about before HaulQ starts
 * recommending loads on those numbers.
 */
export async function importedHistorySummary(s: Scope): Promise<ImportSummary> {
  const [row] = await s.db
    .select({
      loadCount: sql<number>`count(*)::int`,
      earliest: sql<Date | null>`min(${loads.deliveredAt})`,
      latest: sql<Date | null>`max(${loads.deliveredAt})`,
      revenue: sql<number>`coalesce(sum(${loads.actualRevenueAmount}), 0)::bigint`,
      miles: sql<number>`coalesce(sum(coalesce(${loads.actualLoadedMiles}, 0) + coalesce(${loads.actualDeadheadMiles}, 0)), 0)::int`,
    })
    .from(loads)
    .where(and(eq(loads.orgId, s.ctx.orgId), eq(loads.source, 'csv_import')));

  const loadCount = Number(row?.loadCount ?? 0);
  const revenue = Number(row?.revenue ?? 0);
  const miles = Number(row?.miles ?? 0);
  const earliest = row?.earliest ? new Date(row.earliest) : null;
  const latest = row?.latest ? new Date(row.latest) : null;

  const periodDays =
    earliest && latest
      ? Math.max(1, Math.round((latest.getTime() - earliest.getTime()) / 86_400_000))
      : 0;

  return {
    loadCount,
    periodDays,
    earliest,
    latest,
    totalRevenueCents: revenue,
    totalMiles: miles,
    revenuePerMileCents: miles > 0 ? Math.round(revenue / miles) : null,
  };
}
