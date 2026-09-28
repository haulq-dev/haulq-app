import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readOAuthState, signOAuthState, verifyOAuthState } from './state.ts';

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

  it('carries where the connect started, signed with the rest', () => {
    const app = signOAuthState('a-secret', 'org-123', 'app');
    assert.deepEqual(readOAuthState('a-secret', app), { orgId: 'org-123', client: 'app' });
    assert.deepEqual(readOAuthState('a-secret', signOAuthState('a-secret', 'org-123')), { orgId: 'org-123', client: 'web' });
    assert.equal(verifyOAuthState('a-secret', app), 'org-123');
  });

  it('refuses a web state edited to claim the app, and an app state with the marker stripped', () => {
    const [org, nonce, sig] = signOAuthState('a-secret', 'org-123').split('.');
    assert.equal(readOAuthState('a-secret', `${org}.${nonce}.app.${sig}`), null);
    const parts = signOAuthState('a-secret', 'org-123', 'app').split('.');
    assert.equal(readOAuthState('a-secret', `${parts[0]}.${parts[1]}.${parts[3]}`), null);
    assert.equal(readOAuthState('a-secret', `${parts[0]}.${parts[1]}.web.${parts[3]}`), null);
  });
});
