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
 *   4. Only now, and only for what is left over, `deps.modelReader` — see
 *      `model-reader.ts`. Unset in every environment with no key configured,
 *      in which case this behaves exactly as it did before the model pass
 *      existed: `needs: 'model'`, or a `missing` list, for a person to look at.
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
  type DocumentKind,
  type ExtractedField,
} from '@haulq/contracts';
import {
  getDocument,
  recordClassification,
  recordExtraction,
  scope,
  type Document,
  type ObjectStore,
  type Scope,
} from '@haulq/db';
import type { ModelDocumentReader } from './model-reader.ts';
import type { DocumentReader } from './reader.ts';
import { validateDocument, type ValidationAttempt } from './validate.ts';

export interface PipelineDeps {
  reader: DocumentReader;
  storage: ObjectStore;
  /** Unset means the model pass does not exist yet in this environment — see the module note. */
  modelReader?: ModelDocumentReader | undefined;
}

export type PipelineOutcome =
  /** The document is gone. Nothing to do, and not an error. */
  | { status: 'skipped'; why: 'not_found' | 'quarantined' | 'already_read' | 'manually_read' }
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
  // A person's correction outranks a re-run of the automated pipeline. The
  // outbox redelivers `document.received` at least once by design (see the
  // module note on `already_read`), and without this check a redelivery
  // after a manual save would call `recordExtraction`, which overwrites
  // `extracted` wholesale — silently discarding what the person typed.
  if (document.extractorVersion === 'manual-entry') {
    return { status: 'skipped', why: 'manually_read' };
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

    if (deps.modelReader) {
      const reading = await deps.modelReader.read(read.text, classification);
      if (reading) {
        // The model's own kind may disagree with — or simply exceed — the
        // pattern guess. Re-running the deterministic rules against it costs
        // nothing further and means `missing` stays an honest answer rather
        // than an empty list nobody computed.
        const patterns = extractDeterministically({ text: read.text, kind: reading.kind });
        return finishExtraction(s, documentId, document, read, {
          kind: reading.kind,
          confidence: reading.confidence,
          reason: `read by ${deps.modelReader.name}`,
          fields: mergeFields(patterns.fields, reading.fields),
          missing: patterns.missing.filter((f) => !(f in reading.fields)),
          versionSuffix: deps.modelReader.name,
          modelName: deps.modelReader.name,
        });
      }
    }

    return { status: 'needs', needs: 'model', document, guess: classification };
  }

  const extracted = extractDeterministically({
    text: read.text,
    kind: classification.kind,
  });

  if (extracted.missing.length > 0 && deps.modelReader) {
    const reading = await deps.modelReader.read(read.text, classification);
    // Only trust the fill-in when the model agrees on what kind of document
    // this is. If it does not, its fields are answers to a different
    // question and merging them would silently mix two readings.
    if (reading && reading.kind === classification.kind) {
      const filled = mergeFields(extracted.fields, reading.fields);
      const stillMissing = extracted.missing.filter((f) => !(f in filled));
      if (stillMissing.length < extracted.missing.length) {
        return finishExtraction(s, documentId, document, read, {
          kind: classification.kind,
          confidence: classification.confidence,
          reason: `${classification.reason}; gaps filled by ${deps.modelReader.name}`,
          fields: filled,
          missing: stillMissing,
          versionSuffix: `${extracted.version}+${deps.modelReader.name}`,
          modelName: deps.modelReader.name,
        });
      }
    }
  }

  return finishExtraction(s, documentId, document, read, {
    kind: classification.kind,
    confidence: classification.confidence,
    reason: classification.reason,
    fields: extracted.fields,
    missing: extracted.missing,
    versionSuffix: extracted.version,
  });
}

/** A rule-found value always wins over a model-found one for the same field — the rule is reading a label, not estimating. */
function mergeFields(
  ruleFields: Record<string, ExtractedField>,
  modelFields: Record<string, ExtractedField>,
): Record<string, ExtractedField> {
  return { ...modelFields, ...ruleFields };
}

/**
 * Write an extraction and its validation, and build the outcome.
 *
 * The one place both the deterministic path and the model path end up,
 * because a caller of `processDocument` should not be able to tell which one
 * produced a given `'read'` outcome — the shape is identical either way, and
 * `extractorVersion` on the document is where that provenance actually lives.
 */
async function finishExtraction(
  s: Scope,
  documentId: string,
  document: Document,
  read: { version: string; pageCount: number | null },
  args: {
    kind: DocumentKind;
    confidence: number;
    reason: string;
    fields: Record<string, ExtractedField>;
    missing: string[];
    /** Appended to `read.version` to form `extractor_version`. */
    versionSuffix: string;
    /** Set only when a model actually produced part of this reading — see the module note on attribution. */
    modelName?: string;
  },
): Promise<PipelineOutcome> {
  const version = `${read.version}/${args.versionSuffix}`;

  if (document.extractorVersion === version && document.extractedAt) {
    return { status: 'skipped', why: 'already_read' };
  }

  // Guardrail 5: a reading a model touched is attributed to that model, not
  // to whichever process happened to be draining the outbox. Built fresh
  // rather than mutating `s`, so nothing outside this one write is affected.
  const writeScope: Scope = args.modelName
    ? scope(s.db, { ...s.ctx, actor: { type: 'agent', model: args.modelName } })
    : s;

  const updated = await recordExtraction(writeScope, documentId, {
    extracted: args.fields,
    extractorVersion: version,
    kind: args.kind,
    kindConfidence: args.confidence,
    ...(read.pageCount !== null ? { pageCount: read.pageCount } : {}),
  });

  const validation = await validateDocument(writeScope, documentId);

  return {
    status: 'read',
    // Re-read rather than reusing `updated`: validation writes the status and
    // the findings, so `updated` is one revision stale the moment it returns.
    document: (await getDocument(writeScope, documentId)) ?? updated,
    classification: { kind: args.kind, confidence: args.confidence, reason: args.reason },
    fieldCount: Object.keys(args.fields).length,
    missing: args.missing,
    extractable: worthExtracting(args.kind),
    validation,
  };
}
