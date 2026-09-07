/**
 * CoordinateLookup's matching logic — when a HERE result is confident
 * enough to accept without asking, and when a dispatcher has to pick.
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

  it('auto-accepts a single clear match and calls onPick with it', async () => {
    vi.mocked(request).mockResolvedValue({
      candidates: [{ label: 'Wichita, KS, United States', lat: 37.6872, lng: -97.3301, score: 0.95 }],
    });
    const { onPick } = renderLookup();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Look up coordinates' }));

    await waitFor(() => expect(onPick).toHaveBeenCalledWith({
      label: 'Wichita, KS, United States',
      lat: 37.6872,
      lng: -97.3301,
      score: 0.95,
    }));
    expect(await screen.findByText('Wichita, KS, United States')).toBeInTheDocument();
    // No picker for a match this confident — nothing left for a dispatcher to choose.
    expect(screen.queryByText('Which one did you mean?')).not.toBeInTheDocument();
  });

  it('asks the dispatcher when two candidates are too close to call', async () => {
    vi.mocked(request).mockResolvedValue({
      candidates: [
        { label: 'Wichita, KS 67202, United States', lat: 37.6872, lng: -97.3301, score: 0.8 },
        { label: 'Wichita, KS 67203, United States', lat: 37.71, lng: -97.4, score: 0.75 },
      ],
    });
    const { onPick } = renderLookup();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Look up coordinates' }));

    await screen.findByText('Which one did you mean?');
    expect(screen.getByText('Wichita, KS 67202, United States')).toBeInTheDocument();
    expect(screen.getByText('Wichita, KS 67203, United States')).toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();

    await user.click(screen.getByText('Wichita, KS 67203, United States'));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Wichita, KS 67203, United States' }),
    );
  });

  it('asks the dispatcher when the only match is below the confidence bar', async () => {
    vi.mocked(request).mockResolvedValue({
      candidates: [{ label: 'A weak match', lat: 1, lng: 2, score: 0.4 }],
    });
    const { onPick } = renderLookup();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Look up coordinates' }));

    await screen.findByText('Which one did you mean?');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('shows nothing found rather than a picker with no options', async () => {
    vi.mocked(request).mockResolvedValue({ candidates: [] });
    renderLookup();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Look up coordinates' }));

    expect(await screen.findByText('No match found for that address.')).toBeInTheDocument();
    expect(screen.queryByText('Which one did you mean?')).not.toBeInTheDocument();
  });

  it('offers a re-lookup after an automatic match, for a dispatcher who disagrees with it', async () => {
    vi.mocked(request).mockResolvedValue({
      candidates: [{ label: 'Wichita, KS, United States', lat: 37.6872, lng: -97.3301, score: 0.95 }],
    });
    renderLookup();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Look up coordinates' }));
    await screen.findByText('Wichita, KS, United States');

    vi.mocked(request).mockClear();
    await user.click(screen.getByRole('button', { name: 'Not the right spot? Look up again' }));

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
