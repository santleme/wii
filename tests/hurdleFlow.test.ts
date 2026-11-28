import { describe, expect, it } from 'vitest';
import { HurdleFlow, type HurdleBody, MAX_SPAWN_DISTANCE, MIN_SPAWN_DISTANCE, RAMP_DISTANCE, RUNNER_Z, spawnSpacing } from '../src/games/track/hurdleFlow';

const hurdle = (lane: number, z: number): HurdleBody => ({ kind: 'hurdle', lane, z, passed: false });

describe('hurdle flow', () => {
  it('judges a hurdle only when it crosses the runner plane, exactly once', () => {
    const flow = new HurdleFlow();
    const hurdles = [hurdle(0, -2)];
    // Braking leaves the hurdle short of the runner: not judged yet.
    expect(flow.advance(hurdles, 2, 0, false).judged).toHaveLength(0);
    expect(hurdles[0]!.z).toBe(0);
    // On resume it is judged at the contact plane and never again.
    const resumed = flow.advance(hurdles, RUNNER_Z + 0.5, 0, false);
    expect(resumed.judged).toEqual([{ hurdle: hurdles[0], outcome: 'hit' }]);
    expect(flow.advance(hurdles, 1, 0, false).judged).toHaveLength(0);
  });

  it('clears by jumping, dodges by lane and hits otherwise', () => {
    const flow = new HurdleFlow();
    const jumping = [hurdle(0, RUNNER_Z - 0.5)];
    expect(flow.advance(jumping, 1, 0, true).judged[0]!.outcome).toBe('cleared');
    const dodged = [hurdle(1, RUNNER_Z - 0.5)];
    expect(flow.advance(dodged, 1, 0, false).judged[0]!.outcome).toBe('dodged');
    // Jumping in an empty lane is still only a dodge.
    expect(flow.advance([hurdle(1, RUNNER_Z - 0.5)], 1, 0, true).judged[0]!.outcome).toBe('dodged');
    const hit = [hurdle(-1, RUNNER_Z - 0.5)];
    expect(flow.advance(hit, 1, -1, false).judged[0]!.outcome).toBe('hit');
  });

  it('spawns on travelled distance: a pause adds nothing and progress survives it', () => {
    const flow = new HurdleFlow();
    expect(flow.advance([], 20, 0, false).spawn).toBe(false);
    for (let i = 0; i < 60; i += 1) expect(flow.advance([], 0, 0, false).spawn).toBe(false);
    expect(flow.advance([], 7, 0, false).spawn).toBe(true);
    expect(flow.advance([], 26, 0, false).spawn).toBe(false);
    expect(flow.advance([], 0.5, 0, false).spawn).toBe(true);
  });

  it('tightens the spacing with distance, down to a floor', () => {
    const spacings = [0, RAMP_DISTANCE / 4, RAMP_DISTANCE / 2, RAMP_DISTANCE].map(spawnSpacing);
    expect(spacings[0]).toBe(MAX_SPAWN_DISTANCE);
    expect(spacings).toEqual([...spacings].sort((a, b) => b - a));
    expect(new Set(spacings).size).toBe(spacings.length);
    expect(spawnSpacing(RAMP_DISTANCE * 10)).toBe(MIN_SPAWN_DISTANCE);
  });

  it('spawns sooner once the run is long', () => {
    expect(new HurdleFlow().advance([], MIN_SPAWN_DISTANCE + 1, 0, false, 0).spawn).toBe(false);
    expect(new HurdleFlow().advance([], MIN_SPAWN_DISTANCE + 1, 0, false, RAMP_DISTANCE).spawn).toBe(true);
  });

  it('collects a coin by lane, jumping or not, and misses it from another lane', () => {
    const coin = (lane: number): HurdleBody => ({ kind: 'coin', lane, z: RUNNER_Z - 0.5, passed: false });
    const outcome = (lane: number, airborne: boolean) => new HurdleFlow().advance([coin(lane)], 1, 0, airborne).judged[0]!.outcome;
    expect(outcome(0, false)).toBe('collected');
    expect(outcome(0, true)).toBe('collected');
    expect(outcome(1, false)).toBe('missed');
    expect(outcome(1, true)).toBe('missed');
  });

  it('stretches the spacing when the world is boosted', () => {
    expect(new HurdleFlow().advance([], MAX_SPAWN_DISTANCE + 1, 0, false, 0, 1.5).spawn).toBe(false);
    expect(new HurdleFlow().advance([], MAX_SPAWN_DISTANCE * 1.5 + 1, 0, false, 0, 1.5).spawn).toBe(true);
  });

  it('recycles hurdles once they are well behind the runner', () => {
    const flow = new HurdleFlow();
    const behind = hurdle(0, 7.9);
    const ahead = hurdle(0, -5);
    const { despawned } = flow.advance([behind, ahead], 0.5, 0, false);
    expect(despawned).toEqual([behind]);
  });
});
