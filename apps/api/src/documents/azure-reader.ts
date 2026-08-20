/**
 * Azure AI Document Intelligence, as a `DocumentReader`.
 *
 * Only reached for documents the free path declined — a photograph of a signed
 * BOL, a faxed scale ticket, a scanned PDF with no text layer. See
 * `ChainedDocumentReader` below for how that is enforced rather than hoped for.
 *
 * ---------------------------------------------------------------------------
 * `prebuilt-read`, not `prebuilt-layout`
 * ---------------------------------------------------------------------------
 *
 * Read is the cheapest model Azure offers and it returns exactly what is needed
 * here: the words on the page. Layout adds tables, selection marks and bounding
 * structure at a large multiple of the price, and none of it would be used —
 * `classifyDeterministically` and `extractDeterministically` work on plain text,
 * are already tested, and do not care whether the words arrived from a zlib
 * inflate or from OCR. Anything that changes that calculus should change this
 * constant deliberately, not by accident.
 *
 * ---------------------------------------------------------------------------
 * Two kinds of failure, which must not be confused
 * ---------------------------------------------------------------------------
 *
 *   **Transport failure** — a 5xx, a timeout, a throttle, a dead socket.
 *     Throws. The outbox retries with backoff, which is the right answer to
 *     "Azure was busy".
 *
 *   **Unreadable document** — Azure ran and reported it could not read the
 *     file. Returns `text: null`, the same answer the local reader gives for a
 *     scan. Retrying cannot make a blank page legible; it just spends eight
 *     more pages of quota arriving at the same conclusion.
 *
 * Confusing the two is expensive in one direction and silent in the other,
 * which is why most of the test suite is about this distinction.
 */

import type { DocumentReader, ReadResult } from './reader.ts';

const DEFAULT_API_VERSION = '2024-11-30';
const DEFAULT_MODEL = 'prebuilt-read';

/**
 * Longest this reader will wait on one document before giving up.
 *
 * Exported because it is the worst case per message, and the outbox's slow
 * group sizes its batch and its lease against it — see `buildOutboxGroups`.
 * Raising this without raising the lease there lets a batch outlive its own
 * claim, so the two are checked against each other in a test.
 */
export const AZURE_DEFAULT_TIMEOUT_MS = 120_000;

export interface AzureReaderOptions {
  /** e.g. `https://haulq-docs.cognitiveservices.azure.com` */
  endpoint: string;
  key: string;
  model?: string;
  apiVersion?: string;
  /** Gap between polls. Azure usually settles in seconds. */
  pollIntervalMs?: number;
  /**
   * Give up after this long.
   *
   * Not optional in spirit. Without a deadline a stuck operation holds an
   * outbox lease open until it expires, the message is redelivered to another
   * consumer, and a second analysis of the same page begins — paying twice to
   * wait twice. A bounded wait that throws is strictly cheaper.
   */
  timeoutMs?: number;
  /** Injected by the tests, which run a stub Azure on localhost. */
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Thrown for anything worth retrying, so the handler can tell the difference. */
export class AzureReaderError extends Error {
  readonly retryable = true;
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'AzureReaderError';
    this.status = status;
  }
}

interface AnalyzeOperation {
  status?: string;
  error?: { code?: string; message?: string };
  analyzeResult?: {
    content?: string;
    pages?: unknown[];
  };
}

/**
 * Terminal failure states, and states that mean "still going".
 *
 * Microsoft's reference documents `succeeded` and describes the operation as
 * asynchronous, but does not enumerate every status value. So anything
 * unrecognised is treated as still running until the deadline rather than as a
 * failure: an unknown status that really meant "done" costs one wasted poll,
 * whereas an unknown status treated as failure would silently drop a document
 * that was read perfectly well.
 */
const FAILED = new Set(['failed', 'canceled', 'cancelled']);
const RUNNING = new Set(['notstarted', 'running']);

export class AzureDocumentReader implements DocumentReader {
  readonly name: string;

  readonly #endpoint: string;
  readonly #key: string;
  readonly #model: string;
  readonly #apiVersion: string;
  readonly #pollIntervalMs: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: AzureReaderOptions) {
    // Trailing slash stripped once, here, rather than at both call sites. A
    // double slash in the path is a 404 whose message explains nothing.
    this.#endpoint = options.endpoint.replace(/\/+$/, '');
    this.#key = options.key;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.#timeoutMs = options.timeoutMs ?? AZURE_DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

    // Stored on every document this reads. `processDocument` compares it to
    // decide whether a redelivered message needs re-reading, so it has to name
    // the model and the API version — changing either changes the output.
    this.name = `azure-di/${this.#model}/${this.#apiVersion}`;
  }

  /**
   * `contentType` is accepted and ignored: Azure identifies the format from the
   * bytes, and the declared type is a browser's guess anyway — `sniff.ts` exists
   * because that guess is routinely wrong. The parameter stays so every reader
   * is called the same way.
   */
  async read(bytes: Buffer, _contentType?: string): Promise<ReadResult> {
    const operationUrl = await this.#startAnalysis(bytes);
    const operation = await this.#poll(operationUrl);

    if (!operation) return { text: null, pageCount: null, version: this.name };

    const content = operation.analyzeResult?.content ?? '';
    const pageCount = operation.analyzeResult?.pages?.length ?? null;

    // Same floor the local reader applies. A near-empty result is a blank scan
    // or a page of vector art, and letting three stray characters through gives
    // phrase matching something to score — and it will score it wrongly.
    if (content.trim().length < 20) {
      return { text: null, pageCount, version: this.name };
    }

    return { text: content, pageCount, version: this.name };
  }

  /** POST the bytes; return the URL to poll. */
  async #startAnalysis(bytes: Buffer): Promise<string> {
    const url =
      `${this.#endpoint}/documentintelligence/documentModels/${this.#model}:analyze` +
      `?_overload=analyzeDocument&api-version=${this.#apiVersion}`;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.#key,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ base64Source: bytes.toString('base64') }),
      });
    } catch (cause) {
      throw new AzureReaderError(
        `could not reach Document Intelligence: ${String(cause)}`,
      );
    }

    if (response.status !== 202) {
      throw new AzureReaderError(
        `analyze returned ${response.status}: ${await describe(response)}`,
        response.status,
      );
    }

    const location = response.headers.get('operation-location');
    if (!location) {
      throw new AzureReaderError(
        'analyze accepted the document but returned no Operation-Location',
      );
    }
    return location;
  }

  /**
   * Poll until the operation settles.
   *
   * Returns the completed operation, or null when Azure ran and reported it
   * could not read the document — which is an answer, not an error.
   */
  async #poll(operationUrl: string): Promise<AnalyzeOperation | null> {
    const deadline = Date.now() + this.#timeoutMs;

    for (;;) {
      if (Date.now() > deadline) {
        throw new AzureReaderError(
          `Document Intelligence did not finish within ${this.#timeoutMs}ms`,
        );
      }

      let response: Response;
      try {
        response = await this.#fetch(operationUrl, {
          headers: { 'Ocp-Apim-Subscription-Key': this.#key },
        });
      } catch (cause) {
        throw new AzureReaderError(`polling failed: ${String(cause)}`);
      }

      if (response.status === 202) {
        await this.#sleep(this.#pollIntervalMs);
        continue;
      }

      if (!response.ok) {
        throw new AzureReaderError(
          `polling returned ${response.status}: ${await describe(response)}`,
          response.status,
        );
      }

      const operation = (await response.json()) as AnalyzeOperation;
      const status = (operation.status ?? '').toLowerCase();

      if (status === 'succeeded') return operation;

      // Azure looked at it and could not read it. Not retryable: the same bytes
      // fail the same way, eight more times, at a page of quota each.
      if (FAILED.has(status)) return null;

      // Anything else — including a status this client has never heard of — is
      // treated as still running. `RUNNING` is referenced so the intent is in
      // the code rather than only in the comment above it.
      void RUNNING;
      await this.#sleep(this.#pollIntervalMs);
    }
  }
}

/** The most useful sentence available from a failed response. */
async function describe(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    const error = body.error;
    if (error?.message) return `${error.code ?? 'error'} — ${error.message}`;
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return response.statusText || 'no body';
  }
}

/**
 * Try readers in order; stop at the first that produces text.
 *
 * This is where the cost control is *enforced* rather than assumed. The pipeline
 * calls one reader; that reader is this one; and the free text-layer pass always
 * runs first. A digital rate confirmation therefore never reaches Azure, and the
 * only way to change that is to reorder the list — which is a thing somebody has
 * to do on purpose.
 *
 * The version returned is the version of whichever reader actually produced the
 * text, not this wrapper's. `processDocument` compares that string to decide
 * whether a document needs re-reading, so it has to identify the thing that did
 * the reading.
 */
export class ChainedDocumentReader implements DocumentReader {
  readonly name: string;
  readonly #readers: DocumentReader[];

  constructor(readers: DocumentReader[]) {
    if (readers.length === 0) {
      throw new Error('a chained reader needs at least one reader');
    }
    this.#readers = readers;
    this.name = readers.map((r) => r.name).join('+');
  }

  async read(bytes: Buffer, contentType: string): Promise<ReadResult> {
    let last: ReadResult = { text: null, pageCount: null, version: this.name };

    for (const reader of this.#readers) {
      const result = await reader.read(bytes, contentType);
      if (result.text) return result;
      // Keep a page count even from a reader that found no text — a scanned PDF
      // still has pages, and that is worth recording on the document.
      last = { ...result, pageCount: result.pageCount ?? last.pageCount };
    }

    return last;
  }
}
