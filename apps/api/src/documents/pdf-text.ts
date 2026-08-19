/**
 * Pulling the text layer out of a PDF, with no dependencies.
 *
 * A PDF made by a broker's TMS already contains its words; they sit in content
 * streams, usually Flate-compressed, as arguments to the text-showing operators
 * `Tj` and `TJ`. Getting them out is an inflate and a scan, which is why this
 * exists rather than a page of OCR billing.
 *
 * ---------------------------------------------------------------------------
 * What this does not do, on purpose
 * ---------------------------------------------------------------------------
 *
 * It does not lay text out. Column order, reading order and whitespace between
 * cells are all approximate — the output is for phrase matching and labelled
 * value extraction, not for showing to anybody.
 *
 * It does not handle encrypted PDFs, non-Latin custom font encodings, or text
 * drawn as vector outlines. **Every one of those returns null rather than
 * partial text**, because a rate confirmation whose rate did not survive
 * decoding is worse than one that was never read: the first produces a confident
 * disagreement against a correct load, the second just costs an OCR call.
 */

import { inflateSync, inflateRawSync } from 'node:zlib';

export interface PdfText {
  text: string | null;
  pageCount: number | null;
}

/** Content-stream operators that put glyphs on the page. */
const SHOW_TEXT = /\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]+)>/g;

/**
 * Undo PDF string escaping: `\(`, `\)`, `\\`, octal, and line continuations.
 */
function unescapePdfString(raw: string): string {
  return raw
    .replace(/\\(\d{1,3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\\\r?\n/g, '');
}

function decodeHexString(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Every `stream ... endstream` body in the file, inflated where possible.
 *
 * Streams that will not inflate are skipped rather than failing the whole
 * document: a PDF's images and fonts are streams too, and they are expected not
 * to be readable text.
 */
function* contentStreams(buf: Buffer): Generator<string> {
  let index = 0;

  for (;;) {
    const start = buf.indexOf('stream', index);
    if (start === -1) return;

    // Skip the EOL that must follow the `stream` keyword.
    let bodyStart = start + 'stream'.length;
    if (buf[bodyStart] === 0x0d) bodyStart += 1;
    if (buf[bodyStart] === 0x0a) bodyStart += 1;

    const end = buf.indexOf('endstream', bodyStart);
    if (end === -1) return;

    const body = buf.subarray(bodyStart, end);
    index = end + 'endstream'.length;

    // Flate first, because that is what almost every generator emits. Raw
    // deflate is tried too — some producers omit the zlib header.
    for (const inflate of [inflateSync, inflateRawSync]) {
      try {
        yield inflate(body).toString('latin1');
        break;
      } catch {
        /* not this one */
      }
    }

    // Uncompressed streams are legal and small tools emit them.
    if (body.includes(Buffer.from('Tj')) || body.includes(Buffer.from('TJ'))) {
      yield body.toString('latin1');
    }
  }
}

/** `/Type /Page` occurrences, which is close enough for a page count. */
function countPages(buf: Buffer): number | null {
  const matches = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : null;
}

export function extractPdfText(buf: Buffer): PdfText {
  // An encrypted document's streams inflate to ciphertext. Better to declare it
  // unreadable than to emit mojibake that phrase matching will score against.
  if (buf.includes(Buffer.from('/Encrypt'))) return { text: null, pageCount: null };

  const pieces: string[] = [];

  for (const stream of contentStreams(buf)) {
    if (!/\bTJ?\b|\bTj\b/.test(stream)) continue;

    for (const match of stream.matchAll(SHOW_TEXT)) {
      const [whole, hex] = match;
      const decoded = hex
        ? decodeHexString(hex)
        : unescapePdfString(whole.slice(1, -1));
      if (decoded.trim()) pieces.push(decoded);
    }
    pieces.push('\n');
  }

  const text = pieces
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();

  // A handful of characters is a page of vector art with a stray label on it,
  // not a document. Treated as unread so it goes to OCR.
  if (text.length < 20) return { text: null, pageCount: countPages(buf) };

  return { text, pageCount: countPages(buf) };
}
