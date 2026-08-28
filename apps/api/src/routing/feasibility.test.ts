/**
 * `evaluateLoadFeasibility` — the pure verdict, no network and no database.
 *
 * PHASE_3_PLAN.md section 4's 3a exit gate has three claims worth a test
 * each: infeasible when HERE could not route around a restriction, infeasible
 * when the arrival estimate misses the delivery window, and — the one this
 * plan is explicit could go wrong silently — `hoursChecked` is always
 * `false`, because section 7 has not decided whether Phase 3 pulls HOS data.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Route } from '../integrations/routing-provider.ts';
import { evaluateLoadFeasibility } from './feasibility.ts';

function aRoute(overrides: Partial<Route> = {}): Route {
  return { miles: 120, durationSeconds: 3 * 3600, arrivalAt: new Date('2026-09-01T15:00:00Z'), raw: null, ...overrides };
}

describe('evaluateLoadFeasibility', () => {
  it('is feasible with no restrictions and arrival inside every stop window', () => {
    const verdict = evaluateLoadFeasibility(aRoute(), [], [
      { seq: 1, windowEnd: null },
      { seq: 2, windowEnd: new Date('2026-09-01T18:00:00Z') },
    ]);

    assert.equal(verdict.feasible, true);
    assert.equal(verdict.decidingConstraint, null);
    assert.equal(verdict.hoursChecked, false);
  });

  it('is infeasible on a HERE restriction, named, before the window is even checked', () => {
    const verdict = evaluateLoadFeasibility(
      aRoute(),
      [{ code: 'violatedBlockedRoad', description: 'Route uses a road restricted for this vehicle' }],
      [{ seq: 2, windowEnd: new Date('2026-09-01T10:00:00Z') }], // window already blown too — restriction still wins
    );

    assert.equal(verdict.feasible, false);
    assert.equal(verdict.decidingConstraint?.code, 'violatedBlockedRoad');
  });

  it('is infeasible when the estimated arrival is after the delivery window closes', () => {
    const verdict = evaluateLoadFeasibility(aRoute({ arrivalAt: new Date('2026-09-01T19:00:00Z') }), [], [
      { seq: 1, windowEnd: null },
      { seq: 2, windowEnd: new Date('2026-09-01T18:00:00Z') },
    ]);

    assert.equal(verdict.feasible, false);
    assert.equal(verdict.decidingConstraint?.code, 'stop_window_overrun');
    assert.match(verdict.decidingConstraint!.message, /stop 2/);
  });

  it('is feasible when arrival is before the window closes, even if it started before the window opened', () => {
    const verdict = evaluateLoadFeasibility(aRoute({ arrivalAt: new Date('2026-09-01T15:00:00Z') }), [], [
      { seq: 1, windowEnd: new Date('2026-09-01T18:00:00Z') },
    ]);
    assert.equal(verdict.feasible, true);
  });

  it('ignores a stop with no window rather than treating it as always feasible or always blown', () => {
    const verdict = evaluateLoadFeasibility(aRoute({ arrivalAt: new Date('2026-09-01T23:00:00Z') }), [], [
      { seq: 1, windowEnd: null },
      { seq: 2, windowEnd: null },
    ]);
    assert.equal(verdict.feasible, true);
    assert.equal(verdict.decidingConstraint, null);
  });

  it('always reports hoursChecked: false — Phase 3 has not decided whether to pull HOS data yet', () => {
    const verdict = evaluateLoadFeasibility(aRoute(), [], []);
    assert.equal(verdict.hoursChecked, false);
  });
});
