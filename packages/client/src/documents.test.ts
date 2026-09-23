import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { documentTitle, extractedRaw, fileSize, humanizeField, uploadSummary } from './documents.ts';

describe('documents', () => {
  it('titles kinds without mangling acronyms', () => {
    assert.equal(documentTitle('pod'), 'POD');
    assert.equal(documentTitle('bol'), 'BOL');
    assert.equal(documentTitle('rate_confirmation'), 'Rate confirmation');
  });

  it('reports a resend as already held', () => {
    assert.equal(uploadSummary(2, 1), '2 added, 1 you already had');
    assert.equal(uploadSummary(0, 1), '1 you already had');
  });

  it('formats sizes and field names', () => {
    assert.equal(fileSize(900), '900 B');
    assert.equal(fileSize(250_000), '244 KB');
    assert.equal(fileSize(3 * 1024 * 1024), '3.0 MB');
    assert.equal(humanizeField('brokerLoadNumber'), 'broker load number');
  });

  it('reads what extraction found, or nothing', () => {
    assert.equal(extractedRaw({ extracted: { rateAmount: { raw: '$1' } } }, 'rateAmount'), '$1');
    assert.equal(extractedRaw({ extracted: null }, 'rateAmount'), '');
  });
});
