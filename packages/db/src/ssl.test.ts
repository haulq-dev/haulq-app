/**
 * TLS mode selection.
 *
 * Runs with no database — it is pure string handling — which matters because
 * getting this wrong produces a `28000` authentication error that reads like
 * bad credentials and is not.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sslFor } from './ssl.ts';

describe('sslFor', () => {
  it('uses TLS for Render\'s external host', () => {
    // The case that failed: a connection string copied from the dashboard's
    // External tab, run from a laptop.
    assert.equal(
      sslFor('postgresql://haulq:pw@dpg-abc123-a.oregon-postgres.render.com/haulq'),
      'require',
    );
  });

  it('uses TLS for Render\'s internal host too', () => {
    // Internal does not require it, but accepts it, and one rule is easier to
    // reason about than "internal hostnames have no dots".
    assert.equal(sslFor('postgresql://haulq:pw@dpg-abc123-a/haulq'), 'require');
  });

  it('does not use TLS locally', () => {
    for (const host of ['localhost', '127.0.0.1']) {
      assert.equal(
        sslFor(`postgres://haulq:haulq@${host}:5432/haulq_test`),
        false,
        `${host} should not use TLS`,
      );
    }
  });

  it('honours an explicit sslmode over the guess', () => {
    assert.equal(
      sslFor('postgres://u:p@localhost:5432/db?sslmode=require'),
      'require',
      'explicit require on a local host is respected',
    );
    assert.equal(
      sslFor('postgres://u:p@db.example.com/db?sslmode=disable'),
      false,
      'explicit disable on a remote host is respected',
    );
  });

  it('maps verify-ca and verify-full to full verification', () => {
    assert.equal(sslFor('postgres://u:p@h/db?sslmode=verify-full'), 'verify-full');
    assert.equal(sslFor('postgres://u:p@h/db?sslmode=verify-ca'), 'verify-full');
  });

  it('does not throw on a malformed url', () => {
    // Let postgres.js report its own error rather than failing here with a
    // less useful one.
    assert.equal(sslFor('not a url'), false);
  });
});
