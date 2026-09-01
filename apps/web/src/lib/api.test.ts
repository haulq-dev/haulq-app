import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, readSession, request, writeSession } from './api.ts';

function fetchReturning(status: number, body?: unknown) {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

describe('request', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends no auth headers with no session at all', async () => {
    const fetchSpy = fetchReturning(200, { ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    await request('/v1/onboarding', { session: null });

    const [url, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('/api/v1/onboarding');
    expect(init.headers).toEqual({});
  });

  it('sends the dev-mode user and org headers for a stored session', async () => {
    const fetchSpy = fetchReturning(200, { ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    writeSession({ userId: 'user-1', orgId: 'org-1' });

    await request('/v1/onboarding');

    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.headers).toEqual({ 'X-HaulQ-User-Id': 'user-1', 'X-HaulQ-Org-Id': 'org-1' });
  });

  it('defaults to GET with no body', async () => {
    const fetchSpy = fetchReturning(200, {});
    vi.stubGlobal('fetch', fetchSpy);

    await request('/v1/onboarding', { session: null });

    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('defaults to POST and sends JSON when a body is given', async () => {
    const fetchSpy = fetchReturning(200, {});
    vi.stubGlobal('fetch', fetchSpy);

    await request('/v1/trucks', { session: null, body: { label: 'Unit 1' } });

    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ label: 'Unit 1' }));
  });

  it('sends a raw body with its own content type, for the CSV upload', async () => {
    const fetchSpy = fetchReturning(201, { batch: {} });
    vi.stubGlobal('fetch', fetchSpy);

    await request('/v1/imports', {
      session: null,
      method: 'POST',
      raw: { body: 'a,b,c\n1,2,3', contentType: 'text/csv' },
    });

    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.headers).toMatchObject({ 'Content-Type': 'text/csv' });
    expect(init.body).toBe('a,b,c\n1,2,3');
  });

  it('returns undefined for a 204', async () => {
    vi.stubGlobal('fetch', fetchReturning(204));
    const result = await request('/v1/trucks/1', { session: null, method: 'DELETE' });
    expect(result).toBeUndefined();
  });

  it('parses and returns the JSON body on success', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, { loadCount: 3 }));
    const result = await request<{ loadCount: number }>('/v1/insights', { session: null });
    expect(result).toEqual({ loadCount: 3 });
  });

  it('throws ApiRequestError with the server-reported status, code and explanation', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning(422, { code: 'invalid_request', explanation: 'That rate cannot be negative.' }),
    );

    await expect(request('/v1/loads', { session: null, body: {} })).rejects.toMatchObject({
      status: 422,
      code: 'invalid_request',
      explanation: 'That rate cannot be negative.',
    });
  });

  it('falls back to a generic explanation when the error body has none', async () => {
    vi.stubGlobal('fetch', fetchReturning(500, {}));
    const err = await request('/v1/loads', { session: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).explanation).toBe('Something went wrong. Please try again.');
  });

  it('drops the org from the session on an unauthenticated response, keeping the user', async () => {
    writeSession({ userId: 'user-1', orgId: 'stale-org' });
    vi.stubGlobal(
      'fetch',
      fetchReturning(401, { code: 'unauthenticated', explanation: 'no membership' }),
    );

    await expect(request('/v1/onboarding')).rejects.toBeInstanceOf(ApiRequestError);

    expect(readSession()).toEqual({ userId: 'user-1' });
  });

  it('does not touch the session on an unauthenticated response with no org set', async () => {
    writeSession({ userId: 'user-1' });
    vi.stubGlobal(
      'fetch',
      fetchReturning(401, { code: 'unauthenticated', explanation: 'sign in' }),
    );

    await expect(request('/v1/onboarding')).rejects.toBeInstanceOf(ApiRequestError);

    expect(readSession()).toEqual({ userId: 'user-1' });
  });
});
