/**
 * Deciding what a document is, without asking a model.
 *
 * Build plan section 7 puts a hard cost line under this phase: classify with
 * Azure at roughly $3 per thousand pages, extract with a small model at roughly
 * $4. Both are cheap per page and neither is cheap at a carrier's volume, and
 * the cheapest call is the one that never happens. So every document meets these
 * rules first.
 *
 * The rules are not a heuristic stand-in for the model. Freight paperwork is
 * unusually well-behaved: a bill of lading says BILL OF LADING across the top
 * because a regulation and a century of habit say it must, and a broker's rate
 * confirmation says RATE CONFIRMATION because their TMS generated it from a
 * template. A phrase match on those headings is not a guess — it is reading the
 * title. What needs a model is the scanned, the photographed and the unlabelled.
 *
 * ---------------------------------------------------------------------------
 * Ambiguity is reported, never resolved
 * ---------------------------------------------------------------------------
 *
 * A carrier packet is one PDF containing a rate confirmation, a BOL and a
 * signed POD. Every rule below matches it. The wrong answer is to take the
 * highest score and route on it; the right one is to notice that several kinds
 * matched strongly and hand it on with low confidence, which is exactly what
 * `documents.kind_confidence` and the threshold on it exist for.
 */

import { type DocumentKind } from './documents.ts';

export interface Classification {
  kind: DocumentKind;
  /** 0–1. Below `CLASSIFY_THRESHOLD` nothing should route on this. */
  confidence: number;
  /** What matched, for the log and for a human deciding whether to trust it. */
  reason: string;
}

/**
 * Below this, a document is not routed on its kind.
 *
 * 0.7 rather than 0.5: the cost of a wrong confident answer is a rate
 * confirmation validated against the wrong fields, which is worse than the cost
 * of a model call.
 */
export const CLASSIFY_THRESHOLD = 0.7;

/**
 * Phrases that identify a kind, with how much a match is worth.
 *
 * Weights are deliberately coarse — three tiers, not a tuned curve:
 *
 *   0.95  the document's own title, as printed by the software that made it
 *   0.75  a phrase that only appears on this kind of document
 *   0.55  a phrase that is suggestive but appears elsewhere too
 *
 * Anything at 0.55 alone lands under the threshold on purpose. It is a hint for
 * the model, not an answer.
 */
const SIGNALS: Array<{ kind: DocumentKind; phrase: RegExp; weight: number }> = [
  // --- rate confirmation ---------------------------------------------------
  { kind: 'rate_confirmation', phrase: /\brate\s+(?:and\s+load\s+)?confirmation\b/i, weight: 0.95 },
  { kind: 'rate_confirmation', phrase: /\bload\s+confirmation\b/i, weight: 0.95 },
  { kind: 'rate_confirmation', phrase: /\bcarrier\s+confirmation\b/i, weight: 0.95 },
  { kind: 'rate_confirmation', phrase: /\brate\s*con(?:f)?\b/i, weight: 0.75 },
  { kind: 'rate_confirmation', phrase: /\bagreed\s+rate\b/i, weight: 0.55 },

  // --- bill of lading ------------------------------------------------------
  { kind: 'bol', phrase: /\b(?:straight\s+)?bill\s+of\s+lading\b/i, weight: 0.95 },
  { kind: 'bol', phrase: /\buniform\s+bill\s+of\s+lading\b/i, weight: 0.95 },
  { kind: 'bol', phrase: /\bshipper'?s?\s+bill\s+of\s+lading\b/i, weight: 0.95 },
  { kind: 'bol', phrase: /\bB\/L\s*(?:no|number|#)\b/i, weight: 0.75 },

  // --- proof of delivery ---------------------------------------------------
  { kind: 'pod', phrase: /\bproof\s+of\s+delivery\b/i, weight: 0.95 },
  { kind: 'pod', phrase: /\bdelivery\s+receipt\b/i, weight: 0.95 },
  { kind: 'pod', phrase: /\breceived\s+in\s+good\s+(?:order\s+and\s+)?condition\b/i, weight: 0.75 },
  { kind: 'pod', phrase: /\bconsignee\s+signature\b/i, weight: 0.55 },

  // --- invoice -------------------------------------------------------------
  { kind: 'invoice', phrase: /\bfreight\s+invoice\b/i, weight: 0.95 },
  { kind: 'invoice', phrase: /\bremit\s+(?:to|payment\s+to)\b/i, weight: 0.75 },
  { kind: 'invoice', phrase: /\bamount\s+due\b/i, weight: 0.75 },
  { kind: 'invoice', phrase: /\binvoice\s*(?:no|number|#)\b/i, weight: 0.75 },

  // --- the small stuff a carrier still has to keep --------------------------
  { kind: 'lumper_receipt', phrase: /\blumper\b/i, weight: 0.95 },
  { kind: 'scale_ticket', phrase: /\bscale\s+ticket\b/i, weight: 0.95 },
  { kind: 'weight_ticket', phrase: /\bweight\s+(?:ticket|certificate)\b/i, weight: 0.95 },
  { kind: 'weight_ticket', phrase: /\bcertified\s+weight\b/i, weight: 0.75 },

  // --- compliance paperwork -------------------------------------------------
  { kind: 'insurance_certificate', phrase: /\bcertificate\s+of\s+liability\s+insurance\b/i, weight: 0.95 },
  { kind: 'insurance_certificate', phrase: /\bACORD\s*2?5\b/i, weight: 0.95 },
  { kind: 'insurance_certificate', phrase: /\bcertificate\s+of\s+insurance\b/i, weight: 0.95 },
  { kind: 'w9', phrase: /\bform\s+w-?9\b/i, weight: 0.95 },
  { kind: 'w9', phrase: /\brequest\s+for\s+taxpayer\s+identification\b/i, weight: 0.95 },
  { kind: 'carrier_packet', phrase: /\bcarrier\s+(?:setup|packet|profile)\b/i, weight: 0.95 },
  { kind: 'detention_evidence', phrase: /\bdetention\b/i, weight: 0.75 },
];

/**
 * Filename signals, weaker than anything on the page.
 *
 * `ratecon_1042.pdf` is real evidence — a dispatcher named it that on purpose —
 * but a filename is renamed, forwarded and truncated by systems that do not care,
 * so it never reaches the threshold on its own. It breaks ties and it classifies
 * nothing.
 */
const FILENAME_SIGNALS: Array<{ kind: DocumentKind; phrase: RegExp }> = [
  { kind: 'rate_confirmation', phrase: /rate\s*-?_?con|ratecon|confirmation/i },
  { kind: 'bol', phrase: /\bbol\b|bill.?of.?lading/i },
  { kind: 'pod', phrase: /\bpod\b|proof.?of.?delivery|delivery.?receipt/i },
  { kind: 'invoice', phrase: /invoice|\binv\b/i },
  { kind: 'lumper_receipt', phrase: /lumper/i },
  { kind: 'scale_ticket', phrase: /scale/i },
  { kind: 'weight_ticket', phrase: /weight.?ticket/i },
  { kind: 'insurance_certificate', phrase: /insurance|\bcoi\b|acord/i },
  { kind: 'w9', phrase: /\bw-?9\b/i },
];

const FILENAME_WEIGHT = 0.35;

export interface ClassifyInput {
  /** Page text, if it could be read without OCR. */
  text?: string | undefined;
  filename?: string | undefined;
}

/**
 * Classify from what is free.
 *
 * Returns null when nothing matched at all — which is the signal to spend a
 * model call, not a reason to store `other` and move on.
 */
export function classifyDeterministically(input: ClassifyInput): Classification | null {
  const scores = new Map<DocumentKind, { score: number; matched: string[] }>();

  const add = (kind: DocumentKind, weight: number, label: string) => {
    const entry = scores.get(kind) ?? { score: 0, matched: [] };
    // Best single signal wins rather than accumulating. Three phrases from the
    // same template are one piece of evidence repeated, not three.
    entry.score = Math.max(entry.score, weight);
    entry.matched.push(label);
    scores.set(kind, entry);
  };

  if (input.text) {
    for (const signal of SIGNALS) {
      const found = input.text.match(signal.phrase);
      if (found) add(signal.kind, signal.weight, `"${found[0].trim()}" on the page`);
    }
  }

  if (input.filename) {
    for (const signal of FILENAME_SIGNALS) {
      if (signal.phrase.test(input.filename)) {
        add(signal.kind, FILENAME_WEIGHT, `the filename`);
      }
    }
  }

  if (scores.size === 0) return null;

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const [kind, best] = ranked[0]!;
  const runnerUp = ranked[1]?.[1].score ?? 0;

  /**
   * Two strong matches means a packet, not a decision.
   *
   * Halved rather than zeroed: the leader is still the best guess available and
   * a model should be told what it is, but halving a 0.95 lands at 0.475, under
   * the threshold, so nothing routes on it.
   */
  const ambiguous = runnerUp >= 0.75;
  const confidence = ambiguous ? best.score / 2 : best.score;

  const reason = ambiguous
    ? `${best.matched[0]}, but ${ranked[1]![0].replace(/_/g, ' ')} also matched — this looks like a packet`
    : best.matched[0]!;

  return { kind, confidence: Number(confidence.toFixed(2)), reason };
}

/**
 * True when a classification is good enough to route on.
 *
 * Deliberately a plain boolean rather than a type guard. Writing it as
 * `c is Classification` reads well until a caller takes the false branch, where
 * TypeScript then narrows to `null` — because a low-confidence result is still a
 * perfectly good `Classification` object, just not one to act on. Confidence is
 * a property of the value, not of its type, and pretending otherwise makes the
 * "we have a guess but not a decision" path unwritable.
 */
export function isConfident(c: Classification | null): boolean {
  return c !== null && c.confidence >= CLASSIFY_THRESHOLD;
}

/**
 * Kinds with nothing worth extracting.
 *
 * Build plan section 7: "a page that classifies as a POD with high confidence
 * does not need an extraction pass to find a rate on it." A POD's value is that
 * it exists and is signed; there are no fields on it to check against a load.
 * Skipping these is the second-largest saving in the phase after not calling a
 * model to read a title.
 */
const NOTHING_TO_EXTRACT: ReadonlySet<DocumentKind> = new Set<DocumentKind>([
  'pod',
  'w9',
  'insurance_certificate',
  'carrier_packet',
]);

export function worthExtracting(kind: DocumentKind): boolean {
  return !NOTHING_TO_EXTRACT.has(kind);
}
