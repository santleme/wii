import { describe, expect, it } from 'vitest';
import type { PoseSnapshot } from '../src/cv/protocol';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { calibration, pose } from './fixtures/syntheticPose';

/** Deterministic pseudo-gaussian noise so failures reproduce. */
function rng(seed: number) {
  let state = seed;
  const uniform = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return () => (uniform() + uniform() + uniform() + uniform() - 2) / 0.58; // ~N(0,1)
}

/** Per-landmark independent image jitter, in normalized units — typical webcam MediaPipe noise. */
function noisy(snapshot: PoseSnapshot, noise: () => number, sigma: number, overrides: Record<number, { dx?: number; dy?: number }> = {}): PoseSnapshot {
  return {
    ...snapshot,
    landmarks: snapshot.landmarks.map((point, index) => ({
      ...point,
      x: point.x + noise() * sigma + (overrides[index]?.dx ?? 0),
      y: point.y + noise() * sigma + (overrides[index]?.dy ?? 0),
      visibility: Math.min(1, Math.max(0, 0.9 + noise() * 0.12)),
      presence: 0.95,
    })),
  };
}

function run(scenario: (timeMs: number, noise: () => number) => PoseSnapshot, seconds = 30, seed = 7) {
  const seeds = [seed, seed + 4, seed + 16, 5, 13, 29];
  const total = { types: {} as Record<string, number>, maxSpeed: 0 };
  for (const each of seeds) {
    const one = runOnce(scenario, seconds, each);
    for (const [type, count] of Object.entries(one.types)) total.types[type] = (total.types[type] ?? 0) + count;
    total.maxSpeed = Math.max(total.maxSpeed, one.maxSpeed);
  }
  return total;
}

function runOnce(scenario: (timeMs: number, noise: () => number) => PoseSnapshot, seconds: number, seed: number) {
  const pipeline = new ActionPipeline();
  const profile = calibration();
  const noise = rng(seed);
  const types: Record<string, number> = {};
  let maxSpeed = 0;
  for (let timeMs = 0; timeMs <= seconds * 1000; timeMs += 33) {
    const result = pipeline.update(scenario(timeMs, noise), profile);
    maxSpeed = Math.max(maxSpeed, result.controls.sprintSpeed01);
    for (const event of result.events) {
      if (event.type === 'sprint' && event.speed01 === 0) continue;
      types[event.type] = (types[event.type] ?? 0) + 1;
    }
  }
  return { types, maxSpeed };
}

describe('standing still must never produce actions (regression: phantom jump/run/walk)', () => {
  it.each([0.004, 0.008, 0.012])('ignores independent landmark jitter, sigma %f', (sigma) => {
    const { types, maxSpeed } = run((t, noise) => noisy(pose(t), noise, sigma));
    expect(types).toEqual({});
    expect(maxSpeed).toBe(0);
  });

  it('ignores slow breathing and weight shifting', () => {
    const { types, maxSpeed } = run((t, noise) => noisy(
      pose(t, { hipRise: 0.02 * Math.sin((2 * Math.PI * 0.3 * t) / 1000), shiftUserRightSw: 0.15 * Math.sin((2 * Math.PI * 0.2 * t) / 1000) }),
      noise, 0.006,
    ));
    expect(types).toEqual({});
    expect(maxSpeed).toBe(0);
  });

  it('ignores arm waving and head nodding while the feet stay planted', () => {
    const { types, maxSpeed } = run((t, noise) => {
      const wave = 0.06 * Math.sin((2 * Math.PI * 2.2 * t) / 1000);
      return noisy(pose(t), noise, 0.006, {
        13: { dy: wave }, 14: { dy: -wave }, 15: { dy: wave * 1.5 }, 16: { dy: -wave * 1.5 },
      });
    });
    expect(types).toEqual({});
    expect(maxSpeed).toBe(0);
  });

  it('ignores hips hidden by the bottom edge of the frame while standing', () => {
    const { types, maxSpeed } = run((t, noise) => {
      const base = noisy(pose(t), noise, 0.008);
      return { ...base, landmarks: base.landmarks.map((p, i) => (i >= 23 ? { ...p, visibility: 0.15 } : p)) };
    });
    expect(types).toEqual({});
    expect(maxSpeed).toBe(0);
  });

  it('ignores knee noise alone (the limb-drive channel must not fire on jitter)', () => {
    const { types, maxSpeed } = run((t, noise) => noisy(pose(t), noise, 0.003, {
      25: { dy: noise() * 0.012 }, 26: { dy: noise() * 0.012 },
    }));
    expect(types).toEqual({});
    expect(maxSpeed).toBe(0);
  });
});

/** Seconds from the first real bounce until the game sees movement; Infinity if it never does. */
function startLatencyMs(spm: number, amplitude: number, sigma: number, hipsHidden: boolean, seed = 7): number {
  const pipeline = new ActionPipeline();
  const profile = calibration();
  const noise = rng(seed);
  const startAt = 2000;
  for (let t = 0; t <= 12000; t += 33) {
    const units = t >= startAt ? amplitude * Math.sin((2 * Math.PI * (spm / 60) * (t - startAt)) / 1000) : 0;
    const base = noisy(pose(t, { hipRise: units }), noise, sigma);
    const frame = hipsHidden ? { ...base, landmarks: base.landmarks.map((p, i) => (i >= 23 ? { ...p, visibility: 0.15 } : p)) } : base;
    if (pipeline.update(frame, profile).controls.sprintSpeed01 > 0) return t - startAt;
  }
  return Number.POSITIVE_INFINITY;
}

describe('real running must still be detected, quickly, under the same noise', () => {
  it.each([
    // Budgets are the measured start latency plus margin, under deliberately harsh jitter
    // (sigma 0.006-0.008 of the frame, ~4-5 px). Cleaner cameras start sooner. Rhythm confirmation
    // is what keeps a motionless player from running, and it needs a couple of strides of evidence.
    ['running 165 spm', 165, 0.05, 0.008, false, 3500],
    ['running 165 spm, hips hidden', 165, 0.05, 0.008, true, 3500],
    ['jogging in place 140 spm', 140, 0.035, 0.008, false, 5500],
    ['walking in place 100 spm, small bounce', 100, 0.025, 0.006, false, 10000],
  ] as const)('%s', (_name, spm, amplitude, sigma, hipsHidden, budgetMs) => {
    for (const seed of [7, 11, 23]) {
      const latency = startLatencyMs(spm, amplitude, sigma, hipsHidden, seed);
      expect(latency).toBeLessThan(budgetMs);
    }
  });
});
