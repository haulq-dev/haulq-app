/**
 * Document reads and writes.
 *
 * Nothing else writes the `documents` table. The schema note on that table sets
 * out the two rules this file exists to hold up:
 *
 *  - **`sha256` is the dedupe key, not the filename.** A broker who re-sends the
 *    rate confirmation three times must produce one row, and the three intake
 *    paths — upload, email, driver app — have to agree on that without knowing
 *    about each other. `documents_org_sha_key` enforces it in the database;
 *    `createDocument` is what turns the resulting constraint violation into
 *    "here is the document you already have" instead of a failure the carrier
 *    reads.
 *
 *  - **Extraction and validation are separate states.** `recordExtraction`
 *    writes what a model read off the page. `recordValidation` writes whether
 *    that agrees with the load the carrier already agreed to. The second one is
 *    the product. They are two functions, two timestamps and two events on
 *    purpose.
 *
 * The verdict rule itself is not here — it is `summarizeValidation` in
 * `@haulq/contracts`, because the disagreement screen has to reach the same
 * conclusion as the database did and `apps/web` cannot import this package.
 *
 * ---------------------------------------------------------------------------
 * What this file does not own
 * ---------------------------------------------------------------------------
 *
 * The bytes. `ObjectStore` holds those and the caller writes them before calling
 * in, because storing a file is not transactional and pretending otherwise
 * inside a `withTransaction` block would be a lie that survives a rollback. The
 * consequence is that a losing racer in a dedupe leaves one orphaned object;
 * `createDocument` reports that in `deduped` so the caller can delete what it
 * just wrote.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  summarizeValidation,
  type DocumentKind,
  type ValidationFinding,
  type ValidationVerdict,
} from '@haulq/contracts';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { documents } from '../schema/documents.ts';
import { loads } from '../schema/loads.ts';
import { withTransaction } from '../transaction.ts';

export type Document = typeof documents.$inferSelect;
export type DocumentStatus = Document['status'];
export type DocumentSource = Document['source'];

/**
 * Raised for a rule this file enforces rather than the database.
 *
 * Same contract as `LoadError` and `MemberError`: `message` is for the log,
 * `explanation` is the sentence a carrier should read. Constraint violations
 * that come back from Postgres are translated in the route, not here.
 */
export class DocumentError extends Error {
  readonly code: string;
  readonly explanation: string;

  constructor(code: string, message: string, explanation: string) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
    this.explanation = explanation;
  }
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreateDocumentInput {
  /** R2 key. Build it with `key()` from the storage module, never by hand. */
  storageKey: string;
  /** Hex digest of the bytes as uploaded. The dedupe key. */
  sha256: string;
  source: DocumentSource;
  byteSize?: number | undefined;
  filename?: string | undefined;
  contentType?: string | undefined;
  pageCount?: number | undefined;
  /** Classification may not have run yet; `other` is the honest default. */
  kind?: DocumentKind | undefined;
  kindConfidence?: number | undefined;
  /** Set when the load is already known, e.g. a driver uploading against one. */
  loadId?: string | undefined;
  /** Sender address for email intake, or the uploader for the rest. */
  receivedFrom?: string | undefined;
  /** Provider message id, so an intake traces back to the mailbox. */
  intakeMessageId?: string | undefined;
  /** Overrides `now()`. For an email that sat in a queue before we saw it. */
  receivedAt?: Date | undefined;
}

export interface CreateDocumentResult {
  document: Document;
  /**
   * True when `(org_id, sha256)` already existed. No row was written, no event
   * was recorded, and the object the caller just uploaded is now unreferenced —
   * delete it.
   */
  deduped: boolean;
}

/**
 * Store a document record for bytes that are already in the object store.
 *
 * Deduping is not an optimisation here, it is the contract. Returning the
 * existing row for a repeat send is what lets email intake be at-least-once
 * without the carrier seeing the same rate confirmation four times.
 */
export async function createDocument(
  s: Scope,
  input: CreateDocumentInput,
): Promise<CreateDocumentResult> {
  return withTransaction(s, async (tx) => {
    // `documents.load_id` is a foreign key to `loads.id` and nothing more — the
    // constraint is satisfied by any load in the table, including another
    // carrier's. Tenant isolation on this column is this check, so it cannot be
    // skipped on the create path just because `attachToLoad` also does it.
    if (input.loadId) await loadReference(tx, input.loadId);

    const [row] = await tx.db
      .insert(documents)
      .values({
        orgId: tx.ctx.orgId,
        storageKey: input.storageKey,
        sha256: input.sha256,
        source: input.source,
        kind: input.kind ?? 'other',
        kindConfidence: input.kindConfidence ?? null,
        loadId: input.loadId ?? null,
        filename: input.filename ?? null,
        contentType: input.contentType ?? null,
        byteSize: input.byteSize ?? null,
        pageCount: input.pageCount ?? null,
        receivedFrom: input.receivedFrom ?? null,
        intakeMessageId: input.intakeMessageId ?? null,
        ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
        ...(tx.ctx.actor.type === 'user' ? { uploadedByUserId: tx.ctx.actor.id } : {}),
      })
      // Do nothing rather than a no-op update: an update would fire the
      // updated_at trigger, so re-sending a file would silently modify the
      // record of the original. A repeat send is not a change.
      .onConflictDoNothing({ target: [documents.orgId, documents.sha256] })
      .returning();

    if (!row) {
      // The conflicting insert has committed by the time ON CONFLICT declines,
      // so this select is guaranteed to find it rather than racing it.
      const existing = await findDocumentBySha(tx, input.sha256);
      if (!existing) {
        throw new Error(
          'document insert conflicted but no existing row was found for the digest',
        );
      }
      return { document: existing, deduped: true };
    }

    await recordEvent(tx, 'document.received', {
      subjectId: row.id,
      payload: {
        kind: row.kind,
        from: input.receivedFrom ?? input.filename ?? 'an upload',
      },
    });

    return { document: row, deduped: false };
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every read is org-scoped. There is no unscoped variant on purpose. */
const inOrg = (s: Scope) => eq(documents.orgId, s.ctx.orgId);

export async function getDocument(s: Scope, id: string): Promise<Document | undefined> {
  const [row] = await s.db
    .select()
    .from(documents)
    .where(and(inOrg(s), eq(documents.id, id)))
    .limit(1);
  return row;
}

export async function findDocumentBySha(
  s: Scope,
  sha256: string,
): Promise<Document | undefined> {
  const [row] = await s.db
    .select()
    .from(documents)
    .where(and(inOrg(s), eq(documents.sha256, sha256)))
    .limit(1);
  return row;
}

export interface ListDocumentsQuery {
  loadId?: string | undefined;
  /** Only documents no load claims yet. Serves `documents_unattached_idx`. */
  unattached?: boolean | undefined;
  status?: DocumentStatus | undefined;
  kind?: string | undefined;
  limit?: number | undefined;
}

/**
 * Newest first, because the inbox is read from the top and the thing a
 * dispatcher wants is almost always what just arrived.
 */
export async function listDocuments(
  s: Scope,
  q: ListDocumentsQuery = {},
): Promise<Document[]> {
  const filters = [inOrg(s)];
  if (q.loadId) filters.push(eq(documents.loadId, q.loadId));
  if (q.unattached) filters.push(isNull(documents.loadId));
  if (q.status) filters.push(eq(documents.status, q.status));
  if (q.kind) filters.push(eq(documents.kind, q.kind));

  return s.db
    .select()
    .from(documents)
    .where(and(...filters))
    .orderBy(desc(documents.receivedAt))
    .limit(Math.min(Math.max(q.limit ?? 50, 1), 200));
}

/** Counts by status, for the inbox header. Missing statuses read as zero. */
export async function documentCounts(s: Scope): Promise<Record<string, number>> {
  const rows = await s.db
    .select({ status: documents.status, count: sql<number>`count(*)::int` })
    .from(documents)
    .where(inOrg(s))
    .groupBy(documents.status);

  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Fetch a document for writing, or say why not.
 *
 * `quarantined` is refused everywhere. A document that failed a content check
 * should not gain an extraction, a validation or a load — the whole point of
 * the state is that nothing further touches it until a human intervenes.
 */
async function forUpdate(s: Scope, id: string, action: string): Promise<Document> {
  const found = await getDocument(s, id);
  if (!found) {
    throw new DocumentError(
      'not_found',
      `no document ${id} in org ${s.ctx.orgId}`,
      'That document is not in this account.',
    );
  }
  if (found.status === 'quarantined') {
    throw new DocumentError(
      'quarantined',
      `refusing to ${action} quarantined document ${id}`,
      'That document was quarantined by a content check. Someone has to clear it first.',
    );
  }
  return found;
}

/** The load's `reference`, which is how a load is named in every sentence. */
async function loadReference(s: Scope, loadId: string): Promise<number> {
  const [row] = await s.db
    .select({ reference: loads.reference })
    .from(loads)
    .where(and(eq(loads.orgId, s.ctx.orgId), eq(loads.id, loadId)))
    .limit(1);

  if (!row) {
    throw new DocumentError(
      'load_not_found',
      `no load ${loadId} in org ${s.ctx.orgId}`,
      'That load is not in this account.',
    );
  }
  return row.reference;
}

/**
 * Hang a document on a load.
 *
 * Re-attaching to a different load is allowed and recorded. A rate confirmation
 * matched to the wrong load is a correction, not an error, and refusing it would
 * leave the only fix as a manual database edit.
 */
export async function attachToLoad(
  s: Scope,
  documentId: string,
  loadId: string,
): Promise<Document> {
  return withTransaction(s, async (tx) => {
    const existing = await forUpdate(tx, documentId, 'attach');
    const reference = await loadReference(tx, loadId);

    if (existing.loadId === loadId) return existing;

    const [row] = await tx.db
      .update(documents)
      .set({ loadId })
      .where(and(eq(documents.orgId, tx.ctx.orgId), eq(documents.id, documentId)))
      .returning();
    if (!row) throw new Error('document attach returned nothing');

    await recordEvent(tx, 'document.attached', {
      subjectId: row.id,
      payload: { kind: row.kind, loadReference: reference },
    });

    return row;
  });
}

/**
 * Record what a classifier decided, without claiming the document was read.
 *
 * Used for the case the threshold exists for: the rules found something, but not
 * confidently enough to route on. The kind and the confidence are written so a
 * person opening the inbox sees HaulQ's best guess and how much it trusts it,
 * and the status stays `received` so the document remains work to be done.
 *
 * No event. Nothing happened that a carrier needs told — the document arrived,
 * which was already recorded, and HaulQ having an opinion about it is not a
 * business fact. When a model makes the call instead, that is a model write and
 * `recordExtraction` records it as one.
 */
export async function recordClassification(
  s: Scope,
  documentId: string,
  input: { kind: DocumentKind; kindConfidence: number },
): Promise<Document> {
  await forUpdate(s, documentId, 'classify');

  const [row] = await s.db
    .update(documents)
    .set({ kind: input.kind, kindConfidence: input.kindConfidence })
    .where(and(eq(documents.orgId, s.ctx.orgId), eq(documents.id, documentId)))
    .returning();
  if (!row) throw new Error('document classification returned nothing');
  return row;
}

export interface RecordExtractionInput {
  /** Whatever the model read. Shape is per document kind, deliberately open. */
  extracted: Record<string, unknown>;
  /** Model and prompt version, e.g. `azure-di-2024-11-30/rateconf-v3`. */
  extractorVersion: string;
  /** Classification, when this pass also decided the kind. */
  kind?: DocumentKind | undefined;
  kindConfidence?: number | undefined;
  pageCount?: number | undefined;
  extractedAt?: Date | undefined;
}

/**
 * Record what a model read off the page.
 *
 * Deliberately does not decide anything. Extraction moves the document to
 * `extracted` and stops; it is `recordValidation` that compares the reading to
 * the load and reaches a verdict. Re-running an extractor over the same document
 * is expected — that is what `extractorVersion` is for — so this overwrites.
 */
export async function recordExtraction(
  s: Scope,
  documentId: string,
  input: RecordExtractionInput,
): Promise<Document> {
  return withTransaction(s, async (tx) => {
    await forUpdate(tx, documentId, 'extract');

    const [row] = await tx.db
      .update(documents)
      .set({
        extracted: input.extracted,
        extractedAt: input.extractedAt ?? new Date(),
        extractorVersion: input.extractorVersion,
        status: 'extracted',
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.kindConfidence !== undefined
          ? { kindConfidence: input.kindConfidence }
          : {}),
        ...(input.pageCount !== undefined ? { pageCount: input.pageCount } : {}),
      })
      .where(and(eq(documents.orgId, tx.ctx.orgId), eq(documents.id, documentId)))
      .returning();
    if (!row) throw new Error('document extraction returned nothing');

    await recordEvent(tx, 'document.extracted', {
      subjectId: row.id,
      payload: {
        kind: row.kind,
        fieldCount: Object.keys(input.extracted).length,
        extractorVersion: input.extractorVersion,
      },
    });

    return row;
  });
}

export interface RecordValidationResult {
  document: Document;
  verdict: ValidationVerdict;
}

/**
 * Compare a reading against the load and record the verdict.
 *
 * The findings are computed by the caller — this function does not know how to
 * compare a rate to a rate. What it owns is that the verdict, the status, the
 * timestamp and the event all agree, and that a rejection carries the sentence
 * `documents_rejected_has_reason` requires.
 *
 * Validating an unattached document is refused rather than skipped. "Does this
 * agree with the load" has no answer when there is no load, and quietly writing
 * `validated` for a document nobody matched would be the most expensive kind of
 * wrong: a green tick over an unchecked packet.
 */
export async function recordValidation(
  s: Scope,
  documentId: string,
  findings: readonly ValidationFinding[],
): Promise<RecordValidationResult> {
  return withTransaction(s, async (tx) => {
    const existing = await forUpdate(tx, documentId, 'validate');

    if (!existing.loadId) {
      throw new DocumentError(
        'not_attached',
        `document ${documentId} has no load to validate against`,
        'Attach this document to a load before checking it against one.',
      );
    }

    const reference = await loadReference(tx, existing.loadId);
    const verdict = summarizeValidation(findings);

    const [row] = await tx.db
      .update(documents)
      .set({
        validation: findings as ValidationFinding[],
        validatedAt: new Date(),
        status: verdict.outcome,
        // Cleared on a pass, so a document that was rejected and then corrected
        // does not keep explaining a problem it no longer has.
        rejectionReason: verdict.reason,
      })
      .where(and(eq(documents.orgId, tx.ctx.orgId), eq(documents.id, documentId)))
      .returning();
    if (!row) throw new Error('document validation returned nothing');

    if (verdict.outcome === 'validated') {
      await recordEvent(tx, 'document.validated', {
        subjectId: row.id,
        payload: { kind: row.kind, loadReference: reference },
      });
    } else {
      await recordEvent(tx, 'document.rejected', {
        subjectId: row.id,
        payload: {
          kind: row.kind,
          loadReference: reference,
          reason: verdict.reason ?? 'The document does not match the load.',
        },
      });
    }

    return { document: row, verdict };
  });
}

/**
 * Take a document out of circulation after a content check failed.
 *
 * Terminal by design — `forUpdate` refuses everything else afterwards. There is
 * no event verb for it because nothing downstream should react; the row's status
 * is the record, and a human clearing it is a database action, not a product
 * feature yet.
 */
export async function quarantineDocument(
  s: Scope,
  documentId: string,
  reason: string,
): Promise<Document> {
  const [row] = await s.db
    .update(documents)
    .set({ status: 'quarantined', rejectionReason: reason })
    .where(and(eq(documents.orgId, s.ctx.orgId), eq(documents.id, documentId)))
    .returning();

  if (!row) {
    throw new DocumentError(
      'not_found',
      `no document ${documentId} in org ${s.ctx.orgId}`,
      'That document is not in this account.',
    );
  }
  return row;
}
