/**
 * Distance and ETA estimation — pure functions, no database, no gate.
 *
 * The claim worth checking is the one that actually broke something once
 * upstream: `estimatedRoadMiles` matches the dispatcher core's own reference
 * numbers, because it is a hand-copy of that file (see the module note) and
 * a copy that quietly drifts is worse than no copy at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimatedArrival, estimatedRoadMiles, haversineMiles } from './geo.ts';

describe('haversineMiles', () => {
  it('is zero for the same point', () => {
    assert.equal(haversineMiles({ lat: 37.6872, lng: -97.3301 }, { lat: 37.6872, lng: -97.3301 }), 0);
  });
});

describe('estimatedRoadMiles', () => {
  // Same reference points the dispatcher core's own file checks itself
  // against — see ai-load-dispatcher/packages/core/src/distance.ts.
  it('lands within DAT\'s reported miles for Augusta KS -> Oklahoma City OK', () => {
    const augusta = { lat: 37.6872, lng: -97.2189 };
    const oklahomaCity = { lat: 35.4676, lng: -97.5164 };
    const miles = estimatedRoadMiles(augusta, oklahomaCity);
    assert.ok(Math.abs(miles - 176) / 176 < 0.1, `${miles} is not within 10% of 176`);
  });
});

describe('estimatedArrival', () => {
  it('is now, for the same point', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    const point = { lat: 37.6872, lng: -97.3301 };
    const result = estimatedArrival(point, point, now);
    assert.equal(result.milesRemaining, 0);
    assert.equal(result.arrivalAt.getTime(), now.getTime());
  });

  it('estimates arrival at the assumed average speed', () => {
    const now = new Date('2026-01-01T12:00:00Z');
    // ~100 estimated road miles apart, at 50 mph, is 2 hours.
    const from = { lat: 37.6872, lng: -97.3301 };
    const to = { lat: 38.5, lng: -97.3301 };
    const result = estimatedArrival(from, to, now);
    const hours = (result.arrivalAt.getTime() - now.getTime()) / 3_600_000;
    assert.ok(Math.abs(hours - result.milesRemaining / 50) < 0.01);
  });
});
