/**
 * The PDF text layer reader.
 *
 * The fixtures are real PDFs, built here rather than checked in, so the suite
 * says what shape it is testing instead of hiding it in a binary. Both stream
 * encodings a generator might emit are covered, because "works on the PDFs I
 * happened to try" is how this class of parser fails in production.
 *
 * The most important test is the last group: this returns null rather than
 * partial text. A rate confirmation whose rate did not survive decoding produces
 * a confident disagreement against a correct load, which is worse than never
 * having read it.
 */

import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { extractPdfText } from './pdf-text.ts';

/** A one-page PDF whose content stream draws `lines`. */
function makePdf(lines: string[], options: { compress?: boolean; pages?: number } = {}): Buffer {
  const escaped = lines.map((l) => l.replace(/([()\\])/g, '\\$1'));
  const content =
    'BT /F1 12 Tf 72 720 Td\n' +
    escaped.map((l, i) => `${i ? '0 -16 Td\n' : ''}(${l}) Tj\n`).join('') +
    'ET\n';

  const body = options.compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  const filter = options.compress ? ' /Filter /FlateDecode' : '';

  const pageObjects = Array.from(
    { length: options.pages ?? 1 },
    (_, i) =>
      `${3 + i} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Contents 90 0 R /Resources << /Font << /F1 91 0 R >> >> >> endobj\n`,
  ).join('');

  return Buffer.concat([
    Buffer.from(
      '%PDF-1.4\n' +
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
        `2 0 obj << /Type /Pages /Count ${options.pages ?? 1} >> endobj\n` +
        pageObjects +
        `90 0 obj << /Length ${body.length}${filter} >> stream\n`,
      'latin1',
    ),
    body,
    Buffer.from(
      '\nendstream endobj\n' +
        '91 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n' +
        'trailer << /Root 1 0 R >>\n%%EOF\n',
      'latin1',
    ),
  ]);
}

const RATECON_LINES = [
  'PRAIRIE LOGISTICS LLC',
  'RATE CONFIRMATION',
  'Carrier: Test Carrier LLC',
  'Load Number: 84213',
  'Total Rate: $2,400.00',
];

describe('extractPdfText', () => {
  it('reads an uncompressed content stream', () => {
    const { text } = extractPdfText(makePdf(RATECON_LINES));
    assert.ok(text, 'expected text');
    assert.match(text!, /RATE CONFIRMATION/);
    assert.match(text!, /\$2,400\.00/);
  });

  it('reads a Flate-compressed content stream, which is what real generators emit', () => {
    const { text } = extractPdfText(makePdf(RATECON_LINES, { compress: true }));
    assert.ok(text);
    assert.match(text!, /RATE CONFIRMATION/);
    assert.match(text!, /Load Number: 84213/);
  });

  it('survives parentheses in the text, which PDF uses as string delimiters', () => {
    const { text } = extractPdfText(
      makePdf(['Broker: Acme (Midwest) Inc.', 'Total Rate: $1,000.00'], { compress: true }),
    );
    assert.match(text ?? '', /Acme \(Midwest\) Inc\./);
  });

  it('counts pages without counting the page tree node', () => {
    // `/Type /Pages` is the tree; only `/Type /Page` entries are pages.
    assert.equal(extractPdfText(makePdf(RATECON_LINES, { pages: 3 })).pageCount, 3);
    assert.equal(extractPdfText(makePdf(RATECON_LINES)).pageCount, 1);
  });

  it('feeds the classifier well enough to identify the document', async () => {
    // The point of this reader is not fidelity, it is that the next two steps
    // work off its output. That is the assertion worth making.
    const { classifyDeterministically, isConfident } = await import('@haulq/contracts');
    const { text } = extractPdfText(makePdf(RATECON_LINES, { compress: true }));
    const classified = classifyDeterministically({ text: text ?? '' });
    assert.equal(classified?.kind, 'rate_confirmation');
    assert.ok(isConfident(classified));
  });

  it('feeds the extractor well enough to find the money', async () => {
    const { extractDeterministically } = await import('@haulq/contracts');
    const { text } = extractPdfText(makePdf(RATECON_LINES, { compress: true }));
    const extracted = extractDeterministically({
      text: text ?? '',
      kind: 'rate_confirmation',
    });
    assert.equal(extracted.fields['rateAmount']?.value, 240000);
    assert.equal(extracted.fields['brokerLoadNumber']?.value, '84213');
  });
});

describe('extractPdfText — declining rather than guessing', () => {
  it('returns null for an encrypted document', () => {
    const encrypted = Buffer.concat([
      Buffer.from('%PDF-1.4\ntrailer << /Encrypt 9 0 R >>\n', 'latin1'),
      makePdf(RATECON_LINES),
    ]);
    assert.equal(extractPdfText(encrypted).text, null);
  });

  it('returns null for a page with almost nothing on it', () => {
    // A scan is a single image with no text layer. Emitting the three stray
    // characters a vector logo produces would give phrase matching something to
    // score, and it would score it wrong.
    assert.equal(extractPdfText(makePdf(['x'])).text, null);
  });

  it('returns null rather than throwing on bytes that are not a PDF', () => {
    assert.equal(extractPdfText(Buffer.from('this is not a pdf at all')).text, null);
    assert.equal(extractPdfText(Buffer.alloc(0)).text, null);
  });

  it('does not choke on an image stream it cannot inflate', () => {
    const withJunk = Buffer.concat([
      makePdf(RATECON_LINES, { compress: true }),
      Buffer.from('\n99 0 obj << /Subtype /Image >> stream\n', 'latin1'),
      Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]),
      Buffer.from('\nendstream endobj\n', 'latin1'),
    ]);
    assert.match(extractPdfText(withJunk).text ?? '', /RATE CONFIRMATION/);
  });
});
