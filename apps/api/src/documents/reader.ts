/**
 * Getting text off a document.
 *
 * The seam, in the same shape as `ObjectStore` and `Mailer`: an interface, a
 * cheap implementation that works everywhere, and a production one chosen by
 * whether its configuration is present — which **logs which one it picked**,
 * because "the extractor found nothing" and "the Azure key never reached this
 * deploy" are otherwise the same symptom.
 *
 * ---------------------------------------------------------------------------
 * Why the local reader is not a stub
 * ---------------------------------------------------------------------------
 *
 * Most rate confirmations are digital PDFs. A broker's TMS generated the file,
 * so the words are already in it as text, and pulling them out costs a zlib
 * inflate rather than a cent per page. OCR is for the other pile: photographs
 * of a signed BOL, faxed scale tickets, anything that reached the carrier
 * through a phone camera.
 *
 * So `LocalDocumentReader` is the fast path in production too, not a development
 * convenience. `read` returns null when it cannot get text, and null is the
 * signal to spend money — not an error.
 */

import { extractPdfText } from './pdf-text.ts';

export interface ReadResult {
  /** Page text, concatenated. Null when this reader could not get any. */
  text: string | null;
  /** Null when unknown. `documents.page_count` stays null rather than guessing. */
  pageCount: number | null;
  /** Recorded on the document, so a cohort can be re-run when this changes. */
  version: string;
}

export interface DocumentReader {
  readonly name: string;
  read(bytes: Buffer, contentType: string): Promise<ReadResult>;
}

/**
 * Text layer only. No OCR, no network, no cost.
 *
 * Handles the case that is both the most common and the cheapest, and declines
 * everything else by returning null text. An image never has a text layer, so it
 * is not even opened.
 */
export class LocalDocumentReader implements DocumentReader {
  readonly name = 'local-pdf-text';

  async read(bytes: Buffer, contentType: string): Promise<ReadResult> {
    if (contentType !== 'application/pdf') {
      return { text: null, pageCount: null, version: this.name };
    }

    const parsed = extractPdfText(bytes);
    return {
      text: parsed.text,
      pageCount: parsed.pageCount,
      version: this.name,
    };
  }
}

/**
 * A reader that returns whatever the test told it to.
 *
 * Used by the outbox suite so the pipeline can be exercised end to end without a
 * PDF, an OCR engine or a network. Keyed by digest rather than by call order:
 * the outbox drains in whatever order it claims rows, and a fake that depends on
 * sequence produces tests that pass for the wrong reason.
 */
export class FakeDocumentReader implements DocumentReader {
  readonly name = 'fake';
  readonly calls: string[] = [];
  #pages = new Map<string, ReadResult>();

  /** Register text for a specific document, by its sha256. */
  give(sha256: string, text: string, pageCount = 1): void {
    this.#pages.set(sha256, { text, pageCount, version: this.name });
  }

  /** Registered for anything not given explicitly. */
  fallback: ReadResult = { text: null, pageCount: null, version: 'fake' };

  async read(bytes: Buffer): Promise<ReadResult> {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(bytes).digest('hex');
    this.calls.push(digest);
    return this.#pages.get(digest) ?? this.fallback;
  }
}
