/**
 * Type sniffing and filename hygiene.
 *
 * Pure and fast, so it runs without a database. Every case here is one a real
 * upload produces: a phone photo labelled as a JPEG, a scanner's TIFF, a
 * browser's `octet-stream`, and a filename carrying a path.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeFilename, sniff } from './sniff.ts';

const bytes = (...b: number[]) => Buffer.from(b);
const pad = (buf: Buffer, n = 32) => Buffer.concat([buf, Buffer.alloc(n)]);

describe('sniff', () => {
  it('recognises a PDF', () => {
    assert.equal(sniff(pad(Buffer.from('%PDF-1.7\n'))), 'application/pdf');
  });

  it('recognises a JPEG', () => {
    assert.equal(sniff(pad(bytes(0xff, 0xd8, 0xff, 0xe0))), 'image/jpeg');
  });

  it('recognises a PNG by the whole signature', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    assert.equal(sniff(pad(png)), 'image/png');
  });

  it('does not accept a truncated PNG signature', () => {
    // \x89PNG followed by something else is a mangled transfer, not a PNG.
    assert.equal(sniff(pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00))), null);
  });

  it('recognises TIFF in both byte orders', () => {
    assert.equal(sniff(pad(bytes(0x49, 0x49, 0x2a, 0x00))), 'image/tiff');
    assert.equal(sniff(pad(bytes(0x4d, 0x4d, 0x00, 0x2a))), 'image/tiff');
  });

  it('recognises an iPhone HEIC', () => {
    const heic = Buffer.concat([
      bytes(0x00, 0x00, 0x00, 0x18),
      Buffer.from('ftypheic'),
      Buffer.alloc(16),
    ]);
    assert.equal(sniff(heic), 'image/heic');
  });

  it('does not accept an ISO container brand it cannot read', () => {
    const mp4 = Buffer.concat([
      bytes(0x00, 0x00, 0x00, 0x18),
      Buffer.from('ftypisom'),
      Buffer.alloc(16),
    ]);
    assert.equal(sniff(mp4), null, 'a video is not a document');
  });

  it('refuses an empty buffer rather than guessing', () => {
    assert.equal(sniff(Buffer.alloc(0)), null);
  });

  it('refuses plain text', () => {
    assert.equal(sniff(Buffer.from('Dear carrier, please find attached')), null);
  });

  it('is not fooled by a PDF extension on non-PDF bytes', () => {
    assert.equal(sniff(Buffer.from('PK\x03\x04 this is a zip')), null);
  });
});

describe('safeFilename', () => {
  it('keeps an ordinary name', () => {
    assert.equal(safeFilename('rate-confirmation.pdf', 'x'), 'rate-confirmation.pdf');
  });

  it('strips a path', () => {
    assert.equal(safeFilename('C:\\Users\\jay\\ratecon.pdf', 'x'), 'ratecon.pdf');
    assert.equal(safeFilename('../../etc/passwd', 'x'), 'passwd');
  });

  it('removes characters that would split a response header', () => {
    const out = safeFilename('bad\r\nX-Injected: yes.pdf', 'x');
    assert.ok(!out.includes('\r') && !out.includes('\n'));
  });

  it('falls back when nothing usable is left', () => {
    assert.equal(safeFilename('', 'document.pdf'), 'document.pdf');
    assert.equal(safeFilename('...', 'document.pdf'), 'document.pdf');
    assert.equal(safeFilename(undefined, 'document.pdf'), 'document.pdf');
  });

  it('does not grow without bound', () => {
    assert.ok(safeFilename('a'.repeat(500) + '.pdf', 'x').length <= 120);
  });
});
