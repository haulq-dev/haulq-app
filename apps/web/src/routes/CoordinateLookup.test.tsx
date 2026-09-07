/**
 * CoordinateLookup's matching logic — coordinates fill in the moment a
 * lookup resolves, confident or not; alternates are a correction sitting
 * underneath an already-filled answer, never a gate in front of it.
 *
 * Automatic firing itself (the debounced effect) is exercised in exactly
 * one test, with fake timers — everything else drives the same
 * `lookup.mutate()` path through the always-present manual button instead,
 * the same choice `Checkin.test.tsx` already made for `PositionControl`'s
 * own timer-driven behavior in the driver app: real branching logic is
 * worth pinning precisely, a `setTimeout`'s exact firing is not worth the
 * flakiness of testing directly everywhere it matters.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../lib/api.ts';
import { CoordinateLookup } from './Loads.tsx';

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/api.ts')>('../lib/api.ts');
  return { ...actual, request: vi.fn() };
});

const wichita = { city: 'Wichita', state: 'KS' };
const LOOKUP_BUTTON = { name: 'Fill in coordinates from this address' };

function renderLookup(props: Partial<Parameters<typeof CoordinateLookup>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPick = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CoordinateLookup address={wichita} hasCoordinates={false} onPick={onPick} {...props} />
    </QueryClientProvider>,
  );
  return { onPick };
}

describe('CoordinateLookup — confidence branching', () => {
  beforeEach(() => {
    vi.mocked(request).mockReset();
  });

  it('fills in a single clear match and shows no alternates', async () => {
    vi.mocked(request).mockResolvedValue({
      candidates: [{ label: 'Wichita, KS, United States', lat: 37.6872, lng: -97.3301, score: 0.95 }],
    });
    const { onPick } = renderLookup();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', LOOKUP_BUTTON));

    await waitFor(() => expect(onPick).toHaveBeenCalledWith({
      label: 'Wichita, KS, United States',
      lat: 37.6872,
      lng: -97.3301,
      score: 0.95,
    }));
    expect(await screen.findByText('Wichita, KS, United States')).toBeInTheDocument();
    expect(screen.getByText(/Coordinates filled in automatically/)).toBeInTheDocument();
    // Nothing to compare a single confident match against.
    expect(screen.queryByText(/if it's wrong/)).not.toBeInTheDocument();
  });

  it('fills in the top guess immediately even when a second candidate is close, and offers it as a fix', async () => {
    vi.mocked(request).mockResolvedValue({
      candidates: [
        { label: 'Wichita, KS 67202, United States', lat: 37.6872, lng: -97.3301, score: 0.8 },
        { label: 'Wichita, KS 67203, United States', lat: 37.71, lng: -97.4, score: 0.75 },
      ],
    });
    const { onPick } = renderLookup();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', LOOKUP_BUTTON));

    // Filled in immediately with the top guess, no click required.
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Wichita, KS 67202, United States' }),
    ));
    await screen.findByText(/Coordinates filled in automatically/);

    // The runner-up is offered as a correction, not the one already applied.
    expect(screen.getByText(/if it's wrong/)).toBeInTheDocument();
    expect(screen.queryByText('Use Wichita, KS 67202, United States instead')).not.toBeInTheDocument();
    const alternate = screen.getByText('Use Wichita, KS 67203, United States instead');

    onPick.mockClear();
    await user.click(alternate);
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Wichita, KS 67203, United States' }),
    );
  });

  it('fills in a weak single match with no alternates to offer instead', async () => {
    vi.mocked(request).mockResolvedValue({
      candidates: [{ label: 'A weak match', lat: 1, lng: 2, score: 0.4 }],
    });
    const { onPick } = renderLookup();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', LOOKUP_BUTTON));

    await waitFor(() => expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'A weak match' }),
    ));
    // Still filled in — there is no alternative to weigh it against — but
    // the escape hatch to search again is what a dispatcher actually needs here.
    expect(screen.queryByText(/if it's wrong/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not the right spot? Search again' })).toBeInTheDocument();
  });

  it('leaves coordinates for manual entry when HERE has no match at all', async () => {
    vi.mocked(request).mockResolvedValue({ candidates: [] });
    const { onPick } = renderLookup();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', LOOKUP_BUTTON));

    expect(await screen.findByText(/No address matched that/)).toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('searching again re-runs the lookup', async () => {
    vi.mocked(request).mockResolvedValue({
      candidates: [{ label: 'Wichita, KS, United States', lat: 37.6872, lng: -97.3301, score: 0.95 }],
    });
    renderLookup();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', LOOKUP_BUTTON));
    await screen.findByText('Wichita, KS, United States');

    vi.mocked(request).mockClear();
    await user.click(screen.getByRole('button', { name: 'Not the right spot? Search again' }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  });
});

describe('CoordinateLookup — automatic firing', () => {
  beforeEach(() => {
    vi.mocked(request).mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs on its own, after a pause, with no click at all', async () => {
    vi.mocked(request).mockResolvedValue({
      candidates: [{ label: 'Wichita, KS, United States', lat: 37.6872, lng: -97.3301, score: 0.95 }],
    });
    const { onPick } = renderLookup();

    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);

    await vi.waitFor(() => expect(onPick).toHaveBeenCalled());
  });

  it('never fires once coordinates already exist', async () => {
    vi.mocked(request).mockResolvedValue({ candidates: [] });
    renderLookup({ hasCoordinates: true });

    await vi.advanceTimersByTimeAsync(2000);

    expect(request).not.toHaveBeenCalled();
  });
});
