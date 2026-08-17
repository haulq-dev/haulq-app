/**
 * Documents.
 *
 * The bytes live in R2. This table holds the pointer, the provenance and the
 * extraction result. Nothing binary goes in Postgres.
 *
 * Two notes:
 *
 *  - `sha256` is the dedupe key, not the filename. A broker who re-sends the
 *    rate confirmation three times should produce one document, and every
 *    intake path (email, upload, driver app) has to agree on that without
 *    coordinating.
 *
 *  - `extracted` and `validated` are separate states with separate columns.
 *    Extraction says "the model read $2,400 off this PDF". Validation says
 *    "that agrees with the load record". HaulQ Docs' whole value is the second
 *    one, and collapsing them into a single `processed` flag would delete the
 *    distinction the product sells.
 */

import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { pk, timestamps } from './_shared.ts';
import { documentSourceEnum, documentStatusEnum } from './enums.ts';
import { loads } from './loads.ts';
import { orgs, users } from './tenancy.ts';

export const documents = pgTable(
  'documents',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    /**
     * Null while unattached. A rate confirmation can arrive by email before
     * anyone has created the load, and refusing to store it until a load exists
     * means losing it.
     */
    loadId: uuid('load_id').references(() => loads.id, { onDelete: 'set null' }),

    /**
     * 'rate_confirmation' | 'bol' | 'pod' | 'invoice' | 'lumper_receipt' |
     * 'scale_ticket' | 'insurance_certificate' | 'w9' | 'other'.
     *
     * Text with a check constraint rather than an enum: the tail of document
     * types a small carrier receives is long and adding one should not be a
     * deploy. Classification writes this; a human can correct it.
     */
    kind: text('kind').notNull().default('other'),
    /** Classifier's confidence, 0–1. Below a threshold the document is queued
     *  for a human rather than routed on the guess. */
    kindConfidence: doublePrecision('kind_confidence'),

    status: documentStatusEnum('status').notNull().default('received'),
    source: documentSourceEnum('source').notNull(),

    // --- the bytes ---------------------------------------------------------
    /** R2 object key. Bucket comes from config, not from the row. */
    storageKey: text('storage_key').notNull(),
    filename: text('filename'),
    contentType: text('content_type'),
    byteSize: bigint('byte_size', { mode: 'number' }),
    /** Hex digest. Dedupe key — see the module note. */
    sha256: text('sha256').notNull(),
    pageCount: bigint('page_count', { mode: 'number' }),

    // --- where it came from ------------------------------------------------
    /** Sender address for email intake, uploader for the rest. */
    receivedFrom: text('received_from'),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Provider message id, so an intake can be traced back to the mailbox. */
    intakeMessageId: text('intake_message_id'),
    receivedAt: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // --- extraction, then validation ---------------------------------------
    /** What the classifier and extractor read off the page. Model output. */
    extracted: jsonb('extracted'),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    /** Which model and version produced `extracted`. Needed to re-run a cohort. */
    extractorVersion: text('extractor_version'),

    /**
     * Field-by-field agreement with the load record. Shape is
     * `{ field, documentValue, loadValue, agrees, severity }[]`.
     * This is the product, not `extracted`.
     */
    validation: jsonb('validation'),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    /** Populated when status is `rejected`. Human-readable, shown in the UI. */
    rejectionReason: text('rejection_reason'),

    ...timestamps,
  },
  (t) => [
    index('documents_org_idx').on(t.orgId),
    index('documents_org_status_idx').on(t.orgId, t.status),
    index('documents_load_idx').on(t.loadId),
    /** Dedupe. One org, one file, one row — regardless of intake path. */
    uniqueIndex('documents_org_sha_key').on(t.orgId, t.sha256),
    index('documents_unattached_idx')
      .on(t.orgId, t.receivedAt)
      .where(sql`load_id is null`),
  ],
);

export const documentsRelations = relations(documents, ({ one }) => ({
  org: one(orgs, { fields: [documents.orgId], references: [orgs.id] }),
  load: one(loads, { fields: [documents.loadId], references: [loads.id] }),
  uploadedBy: one(users, {
    fields: [documents.uploadedByUserId],
    references: [users.id],
  }),
}));
