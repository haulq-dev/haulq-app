/**
 * The APNs pieces that don't need Apple: the provider token, the payload and
 * how a response is read. The live call itself is proven on a device with
 * `POST /v1/push/test`.
 */

import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, it } from 'node:test';
import { apnsJwt, apnsPayload, ApnsSender, classifyApnsResponse } from './apns.ts';
import { PushError } from './sender.ts';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('apnsJwt', () => {
  it('is an ES256 token Apple can verify: key id in the header, team as issuer', () => {
    const jwt = apnsJwt({ keyId: 'ABC123DEFG', teamId: 'TEAM123456' }, privateKey, 1_700_000_000);
    const [h, c, s] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h!, 'base64url').toString()), { alg: 'ES256', kid: 'ABC123DEFG' });
    assert.deepEqual(JSON.parse(Buffer.from(c!, 'base64url').toString()), { iss: 'TEAM123456', iat: 1_700_000_000 });
    const ok = verify('sha256', Buffer.from(`${h}.${c}`), { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'));
    assert.equal(ok, true);
  });
});

describe('apnsPayload', () => {
  it('carries the tap-through path and carrier beside aps, grouped by carrier', () => {
    const payload = JSON.parse(
      apnsPayload({ title: 'Load 1042', body: 'No check-in in 4 hours.', path: '/loads/L1', orgId: 'o1', collapseId: 'x' }),
    );
    assert.deepEqual(payload, {
      aps: { alert: { title: 'Load 1042', body: 'No check-in in 4 hours.' }, sound: 'default', 'thread-id': 'o1' },
      path: '/loads/L1',
      orgId: 'o1',
    });
  });
});

describe('classifyApnsResponse', () => {
  it('reads sent, and a token that will never work again', () => {
    assert.equal(classifyApnsResponse(200, undefined), 'sent');
    assert.equal(classifyApnsResponse(410, 'Unregistered'), 'dead');
    assert.equal(classifyApnsResponse(400, 'BadDeviceToken'), 'dead');
    assert.equal(classifyApnsResponse(400, 'DeviceTokenNotForTopic'), 'dead');
  });

  it('retries throttling and outages, not a request that is wrong', () => {
    const thrown = (status: number, reason?: string) => {
      try {
        classifyApnsResponse(status, reason);
      } catch (err) {
        return err as PushError;
      }
      throw new Error('expected a throw');
    };
    assert.equal(thrown(429, 'TooManyRequests').retryable, true);
    assert.equal(thrown(503, 'ServiceUnavailable').retryable, true);
    assert.equal(thrown(403, 'InvalidProviderToken').retryable, false);
    assert.equal(thrown(400, 'BadCollapseId').retryable, false);
  });
});

describe('ApnsSender', () => {
  it('accepts a key stored on one line with \\n escapes', () => {
    const oneLine = pem.replace(/\n/g, '\\n');
    const sender = new ApnsSender({ keyId: 'K', teamId: 'T', privateKey: oneLine, bundleId: 'ai.haulq.app', environment: 'sandbox' });
    assert.equal(sender.name, 'apns-sandbox');
    assert.deepEqual(sender.platforms, ['ios']);
    sender.close();
  });
});
