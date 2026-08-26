/**
 * A model pass, for what the deterministic rules decline.
 *
 * `classify.ts` and `extract.ts` are correct about the common case: freight
 * paperwork is templated, and a phrase match or a labelled value is reading,
 * not inference. This file exists for what is left over — a photograph of a
 * handwritten BOL, a template nobody has seen, a packet where several kinds
 * matched and nothing should be guessed at. `processDocument` only ever
 * reaches this after the free passes have already declined, which is the
 * whole cost model: the rate is priced per call, not per document.
 *
 * ---------------------------------------------------------------------------
 * The model never gets to invent a number
 * ---------------------------------------------------------------------------
 *
 * It is asked for one thing per field: the exact text it read, verbatim, and
 * nothing else. `parseModelResponse` below then verifies that string is a
 * literal substring of the page it was shown — not similar, not paraphrased,
 * present — before touching it, and only then runs it through the *same*
 * `parseMoney`/`parseCount` the deterministic rules use. A model that
 * reports a rate correctly in its own words but cannot point at where it
 * read it produces nothing. This is the same discipline `extract.ts`
 * documents for itself: absence is honest, invention is not, and an invented
 * number is worse than a missing one because validation trusts it.
 *
 * A field the model cannot find is simply left out, the same as a
 * deterministic rule finding nothing.
 */

import {
  DOCUMENT_KINDS,
  FIELD_NAMES_BY_KIND,
  parseCount,
  parseMoney,
  type Classification,
  type DocumentKind,
  type ExtractedField,
} from '@haulq/contracts';

export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MODEL_PROMPT_VERSION = 'model-extract-v1';

/** Longest source text sent in one call. Freight paperwork is rarely this long. */
const MAX_TEXT_CHARS = 8000;

export interface ModelReading {
  kind: DocumentKind;
  /** 0–1, the model's own estimate. Not compared against `CLASSIFY_THRESHOLD` here — the caller decides what to do with it. */
  confidence: number;
  fields: Record<string, ExtractedField>;
}

export interface ModelDocumentReader {
  readonly name: string;
  /**
   * `guess` is the deterministic classifier's best attempt, if it produced
   * one — passed along as a hint, never as an answer the model is asked to
   * confirm. Returns null when the model could not produce a usable reading:
   * a genuinely unreadable page, or a response that failed verification.
   * That is a normal outcome, not a bug — see the module note on invention
   * versus absence.
   */
  read(text: string, guess: Classification | null): Promise<ModelReading | null>;
}

/** Thrown for anything worth retrying — a timeout, a 5xx, a rate limit. */
export class ModelReaderError extends Error {
  readonly retryable = true;
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ModelReaderError';
    this.status = status;
  }
}

/** Field name → how its captured text becomes a value. Same parsers `extract.ts` uses, so a model-read rate and a rule-read rate mean the same thing downstream. */
const FIELD_PARSERS: Record<string, (raw: string) => string | number | null> = {
  rateAmount: parseMoney,
  linehaulAmount: parseMoney,
  invoiceAmount: parseMoney,
  lumperAmount: parseMoney,
  weightLbs: parseCount,
  pieceCount: parseCount,
};

/** Every field name any kind's rules can produce, so the prompt and `extract.ts` never drift apart. */
const KNOWN_FIELDS = [...new Set(Object.values(FIELD_NAMES_BY_KIND).flat())];

const SYSTEM_PROMPT = `You read freight paperwork for a trucking company. You will be shown the text of one document.

Reply with ONLY a JSON object, no prose, no markdown fences:
{"kind": "<one of: ${DOCUMENT_KINDS.join(', ')}>", "confidence": <0 to 1>, "fields": [{"field": "<name>", "raw": "<exact text>"}]}

Rules:
- "kind" must be exactly one of the listed values.
- "confidence" is your own honest estimate. If several kinds could fit, say so with a low number rather than guessing high.
- Only include a field in "fields" if you can point at where it appears. "raw" must be copied EXACTLY as printed on the page — same digits, same punctuation, same spacing. Do not compute, reformat, round, or paraphrase it.
- Recognised field names: ${KNOWN_FIELDS.join(', ')}. Use these names when the field applies; omit anything you cannot find.
- If nothing on the page is legible or freight-related, set confidence to 0 and return an empty fields array.`;

function buildPrompt(text: string, guess: Classification | null): string {
  const truncated = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  const hint = guess
    ? `\n\nA pattern-based classifier's best guess, for reference only — trust the text over this if they disagree: ${guess.kind} (confidence ${guess.confidence.toFixed(2)}, matched "${guess.reason}").`
    : '';
  return `Document text:\n\n${truncated}${hint}`;
}

/** Strip a markdown fence a model added despite being asked not to. */
function stripFences(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return (fenced ? fenced[1] : raw)!.trim();
}

const DOCUMENT_KIND_SET = new Set<string>(DOCUMENT_KINDS);

/**
 * Turn a model's raw text response into a `ModelReading`, or null.
 *
 * Pure and network-free on purpose — the anti-hallucination check is the
 * part worth testing exhaustively, and it should not need a server to do
 * that.
 */
export function parseModelResponse(raw: string, sourceText: string): ModelReading | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (typeof obj['kind'] !== 'string' || !DOCUMENT_KIND_SET.has(obj['kind'])) return null;
  const kind = obj['kind'] as DocumentKind;

  const confidenceRaw = obj['confidence'];
  if (typeof confidenceRaw !== 'number' || !Number.isFinite(confidenceRaw)) return null;
  const confidence = Math.max(0, Math.min(1, confidenceRaw));

  const rawFields = Array.isArray(obj['fields']) ? obj['fields'] : [];
  const fields: Record<string, ExtractedField> = {};

  for (const item of rawFields) {
    if (typeof item !== 'object' || item === null) continue;
    const f = item as Record<string, unknown>;
    if (typeof f['field'] !== 'string' || typeof f['raw'] !== 'string') continue;
    const field = f['field'];
    const rawValue = f['raw'];

    // The whole guard: the model must point at text that is actually on the
    // page. Anything it cannot point at is discarded, not trusted.
    if (!rawValue || !sourceText.includes(rawValue)) continue;

    const parse = FIELD_PARSERS[field];
    const value = parse ? parse(rawValue) : rawValue.trim();
    if (value === null || value === '') continue;

    fields[field] = { value, raw: rawValue, label: 'model' };
  }

  return { kind, confidence, fields };
}

export interface AnthropicReaderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Injected by tests, which run a stub Anthropic on localhost. */
  fetch?: typeof globalThis.fetch;
}

/** How long this reader waits on one document before giving up. */
export const MODEL_DEFAULT_TIMEOUT_MS = 30_000;

export class AnthropicModelReader implements ModelDocumentReader {
  readonly name: string;

  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #maxTokens: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: AnthropicReaderOptions) {
    this.#apiKey = options.apiKey;
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.#maxTokens = options.maxTokens ?? 1024;
    this.#timeoutMs = options.timeoutMs ?? MODEL_DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;

    // Stored on every document this reads, same reason `AzureDocumentReader`
    // names itself after its model: changing the model or the prompt changes
    // the output, so both belong in the version a redelivery is compared
    // against.
    this.name = `anthropic/${this.#model}/${MODEL_PROMPT_VERSION}`;
  }

  async read(text: string, guess: Classification | null): Promise<ModelReading | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.#apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.#model,
          max_tokens: this.#maxTokens,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildPrompt(text, guess) }],
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new ModelReaderError(`could not reach Anthropic: ${String(cause)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // 5xx and 429 both belong here — transient, and the outbox already
      // knows how to back off and retry. A 4xx from a malformed request
      // would also land here, but that is a bug to see in the log, not a
      // reason to invent silent-decline behaviour for it.
      throw new ModelReaderError(
        `Anthropic returned ${response.status}: ${(await response.text().catch(() => '')).slice(0, 300)}`,
        response.status,
      );
    }

    const body = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const reply = (body.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');

    return parseModelResponse(reply, text);
  }
}
