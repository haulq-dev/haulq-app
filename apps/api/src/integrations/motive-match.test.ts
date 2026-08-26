import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { suggestMotiveMatches } from './motive-match.ts';

describe('suggestMotiveMatches', () => {
  it('matches on normalized equality — "Unit 12" against "unit-12"', () => {
    const result = suggestMotiveMatches(
      [{ id: 't1', label: 'Unit 12', motiveVehicleId: null }],
      [{ id: 501, number: 'unit-12' }],
    );
    assert.deepEqual(result, [
      { truckId: 't1', truckLabel: 'Unit 12', motiveVehicleId: 501, motiveVehicleNumber: 'unit-12' },
    ]);
  });

  it('falls back to bare digits — "Unit 12" against "12"', () => {
    const result = suggestMotiveMatches(
      [{ id: 't1', label: 'Unit 12', motiveVehicleId: null }],
      [{ id: 501, number: '12' }],
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.motiveVehicleId, 501);
  });

  it('strips leading zeros when comparing digits — "Truck 007" against "7"', () => {
    const result = suggestMotiveMatches(
      [{ id: 't1', label: 'Truck 007', motiveVehicleId: null }],
      [{ id: 501, number: '7' }],
    );
    assert.equal(result.length, 1);
  });

  it('prefers an exact normalized match over a digits-only match when both exist', () => {
    const result = suggestMotiveMatches(
      [{ id: 't1', label: 'Unit 12', motiveVehicleId: null }],
      [
        { id: 999, number: '12' }, // digits-only candidate, listed first
        { id: 501, number: 'Unit 12' }, // exact candidate
      ],
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.motiveVehicleId, 501);
  });

  it('never touches a truck that already has a match', () => {
    const result = suggestMotiveMatches(
      [{ id: 't1', label: 'Unit 12', motiveVehicleId: 501 }],
      [{ id: 501, number: 'Unit 12' }],
    );
    assert.deepEqual(result, []);
  });

  it('never suggests a vehicle another truck is already matched to', () => {
    const result = suggestMotiveMatches(
      [
        { id: 't1', label: 'Unit 12', motiveVehicleId: 501 },
        { id: 't2', label: 'Truck 12', motiveVehicleId: null },
      ],
      [{ id: 501, number: '12' }],
    );
    assert.deepEqual(result, []);
  });

  it('gives one vehicle to only the first truck when two trucks could both plausibly match it', () => {
    const result = suggestMotiveMatches(
      [
        { id: 't1', label: 'Unit 12', motiveVehicleId: null },
        { id: 't2', label: 'Truck 12', motiveVehicleId: null },
      ],
      [{ id: 501, number: '12' }],
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.truckId, 't1');
  });

  it('suggests nothing for a truck with no plausible vehicle', () => {
    const result = suggestMotiveMatches(
      [{ id: 't1', label: 'The white box', motiveVehicleId: null }],
      [{ id: 501, number: '12' }],
    );
    assert.deepEqual(result, []);
  });

  it('suggests nothing when there are no vehicles at all', () => {
    const result = suggestMotiveMatches([{ id: 't1', label: 'Unit 12', motiveVehicleId: null }], []);
    assert.deepEqual(result, []);
  });

  it('handles several trucks and vehicles together, matching what can be matched', () => {
    const result = suggestMotiveMatches(
      [
        { id: 't1', label: 'Unit 12', motiveVehicleId: null },
        { id: 't2', label: 'Unit 14', motiveVehicleId: 900 }, // already matched
        { id: 't3', label: 'The white box', motiveVehicleId: null }, // no plausible match
      ],
      [
        { id: 501, number: '12' },
        { id: 502, number: '14' },
      ],
    );
    assert.deepEqual(result, [
      { truckId: 't1', truckLabel: 'Unit 12', motiveVehicleId: 501, motiveVehicleNumber: '12' },
    ]);
  });
});
