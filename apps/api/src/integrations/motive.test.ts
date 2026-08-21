import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { motiveAuthorizeUrl } from './motive.ts';

describe('motiveAuthorizeUrl', () => {
  it('builds the authorize URL with the scopes Track actually uses', () => {
    const url = new URL(
      motiveAuthorizeUrl(
        { clientId: 'abc', redirectUri: 'https://api.haulq.ai/v1/integrations/motive/callback' },
        'signed-state',
      ),
    );

    assert.equal(url.origin + url.pathname, 'https://gomotive.com/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'abc');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      'https://api.haulq.ai/v1/integrations/motive/callback',
    );
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('state'), 'signed-state');
    assert.equal(
      url.searchParams.get('scope'),
      'locations.vehicle_locations_list vehicles.read',
    );
  });

  it('does not ask for HOS scopes — that is Phase 4\'s question, not Track\'s', () => {
    const url = new URL(motiveAuthorizeUrl({ clientId: 'x', redirectUri: 'https://x' }, 's'));
    assert.ok(!url.searchParams.get('scope')?.includes('hos_logs'));
  });
});
