/**
 * CSV import.
 *
 * This is not a utility. Build plan section 4 makes it Phase 0's exit gate — "a
 * real carrier can import 30–90 days of loads and reconcile the operating facts
 * used in scoring" — and section 13 warns that without that dataset the scoring
 * weights cannot be tuned at all. The import is the thing that unblocks the
 * economics work.
 *
 * Which is why it is staged rather than streamed straight into `loads`:
 *
 *  1. `uploaded`   — file in R2, nothing parsed
 *  2. `mapping`    — operator maps their columns onto ours; guesses proposed
 *  3. `validating` — every row parsed into `import_rows`, errors attached
 *  4. `ready`      — operator has seen the error count and can proceed or fix
 *  5. `committing` → `committed` — rows become loads, in one transaction
 *
 * A carrier's historical export is messy in ways no schema anticipates. Failing
 * on row 400 of 900 with half the data written is the outcome that makes them
 * give up, and giving up here costs the tuning dataset.
 */

import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { pk, timestamps } from './_shared.ts';
import { importRowStatusEnum, importStatusEnum } from './enums.ts';
import { loads } from './loads.ts';
import { orgs, users } from './tenancy.ts';

export const importBatches = pgTable(
  'import_batches',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    status: importStatusEnum('status').notNull().default('uploaded'),
    /** 'loads' for now. 'brokers' and 'invoices' follow the same machinery. */
    entity: text('entity').notNull().default('loads'),

    filename: text('filename').notNull(),
    storageKey: text('storage_key').notNull(),
    sha256: text('sha256'),

    /**
     * Operator's column mapping: `{ "Pickup City": "stops.0.city", ... }`.
     * Proposed by header matching, confirmed by a human. Stored because the
     * next month's file from the same carrier will have the same headers.
     */
    columnMapping: jsonb('column_mapping').notNull().default(sql`'{}'::jsonb`),
    /** Detected header row, delimiter, date format, encoding. */
    dialect: jsonb('dialect').notNull().default(sql`'{}'::jsonb`),

    totalRows: integer('total_rows').notNull().default(0),
    validRows: integer('valid_rows').notNull().default(0),
    invalidRows: integer('invalid_rows').notNull().default(0),
    committedRows: integer('committed_rows').notNull().default(0),

    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    failedReason: text('failed_reason'),

    ...timestamps,
  },
  (t) => [
    index('import_batches_org_idx').on(t.orgId),
    index('import_batches_org_status_idx').on(t.orgId, t.status),
  ],
);

/**
 * One row of the file, parsed but not yet committed.
 *
 * `raw` is kept after commit. When a carrier says "this load's rate is wrong",
 * the answer is either "your file said $1,800" or "we parsed it wrong", and
 * without the original cell values there is no way to tell which.
 */
export const importRows = pgTable(
  'import_rows',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),

    /** Line number in the source file, 1-based, header excluded. */
    rowNumber: integer('row_number').notNull(),
    status: importRowStatusEnum('status').notNull().default('pending'),

    /** The original cells, keyed by header. Never discarded — see the note. */
    raw: jsonb('raw').notNull(),
    /** After mapping and coercion. Shaped like a load insert. */
    parsed: jsonb('parsed'),
    /** `{ field, message, severity }[]`. Shown next to the row in the UI. */
    errors: jsonb('errors').notNull().default(sql`'[]'::jsonb`),

    /** Set on commit. The link back from a load to the file it came from. */
    loadId: uuid('load_id').references(() => loads.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('import_rows_batch_idx').on(t.batchId, t.rowNumber),
    index('import_rows_batch_status_idx').on(t.batchId, t.status),
    index('import_rows_org_idx').on(t.orgId),
  ],
);

export const importBatchesRelations = relations(
  importBatches,
  ({ one, many }) => ({
    org: one(orgs, { fields: [importBatches.orgId], references: [orgs.id] }),
    rows: many(importRows),
  }),
);

export const importRowsRelations = relations(importRows, ({ one }) => ({
  batch: one(importBatches, {
    fields: [importRows.batchId],
    references: [importBatches.id],
  }),
  load: one(loads, { fields: [importRows.loadId], references: [loads.id] }),
}));
