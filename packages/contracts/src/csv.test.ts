/**
 * CSV parsing.
 *
 * Every case here is something a real carrier export does. None of them are
 * hypothetical edge cases invented to exercise the parser — they are the
 * reasons the parser is hand-written rather than a two-line call into a
 * library, and each one silently corrupts an import if unhandled.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectDelimiter, detectHeaderRow, parseCsv } from './csv.ts';

describe('delimiter detection', () => {
  it('picks the comma in a normal file', () => {
    assert.equal(detectDelimiter(['a,b,c', '1,2,3']), ',');
  });

  it('picks the semicolon when commas sit inside fields', () => {
    // The case that defeats frequency counting: there are more commas than
    // semicolons here, and the commas are all inside names.
    const lines = [
      'Broker;Origin;Rate',
      '"Smith, John & Co";"Wichita, KS";1800',
      '"Doe, Jane LLC";"Tulsa, OK";1500',
    ];
    assert.equal(detectDelimiter(lines), ';');
  });

  it('picks the tab in a tab-separated export', () => {
    assert.equal(detectDelimiter(['a\tb\tc', '1\t2\t3']), '\t');
  });
});

describe('header detection', () => {
  it('skips a report title and a blank line above the headers', () => {
    // Every dispatch package's "export to CSV" does some version of this.
    const lines = [
      'Load History Report',
      'Prairie Freight LLC — 01/01/2026 to 03/31/2026',
      '',
      'Load #,Broker,Origin,Destination,Rate',
      '1001,Acme,Wichita KS,Denver CO,2400',
    ];
    assert.equal(detectHeaderRow(lines, ','), 3);
  });

  it('does not mistake a numeric first row for headers', () => {
    const lines = ['1001,Acme,2400', 'Load,Broker,Rate'];
    assert.equal(detectHeaderRow(lines, ','), 1);
  });
});

describe('parsing', () => {
  it('handles quoted fields containing the delimiter', () => {
    const { rows } = parseCsv('Broker,Origin\n"Acme, Inc.","Wichita, KS"');
    assert.equal(rows[0]!.cells['Broker'], 'Acme, Inc.');
    assert.equal(rows[0]!.cells['Origin'], 'Wichita, KS');
  });

  it('handles a newline inside a quoted field', () => {
    // A delivery instruction with a line break, unhandled, turns one load into
    // three broken rows.
    const { rows } = parseCsv(
      'Load,Notes\n1001,"Call ahead.\nDock 4 after 3pm."\n1002,Normal',
    );
    assert.equal(rows.length, 2);
    assert.match(rows[0]!.cells['Notes']!, /Dock 4/);
    assert.equal(rows[1]!.cells['Load'], '1002');
  });

  it('handles escaped quotes', () => {
    const { rows } = parseCsv('Broker\n"Acme ""The Best"" Logistics"');
    assert.equal(rows[0]!.cells['Broker'], 'Acme "The Best" Logistics');
  });

  it('strips a UTF-8 BOM and reports it', () => {
    // Excel writes one. Unstripped, the first header becomes "﻿Load" and
    // never matches any mapping rule.
    const { headers, dialect } = parseCsv('﻿Load,Broker\n1,Acme');
    assert.equal(headers[0], 'Load');
    assert.equal(dialect.hadBom, true);
  });

  it('handles CRLF line endings', () => {
    const { rows } = parseCsv('Load,Broker\r\n1001,Acme\r\n1002,Beta');
    assert.equal(rows.length, 2);
    assert.equal(rows[1]!.cells['Broker'], 'Beta');
  });

  it('keeps both columns when headers are duplicated', () => {
    // Silently dropping one, and the choice of which depending on order, is
    // worse than an ugly name.
    const { headers } = parseCsv('Date,Broker,Date\n1,2,3');
    assert.deepEqual(headers, ['Date', 'Broker', 'Date (2)']);
  });

  it('names unnamed columns rather than collapsing them', () => {
    const { headers } = parseCsv('Load,,Rate\n1,x,2');
    assert.deepEqual(headers, ['Load', 'column_2', 'Rate']);
  });

  it('skips a trailing totals row', () => {
    const csv = [
      'Load,Broker,Origin,Destination,Rate',
      '1001,Acme,Wichita,Denver,2400',
      '1002,Beta,Tulsa,Dallas,1800',
      ',,,,4200',
    ].join('\n');
    const { rows } = parseCsv(csv);
    assert.equal(rows.length, 2, 'the totals row is not a load');
  });

  it('reports a ragged row without discarding it', () => {
    // An unquoted comma inside an address. The row is still mostly usable, and
    // dropping it silently loses a load.
    const csv = 'Load,Broker,Origin,Rate\n1001,Acme,Wichita, KS,2400';
    const { rows } = parseCsv(csv);
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.issues[0]!, /unquoted comma/);
  });

  it('fills missing trailing columns rather than shifting', () => {
    const { rows } = parseCsv('Load,Broker,Rate\n1001,Acme');
    assert.equal(rows[0]!.cells['Rate'], '');
    assert.match(rows[0]!.issues[0]!, /left empty/);
  });

  it('numbers rows from the first data row, not the file line', () => {
    // The operator's error list has to point at something they can find. Row 1
    // is the first load, regardless of how many title rows sat above it.
    const csv = 'Report\n\nLoad,Broker\n1001,Acme\n1002,Beta';
    const { rows } = parseCsv(csv);
    assert.equal(rows[0]!.rowNumber, 1);
    assert.equal(rows[1]!.rowNumber, 2);
  });

  it('records what it skipped so the operator can check', () => {
    const csv = 'Load History Report\n\nLoad,Broker\n1001,Acme';
    const { dialect } = parseCsv(csv);
    assert.deepEqual(dialect.skippedPreamble, ['Load History Report']);
  });
});
