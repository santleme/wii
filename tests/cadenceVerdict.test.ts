import { describe, expect, it } from 'vitest';
import { CadenceTracker, type CadenceResult, type CadenceVerdict } from '../src/kinematics/cadenceTracker';
import type { TorsoVerticalSample } from '../src/kinematics/torsoVertical';
import { cadenceHarness } from './fixtures/torsoHarness';
import { poseWithHipBounce } from './fixtures/syntheticPose';

/**
 * The verdict names what the body is doing on each frame, derived in one place from the
 * tracker's evidence. These tests walk a player through the state's whole lifecycle and
 * assert the verdict at every step — including the stretch where the verdict and the
 * `running` trust flag honestly disagree: the trust bridges a stride gap after the body
 * has already stopped, so the frame reads `bridging` with `running` still true.
 */
const bounce = (t: number) => 0.016 * Math.sin((2 * Math.PI * 2.5 * t) / 1000);
const sway = (t: number) => 0.05 * Math.cos((2 * Math.PI * 2.5 * t) / 1000);

function transitions(results: readonly CadenceResult[]): CadenceVerdict[] {
  const sequence: CadenceVerdict[] = [];
  for (const result of results) {
    if (sequence.at(-1) !== result.verdict) sequence.push(result.verdict);
  }
  return sequence;
}

describe('cadence verdict', () => {
  it('walks idle → warming → running → bridging → idle across a run and a stop', () => {
    const { feed } = cadenceHarness();
    const results: CadenceResult[] = [];
    for (let t = 0; t <= 3960; t += 33) results.push(feed(poseWithHipBounce(t, bounce(t), undefined, sway(t))));
    const stopAt = results.length;
    for (let t = 3993; t <= 9960; t += 33) results.push(feed(poseWithHipBounce(t, 0, undefined, 0)));

    expect(transitions(results)).toEqual(['idle', 'warming', 'running', 'bridging', 'idle']);

    // Warming is the trust being earned: the bounce reads moving well before the gate opens.
    const firstWarming = results.findIndex((r) => r.verdict === 'warming');
    const firstRunning = results.findIndex((r) => r.verdict === 'running');
    expect(firstWarming).toBeGreaterThanOrEqual(0);
    expect(firstWarming).toBeLessThan(firstRunning);
    expect(results[firstRunning]!.running).toBe(true);

    // Bridging is the divergence the verdict exists to name: after the stop the body is
    // still and the speed is zero, yet the trust flag is still open.
    const bridged = results.slice(stopAt).filter((r) => r.verdict === 'bridging');
    expect(bridged.length).toBeGreaterThan(0);
    expect(bridged.every((r) => r.running && r.speed01 === 0)).toBe(true);
    expect(results.at(-1)).toMatchObject({ verdict: 'idle', running: false });
  });

  it('keeps the verdict and the trust flag consistent at every frame', () => {
    const { feed } = cadenceHarness();
    const results: CadenceResult[] = [];
    for (let t = 0; t <= 3960; t += 33) results.push(feed(poseWithHipBounce(t, bounce(t), undefined, sway(t))));
    for (let t = 3993; t <= 9960; t += 33) results.push(feed(poseWithHipBounce(t, 0, undefined, 0)));

    for (const result of results) {
      // Earned states require the trust; untrusted states forbid it. Walking is the one
      // state the trust can overlap, because a held gate outlives the bounce that earned it.
      if (result.verdict === 'running' || result.verdict === 'bridging') expect(result.running).toBe(true);
      if (result.verdict === 'warming' || result.verdict === 'idle') expect(result.running).toBe(false);
    }
  });

  it('reads weight-shift marching as walking, never warming or running', () => {
    // Direct samples: a flat torso whose weight sways foot to foot — the walk detector's
    // whole case. The bounce channel stays silent, so the trust never opens.
    const tracker = new CadenceTracker();
    const sample = (t: number, x: number): TorsoVerticalSample => ({
      timestampMs: t,
      shoulders: { left: 0.4, right: 0.4, width: 0.3, head: 0.3, x, leftWrist: 0.6, rightWrist: 0.6 },
    });
    const results: CadenceResult[] = [];
    for (let t = 0; t <= 12000; t += 33) {
      const x = t <= 6000 ? 0.5 + 0.045 * Math.sin((2 * Math.PI * 1.4 * t) / 1000) : 0.5;
      results.push(tracker.update(sample(t, x), t));
    }

    expect(transitions(results)).toEqual(['idle', 'walking', 'idle']);
    const walking = results.filter((r) => r.verdict === 'walking');
    expect(walking.length).toBeGreaterThan(0);
    expect(walking.every((r) => !r.running && r.speed01 > 0)).toBe(true);
    expect(walking.every((r) => r.cadenceSpm >= 70 && r.cadenceSpm <= 130)).toBe(true);
  });

  it('never leaves idle for arrhythmic flicker — bursts too short to read as moving', () => {
    // Violent arm swinging bounces the torso in short irregular bursts: the rises never
    // chain into strides and the weight never transfers, so the verdict does not even
    // warm — warming is reserved for motion the bounce channel actually confirms.
    const { feed } = cadenceHarness();
    const flicker = (t: number) => (t % 1900 < 500 ? bounce(t) : 0);
    const results = Array.from({ length: 120 }, (_, i) => i * 33)
      .map((t) => feed(poseWithHipBounce(t, flicker(t), undefined, 0)));

    expect(results.every((r) => r.verdict === 'idle')).toBe(true);
    expect(results.every((r) => !r.running)).toBe(true);
  });
});
