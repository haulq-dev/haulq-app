/**
 * What happens to a document after it arrives.
 *
 * Read it, decide what it is, pull the fields off it. Three steps, in that
 * order, each of which can decline — and declining is a designed outcome rather
 * than a failure, because every step that declines is the one that would have
 * cost money.
 *
 * ---------------------------------------------------------------------------
 * The order is the cost control
 * ---------------------------------------------------------------------------
 *
 * Build plan section 7 prices classification at roughly $3 per thousand pages
 * and extraction at roughly $4. Neither is much until a carrier forwards ninety
 * days of paperwork. So:
 *
 *   1. The text layer is tried first. A broker's TMS already put the words in
 *      the PDF; getting them out costs an inflate.
 *   2. Phrase rules run on that text. A document that says RATE CONFIRMATION
 *      across the top has told us what it is, and no model is consulted.
 *   3. Labelled values are read the same way. A rate confirmation whose rate
 *      sits after the word RATE needs nothing further.
 *
 * A model is only worth paying for where all three decline: a photograph, a fax,
 * a template nobody has seen. That path is not built yet, and this returns
 * `needs: 'ocr'` or `needs: 'model'` so the handler can say so plainly instead
 * of writing a guess.
 *
 * ---------------------------------------------------------------------------
 * Nothing here decides a document is fine
 * ---------------------------------------------------------------------------
 *
 * Extraction says what the page says. Whether that matches the load is
 * `recordValidation`'s question, and it is deliberately not asked here.
 */

import {
  classifyDeterministically,
  extractDeterministically,
  isConfident,
  worthExtracting,
  type Classification,
} from '@haulq/contracts';
import {
  getDocument,
  recordClassification,
  recordExtraction,
  type Document,
  type ObjectStore,
  type Scope,
} from '@haulq/db';
import type { DocumentReader } from './reader.ts';
import { validateDocument, type ValidationAttempt } from './validate.ts';

export interface PipelineDeps {
  reader: DocumentReader;
  storage: ObjectStore;
}

export type PipelineOutcome =
  /** The document is gone. Nothing to do, and not an error. */
  | { status: 'skipped'; why: 'not_found' | 'quarantined' | 'already_read' }
  /** No text could be got off it. An OCR pass is the next thing to try. */
  | { status: 'needs'; needs: 'ocr'; document: Document }
  /** Text, but the rules could not say what it is confidently enough to route on. */
  | { status: 'needs'; needs: 'model'; document: Document; guess: Classification | null }
  /** Read and understood, at no cost beyond an inflate. */
  | {
      status: 'read';
      document: Document;
      classification: Classification;
      fieldCount: number;
      /** Expected fields the rules could not find. A model could fill these. */
      missing: string[];
      /** False for kinds with nothing on them worth checking against a load. */
      extractable: boolean;
      /**
       * What happened when the reading was compared to the load.
       *
       * Attempted immediately rather than queued: the comparison is two row
       * reads and no model call, and a document that sits `extracted` without a
       * verdict is one a carrier sees as neither checked nor broken. Skipped
       * with `not_attached` for the common case of a rate confirmation that
       * arrived before its load existed — the attach route runs it then.
       */
      validation: ValidationAttempt;
    };

/**
 * Run one document through.
 *
 * Safe to run twice. The outbox is at-least-once, so a redelivered message must
 * not re-read a document and re-record the event — `already_read` compares the
 * stored `extractorVersion` against what this pass would produce.
 */
export async function processDocument(
  s: Scope,
  documentId: string,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  const document = await getDocument(s, documentId);
  if (!document) return { status: 'skipped', why: 'not_found' };
  if (document.status === 'quarantined') {
    return { status: 'skipped', why: 'quarantined' };
  }

  const bytes = await deps.storage.get(document.storageKey);
  const read = await deps.reader.read(bytes, document.contentType ?? 'application/octet-stream');

  if (!read.text) {
    return { status: 'needs', needs: 'ocr', document };
  }

  const classification = classifyDeterministically({
    text: read.text,
    ...(document.filename ? { filename: document.filename } : {}),
  });

  if (!classification || !isConfident(classification)) {
    // Best guess recorded anyway. A dispatcher opening the inbox should see
    // "probably a rate confirmation, not sure" rather than a blank, and the
    // model pass gets a starting point instead of an empty prompt.
    if (classification) {
      await recordClassification(s, documentId, {
        kind: classification.kind,
        kindConfidence: classification.confidence,
      });
    }
    return { status: 'needs', needs: 'model', document, guess: classification };
  }

  const extracted = extractDeterministically({
    text: read.text,
    kind: classification.kind,
  });

  // Version identifies both halves. Re-running one of them later has to be
  // distinguishable from re-running the other, and a single opaque string is
  // what `documents.extractor_version` gets compared against.
  const version = `${read.version}/${extracted.version}`;

  if (document.extractorVersion === version && document.extractedAt) {
    return { status: 'skipped', why: 'already_read' };
  }

  const updated = await recordExtraction(s, documentId, {
    extracted: extracted.fields,
    extractorVersion: version,
    kind: classification.kind,
    kindConfidence: classification.confidence,
    ...(read.pageCount !== null ? { pageCount: read.pageCount } : {}),
  });

  const validation = await validateDocument(s, documentId);

  return {
    status: 'read',
    // Re-read rather than reusing `updated`: validation writes the status and
    // the findings, so `updated` is one revision stale the moment it returns.
    document: (await getDocument(s, documentId)) ?? updated,
    classification,
    fieldCount: Object.keys(extracted.fields).length,
    missing: extracted.missing,
    extractable: worthExtracting(classification.kind),
    validation,
  };
}
