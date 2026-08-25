/**
 * The FMCSA client, against a real HTTP server.
 *
 * Same discipline `azure-reader.test.ts` already established for this repo's
 * other hand-rolled REST clients: a stub server on localhost, not a mocked
 * `fetch`, so the request that goes out is real — real query string, real
 * path shape. What this cannot prove is that the shape matches FMCSA's own
 * QCMobile contract; that was already proven once, in production, on
 * `haulq-site`'s `/api/verify` — this suite is protecting the port, not
 * discovering the shape from nothing.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { FmcsaError, lookupCarrier } from './fmcsa.ts';

let server: Server;
let base: string;
let script: { status: number; body: unknown };
const requests: string[] = [];

const CARRIER = {
  content: {
    carrier: {
      legalName: 'Prairie Freight LLC',
      dbaName: null,
      dotNumber: '1234567',
      allowedToOperate: 'Y',
      carrierOperation: { carrierOperationDesc: 'Interstate' },
      totalPowerUnits: 4,
      totalDrivers: 5,
      safetyRating: 'Satisfactory',
      phyCity: 'Wichita',
      phyState: 'KS',
    },
  },
};

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.statusCode = script.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(script.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  requests.length = 0;
  script = { status: 200, body: CARRIER };
});

describe('lookupCarrier', () => {
  it('reads a found carrier, mapping allowedToOperate to a word', async () => {
    const result = await lookupCarrier('MC-123456', 'test-key', base);

    assert.equal(result.found, true);
    assert.equal(result.legalName, 'Prairie Freight LLC');
    assert.equal(result.operatingStatus, 'Authorized');
    assert.equal(result.powerUnits, 4);
    assert.equal(result.location, 'Wichita, KS');
  });

  it('maps allowedToOperate: N to "Not authorized"', async () => {
    script.body = { content: { carrier: { ...CARRIER.content.carrier, allowedToOperate: 'N' } } };
    const result = await lookupCarrier('123456', 'test-key', base);
    assert.equal(result.operatingStatus, 'Not authorized');
  });

  it('maps a missing allowedToOperate to "Unknown"', async () => {
    const { allowedToOperate: _drop, ...rest } = CARRIER.content.carrier;
    script.body = { content: { carrier: rest } };
    const result = await lookupCarrier('123456', 'test-key', base);
    assert.equal(result.operatingStatus, 'Unknown');
  });

  it('requests a docket number path for an MC number', async () => {
    await lookupCarrier('MC-123456', 'test-key', base);
    assert.match(requests[0]!, /^\/docket-number\/123456\?webKey=test-key$/);
  });

  it('requests the bare path for a long DOT-shaped number', async () => {
    await lookupCarrier('1234567', 'test-key', base);
    assert.match(requests[0]!, /^\/1234567\?webKey=test-key$/);
  });

  it('reports not found without throwing when FMCSA has no record', async () => {
    script.body = { content: [] };
    const result = await lookupCarrier('999999', 'test-key', base);
    assert.equal(result.found, false);
    assert.equal(result.operatingStatus, null);
  });

  it('reports not found for a query with no digits, without a request', async () => {
    const result = await lookupCarrier('nonsense', 'test-key', base);
    assert.equal(result.found, false);
    assert.equal(requests.length, 0);
  });

  it('throws FmcsaError on a transport failure, so the caller can decide to retry', async () => {
    script.status = 503;
    await assert.rejects(
      () => lookupCarrier('123456', 'test-key', base),
      (err: unknown) => {
        assert.ok(err instanceof FmcsaError);
        assert.equal(err.status, 503);
        return true;
      },
    );
  });

  it('throws FmcsaError when the server is unreachable', async () => {
    await assert.rejects(
      () => lookupCarrier('123456', 'test-key', 'http://127.0.0.1:1'),
      (err: unknown) => {
        assert.ok(err instanceof FmcsaError);
        return true;
      },
    );
  });
});
