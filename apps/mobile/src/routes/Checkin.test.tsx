import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckinPreview } from '../lib/api.ts';
import { CheckinScreen, tokenFromInput } from './Checkin.tsx';

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, request: vi.fn() };
});
vi.mock('../lib/haptics.ts', () => ({ tapFeedback: vi.fn(), successFeedback: vi.fn() }));
vi.mock('@capacitor/geolocation', () => ({
  Geolocation: { getCurrentPosition: vi.fn().mockRejectedValue(new Error('not used in these tests')) },
}));

import { Geolocation } from '@capacitor/geolocation';
import { request } from '../lib/api.ts';

const STORED_TOKEN_KEY = 'haulq.driver.checkinToken';

const somePreview: CheckinPreview = {
  loadReference: 42,
  status: 'in_transit',
  truckLabel: 'Unit 1',
  stops: [],
};

const previewWithOneStop: CheckinPreview = {
  loadReference: 42,
  status: 'in_transit',
  truckLabel: 'Unit 1',
  stops: [
    {
      id: 'stop-1',
      seq: 1,
      type: 'pickup',
      city: 'Kansas City',
      state: 'MO',
      facilityName: null,
      windowStart: null,
      windowEnd: null,
      arrivedAt: null,
      loadingStartedAt: null,
      loadingEndedAt: null,
      departedAt: null,
    },
  ],
};

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CheckinScreen />
    </QueryClientProvider>,
  );
}

describe('tokenFromInput', () => {
  it('extracts the token from a pasted check-in link', () => {
    expect(tokenFromInput('https://app.haulq.ai/checkin/K4H7-QX2M')).toBe('K4H7-QX2M');
  });

  it('strips a trailing slash off a pasted link', () => {
    expect(tokenFromInput('https://app.haulq.ai/checkin/K4H7-QX2M/')).toBe('K4H7-QX2M');
  });

  it('passes a bare code through unchanged, trimmed', () => {
    expect(tokenFromInput('  K4H7-QX2M  ')).toBe('K4H7-QX2M');
  });

  it('does not choke on a code that happens to look URL-ish without being one', () => {
    expect(tokenFromInput('K4H7-QX2M')).toBe('K4H7-QX2M');
  });
});

describe('CheckinScreen — token resolution and persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState(null, '', '/');
    vi.mocked(request).mockReset();
  });

  afterEach(() => {
    vi.mocked(request).mockReset();
  });

  it('shows the token-entry screen with nothing in the URL or storage', () => {
    renderScreen();
    expect(screen.getByPlaceholderText(/K4H7-QX2M/)).toBeInTheDocument();
  });

  it('resolves the token from a stored value, surviving what a real app kill would lose', async () => {
    window.localStorage.setItem(STORED_TOKEN_KEY, 'STORED-TOKEN');
    vi.mocked(request).mockResolvedValue(somePreview);

    renderScreen();

    await waitFor(() => expect(screen.getByText('Load 42')).toBeInTheDocument());
    expect(vi.mocked(request)).toHaveBeenCalledWith('/v1/checkin/STORED-TOKEN');
  });

  it('prefers the URL path token over a stored one when both are present', async () => {
    window.localStorage.setItem(STORED_TOKEN_KEY, 'STALE-STORED-TOKEN');
    window.history.pushState(null, '', '/checkin/FRESH-PATH-TOKEN');
    vi.mocked(request).mockResolvedValue(somePreview);

    renderScreen();

    await waitFor(() =>
      expect(vi.mocked(request)).toHaveBeenCalledWith('/v1/checkin/FRESH-PATH-TOKEN'),
    );
  });

  it('persists a code entered by hand, and checks it against the real /v1 route', async () => {
    const user = userEvent.setup();
    vi.mocked(request).mockResolvedValue(somePreview);

    renderScreen();

    await user.type(screen.getByPlaceholderText(/K4H7-QX2M/), 'NEW-CODE');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByText('Load 42')).toBeInTheDocument());

    // The exact regression this app shipped once: calling /checkin/* instead
    // of /v1/checkin/*. Guarding the literal path, not just "was called".
    expect(vi.mocked(request)).toHaveBeenCalledWith('/v1/checkin/NEW-CODE');
    expect(window.localStorage.getItem(STORED_TOKEN_KEY)).toBe('NEW-CODE');
    expect(window.location.pathname).toBe('/checkin/NEW-CODE');
  });

  it('clears the stored token and returns to entry when the link does not work', async () => {
    window.localStorage.setItem(STORED_TOKEN_KEY, 'REVOKED-TOKEN');
    vi.mocked(request).mockRejectedValue(new Error('gone'));
    const user = userEvent.setup();

    renderScreen();

    await waitFor(() => expect(screen.getByText("This link isn't working")).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Try a different link or code' }));

    expect(screen.getByPlaceholderText(/K4H7-QX2M/)).toBeInTheDocument();
    expect(window.localStorage.getItem(STORED_TOKEN_KEY)).toBeNull();
    expect(window.location.pathname).toBe('/');
  });
});

describe('CheckinScreen — reporting a milestone', () => {
  beforeEach(() => {
    window.localStorage.setItem(STORED_TOKEN_KEY, 'A-TOKEN');
    vi.mocked(request).mockReset();
  });

  it('tapping a milestone posts it to the stop, by id, under /v1/checkin', async () => {
    vi.mocked(request).mockResolvedValue(previewWithOneStop);
    const user = userEvent.setup();

    renderScreen();
    await waitFor(() => expect(screen.getByText('Arrived')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Arrived' }));

    await waitFor(() =>
      expect(vi.mocked(request)).toHaveBeenCalledWith('/v1/checkin/A-TOKEN/stops/stop-1', {
        method: 'POST',
        body: { milestone: 'arrived' },
      }),
    );
  });

  it('offers to undo a milestone reported moments ago, and posts to the undo route', async () => {
    const justNow = new Date().toISOString();
    vi.mocked(request).mockResolvedValue({
      ...previewWithOneStop,
      stops: [{ ...previewWithOneStop.stops[0]!, arrivedAt: justNow }],
    });
    const user = userEvent.setup();

    renderScreen();
    const undoButton = await screen.findByRole('button', { name: /Undo/ });

    await user.click(undoButton);

    await waitFor(() =>
      expect(vi.mocked(request)).toHaveBeenCalledWith('/v1/checkin/A-TOKEN/stops/stop-1/undo', {
        method: 'POST',
        body: { milestone: 'arrived' },
      }),
    );
  });

  it('does not offer to undo a milestone reported outside the undo window', async () => {
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    vi.mocked(request).mockResolvedValue({
      ...previewWithOneStop,
      stops: [{ ...previewWithOneStop.stops[0]!, arrivedAt: longAgo }],
    });

    renderScreen();
    await screen.findByText('Arrived');

    expect(screen.queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument();
  });
});

describe('CheckinScreen — PositionControl', () => {
  beforeEach(() => {
    window.localStorage.setItem(STORED_TOKEN_KEY, 'A-TOKEN');
    vi.mocked(request).mockReset();
    vi.mocked(Geolocation.getCurrentPosition).mockReset();
  });

  it('sends the real fix to the position endpoint', async () => {
    vi.mocked(request).mockResolvedValue(somePreview);
    vi.mocked(Geolocation.getCurrentPosition).mockResolvedValue({
      coords: { latitude: 39.0997, longitude: -94.5786 },
    } as never);
    const user = userEvent.setup();

    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Send my location now' }));

    await waitFor(() =>
      expect(vi.mocked(request)).toHaveBeenCalledWith('/v1/checkin/A-TOKEN/position', {
        method: 'POST',
        body: { lat: 39.0997, lng: -94.5786 },
      }),
    );
    expect(await screen.findByText('Location sent.')).toBeInTheDocument();
  });

  it('shows an error rather than silently failing when the device refuses the fix', async () => {
    vi.mocked(request).mockResolvedValue(somePreview);
    vi.mocked(Geolocation.getCurrentPosition).mockRejectedValue(new Error('User denied Geolocation'));
    const user = userEvent.setup();

    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Send my location now' }));

    await waitFor(() => expect(screen.queryByText('Location sent.')).not.toBeInTheDocument());
    // The position endpoint must never be called on a failed fix — there is
    // nothing real to report.
    expect(vi.mocked(request)).not.toHaveBeenCalledWith(
      expect.stringContaining('/position'),
      expect.anything(),
    );
  });
});
