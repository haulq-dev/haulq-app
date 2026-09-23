import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, request } from './api.ts';

function fetchReturning(status: number, body?: unknown) {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

describe('request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to GET with no body', async () => {
    const fetchSpy = fetchReturning(200, { ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    await request('/v1/checkin/abc123');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('/api/v1/checkin/abc123');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({});
    expect(init.body).toBeUndefined();
  });

  it('defaults to POST and sends JSON when a body is given', async () => {
    const fetchSpy = fetchReturning(200, { ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    await request('/v1/checkin/abc123/position', { body: { lat: 1, lng: 2 } });

    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ lat: 1, lng: 2 }));
  });

  it('respects an explicit method even with a body', async () => {
    const fetchSpy = fetchReturning(200, { ok: true });
    vi.stubGlobal('fetch', fetchSpy);

    await request('/v1/checkin/abc123/stops/s1', { method: 'PATCH', body: { milestone: 'arrived' } });

    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.method).toBe('PATCH');
  });

  it('returns undefined for a 204, without reading a body', async () => {
    vi.stubGlobal('fetch', fetchReturning(204));

    const result = await request('/v1/checkin/abc123/position', { method: 'POST' });

    expect(result).toBeUndefined();
  });

  it('parses and returns the JSON body on success', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, { loadReference: 42, stops: [] }));

    const result = await request<{ loadReference: number }>('/v1/checkin/abc123');

    expect(result).toEqual({ loadReference: 42, stops: [] });
  });

  it('throws ApiRequestError with the server-reported status, code and explanation', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning(404, { code: 'not_found', explanation: 'This check-in link is not valid.' }),
    );

    await expect(request('/v1/checkin/bad-token')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
      explanation: 'This check-in link is not valid.',
    });
  });

  it('falls back to a generic explanation and code when the error body has neither', async () => {
    vi.stubGlobal('fetch', fetchReturning(500, {}));

    const err = await request('/v1/checkin/abc123').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).code).toBe('unknown');
    expect((err as ApiRequestError).explanation).toBe('Something went wrong. Please try again.');
  });

  it('does not throw parsing an empty error body', async () => {
    vi.stubGlobal('fetch', fetchReturning(500));

    await expect(request('/v1/checkin/abc123')).rejects.toBeInstanceOf(ApiRequestError);
  });
});
