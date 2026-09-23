import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatMinutes,
  isClearGeocodeWinner,
  laneEnds,
  prettyStatus,
  ratePerMile,
  relativeAge,
  toDatetimeLocal,
  type Stop,
} from './loads.ts';

function stop(seq: number, type: Stop['type'], city: string): Stop {
  return {
    id: `s${seq}`, seq, type, city, state: 'MO', facilityName: null, addressLine1: null,
    postalCode: null, lat: null, lng: null, windowStart: null, windowEnd: null,
  };
}

describe('ratePerMile', () => {
  it('counts deadhead in the headline figure', () => {
    const r = ratePerMile({ rateAmount: 40_000, expectedLoadedMiles: 127, expectedDeadheadMiles: 176 });
    assert.equal(Math.round(r!.total), 132);
    assert.equal(Math.round(r!.loaded), 315);
  });

  it('refuses to guess when deadhead or miles are unknown', () => {
    assert.equal(ratePerMile({ rateAmount: 40_000, expectedLoadedMiles: 127, expectedDeadheadMiles: null }), null);
    assert.equal(ratePerMile({ rateAmount: 40_000, expectedLoadedMiles: null, expectedDeadheadMiles: 10 }), null);
    assert.equal(ratePerMile({ rateAmount: null, expectedLoadedMiles: 100, expectedDeadheadMiles: 10 }), null);
  });
});

describe('laneEnds', () => {
  it('is the first pickup and the last delivery', () => {
    const { pickup, delivery } = laneEnds([
      stop(1, 'pickup', 'A'), stop(2, 'pickup', 'B'), stop(3, 'delivery', 'C'), stop(4, 'delivery', 'D'),
    ]);
    assert.equal(pickup?.city, 'A');
    assert.equal(delivery?.city, 'D');
  });
});

describe('formatting', () => {
  it('prettifies statuses', () => assert.equal(prettyStatus('in_transit'), 'in transit'));

  it('formats minutes', () => {
    assert.equal(formatMinutes(45), '45m');
    assert.equal(formatMinutes(135), '2h 15m');
  });

  it('describes age coarsely', () => {
    const now = Date.parse('2026-09-23T12:00:00Z');
    assert.equal(relativeAge('2026-09-23T11:59:40Z', now), 'just now');
    assert.equal(relativeAge('2026-09-23T11:15:00Z', now), '45 min ago');
    assert.equal(relativeAge('2026-09-23T09:00:00Z', now), '3 hrs ago');
    assert.equal(relativeAge('2026-09-21T12:00:00Z', now), '2 days ago');
  });

  it('round-trips a datetime-local value', () => {
    const local = toDatetimeLocal('2026-09-23T18:30:00Z');
    assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    assert.equal(new Date(local).toISOString(), '2026-09-23T18:30:00.000Z');
    assert.equal(toDatetimeLocal(null), '');
  });
});

describe('isClearGeocodeWinner', () => {
  const c = (score: number) => ({ label: String(score), lat: 0, lng: 0, score });
  it('needs a high score and a clear margin', () => {
    assert.equal(isClearGeocodeWinner([c(0.9)]), true);
    assert.equal(isClearGeocodeWinner([c(0.9), c(0.6)]), true);
    assert.equal(isClearGeocodeWinner([c(0.9), c(0.85)]), false);
    assert.equal(isClearGeocodeWinner([c(0.5)]), false);
    assert.equal(isClearGeocodeWinner([]), false);
  });
});
