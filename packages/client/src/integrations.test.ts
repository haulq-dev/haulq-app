import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectResult, inAppPath, pushOrgId, pushTapPath } from './integrations.ts';

describe('inAppPath', () => {
  it("reads the app's own scheme, where the host is the first path segment", () => {
    assert.equal(inAppPath('ai.haulq.app://integrations?motive=connected'), '/integrations?motive=connected');
    assert.equal(inAppPath('ai.haulq.app://integrations'), '/integrations');
    assert.equal(inAppPath('ai.haulq.app://loads/L1'), '/loads/L1');
  });

  it('keeps an https link to its path, and refuses anything else', () => {
    assert.equal(inAppPath('https://app.haulq.ai/invite/abc?x=1'), '/invite/abc?x=1');
    assert.equal(inAppPath('javascript:alert(1)'), null);
    assert.equal(inAppPath('not a url'), null);
  });
});

describe('connectResult', () => {
  it('says what happened, in words', () => {
    assert.deepEqual(connectResult('?motive=denied'), {
      provider: 'motive',
      outcome: 'denied',
      text: 'The Motive connection was cancelled.',
      ok: false,
    });
    assert.equal(connectResult('?mailbox=connected')?.ok, true);
  });

  it('ignores anything it does not recognise', () => {
    assert.equal(connectResult('?motive=hacked'), null);
    assert.equal(connectResult(''), null);
  });
});

describe('pushTapPath', () => {
  it("opens the app's own paths, and home for anything else", () => {
    assert.equal(pushTapPath({ path: '/loads/L1' }), '/loads/L1');
    assert.equal(pushTapPath({ path: '//evil.example/x' }), '/');
    assert.equal(pushTapPath({ path: 'https://evil.example' }), '/');
    assert.equal(pushTapPath({ path: '/x:y' }), '/');
    assert.equal(pushTapPath({}), '/');
    assert.equal(pushTapPath(null), '/');
  });

  it('reads a carrier id only when it looks like one', () => {
    assert.equal(pushOrgId({ orgId: '00000000-0000-4000-8000-000000000001' }), '00000000-0000-4000-8000-000000000001');
    assert.equal(pushOrgId({ orgId: 'nope' }), null);
  });
});
