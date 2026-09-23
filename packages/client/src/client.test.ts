import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiRequestError, createApiClient, type ApiClientConfig } from './client.ts';
import { isNotEntitled, isSubscriptionActive, isSubscriptionInactive } from './access.ts';
import type { Session } from './types.ts';

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const text = body === undefined ? '' : JSON.stringify(body);
    return new Response(status === 204 ? null : text, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function config(overrides: Partial<ApiClientConfig> & { fetch: typeof fetch }): ApiClientConfig {
  return {
    baseUrl: 'https://api.test',
    readSession: (): Session => ({ userId: 'u1', orgId: 'org-1' }),
    authHeaders: async (s) => ({
      Authorization: 'Bearer t',
      ...(s?.orgId ? { 'X-HaulQ-Org-Id': s.orgId } : {}),
    }),
    onOrgUnresolved: () => {},
    ...overrides,
  };
}

describe('createApiClient', () => {
  it('sends JSON with the injected credentials and returns the parsed body', async () => {
    const f = fakeFetch(200, { ok: true });
    const client = createApiClient(config({ fetch: f.fn }));
    const res = await client.request<{ ok: boolean }>('/v1/loads', { body: { a: 1 } });

    assert.deepEqual(res, { ok: true });
    const call = f.calls[0]!;
    assert.equal(call.url, 'https://api.test/v1/loads');
    assert.equal(call.init?.method, 'POST');
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer t');
    assert.equal(headers['X-HaulQ-Org-Id'], 'org-1');
    assert.equal(headers['Content-Type'], 'application/json');
  });

  it('answers undefined for a 204', async () => {
    const f = fakeFetch(204, undefined);
    const client = createApiClient(config({ fetch: f.fn }));
    assert.equal(await client.request('/v1/x', { method: 'DELETE' }), undefined);
  });

  it("throws the API's own explanation", async () => {
    const f = fakeFetch(403, { code: 'forbidden', explanation: 'Needs owner access.' });
    const client = createApiClient(config({ fetch: f.fn }));
    await assert.rejects(client.request('/v1/x'), (err: unknown) => {
      assert.ok(err instanceof ApiRequestError);
      assert.equal(err.status, 403);
      assert.equal(err.code, 'forbidden');
      assert.equal(err.explanation, 'Needs owner access.');
      return true;
    });
  });

  it('hands an unresolved org back to the app, and only when the session named one', async () => {
    const seen: Session[] = [];
    const f = fakeFetch(401, { code: 'unauthenticated', explanation: 'no' });

    const withOrg = createApiClient(config({ fetch: f.fn, onOrgUnresolved: (s) => seen.push(s) }));
    await assert.rejects(withOrg.request('/v1/x'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.orgId, 'org-1');

    const noOrg = createApiClient(
      config({ fetch: f.fn, readSession: (): Session => ({ userId: 'u1' }), onOrgUnresolved: (s) => seen.push(s) }),
    );
    await assert.rejects(noOrg.request('/v1/x'));
    assert.equal(seen.length, 1);
  });
});

describe('access', () => {
  it('counts only active as paid', () => {
    assert.equal(isSubscriptionActive('active'), true);
    for (const s of ['trialing', 'past_due', 'paused', 'cancelled', undefined] as const) {
      assert.equal(isSubscriptionActive(s), false, String(s));
    }
  });

  it('recognises the plan and paywall refusals by code', () => {
    assert.equal(isNotEntitled(new ApiRequestError(403, { code: 'not_entitled' })), true);
    assert.equal(isNotEntitled(new ApiRequestError(403, { code: 'forbidden' })), false);
    assert.equal(isSubscriptionInactive(new ApiRequestError(402, { code: 'subscription_inactive' })), true);
    assert.equal(isSubscriptionInactive(new Error('x')), false);
  });
});
