import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signOAuthState, verifyOAuthState } from './state.ts';

describe('OAuth state signing', () => {
  it('round-trips the org id', () => {
    const state = signOAuthState('a-secret', 'org-123');
    assert.equal(verifyOAuthState('a-secret', state), 'org-123');
  });

  it('refuses a state signed with a different secret', () => {
    const state = signOAuthState('a-secret', 'org-123');
    assert.equal(verifyOAuthState('a-different-secret', state), null);
  });

  it('refuses a tampered org id even with a valid-looking signature', () => {
    const state = signOAuthState('a-secret', 'org-123');
    const [, nonce, sig] = state.split('.');
    const tampered = `org-456.${nonce}.${sig}`;
    assert.equal(verifyOAuthState('a-secret', tampered), null);
  });

  it('refuses garbage input rather than throwing', () => {
    assert.equal(verifyOAuthState('a-secret', 'not-a-real-state'), null);
    assert.equal(verifyOAuthState('a-secret', ''), null);
  });

  it('produces a different state each time, even for the same org', () => {
    assert.notEqual(signOAuthState('a-secret', 'org-123'), signOAuthState('a-secret', 'org-123'));
  });
});
