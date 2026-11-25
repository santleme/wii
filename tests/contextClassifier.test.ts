import { describe, expect, it } from 'vitest';
import type { Point3, PoseSnapshot } from '../src/cv/protocol';
import { BodyFeatureExtractor } from '../src/kinematics/bodyFeatures';
import { ContextClassifier } from '../src/kinematics/contextClassifier';
import { pose, rotateWorldYaw } from './fixtures/syntheticPose';

const FRAME_MS = 1000 / 30;
const T0 = 10_000;

function setWorlds(snapshot: PoseSnapshot, edits: readonly (readonly [number, Partial<Point3>])[]): PoseSnapshot {
  const byIndex = new Map(edits);
  return {
    ...snapshot,
    worldLandmarks: snapshot.worldLandmarks.map((point, index) =>
      byIndex.has(index) ? { ...point, ...byIndex.get(index) } : point,
    ),
  };
}

/** Static body with only sub-threshold jitter; world wrists stay fixed. */
function idleFrames(count: number, startMs = 0): PoseSnapshot[] {
  return Array.from({ length: count }, (_, i) => pose(T0 + startMs + i * FRAME_MS));
}

/**
 * Alternating knee lifts on a 500 ms leg cycle (≈240 steps/min) plus a small hip bounce.
 * The world knees are edited directly because the fixture's knee options only move image landmarks.
 */
function runningFrames(count: number, startMs = 0): PoseSnapshot[] {
  return Array.from({ length: count }, (_, i) => {
    const t = T0 + startMs + i * FRAME_MS;
    const phase = (i * FRAME_MS) / 500;
    const liftLeft = Math.max(0, Math.sin(2 * Math.PI * phase));
    const liftRight = Math.max(0, Math.sin(2 * Math.PI * phase + Math.PI));
    const bounce = Math.abs(Math.sin(4 * Math.PI * phase)) * 0.04;
    return setWorlds(pose(t), [
      [25, { y: 0.45 - liftLeft * 0.2 }],
      [26, { y: 0.45 - liftRight * 0.2 }],
      [23, { y: -bounce }],
      [24, { y: -bounce }],
    ]);
  });
}

/** Both wrists sweep laterally on a 600 ms arc (~6 shoulder-widths/s at the peak). */
function swingingFrames(count: number, startMs = 0): PoseSnapshot[] {
  return Array.from({ length: count }, (_, i) =>
    pose(T0 + startMs + i * FRAME_MS, { wristLateral: 0.25 * Math.sin((2 * Math.PI * i * FRAME_MS) / 600) }),
  );
}

/** Guard up (both fists above the shoulder line) with alternating forward punches every ~500 ms. */
function strikingFrames(count: number, startMs = 0): PoseSnapshot[] {
  return Array.from({ length: count }, (_, i) => {
    const cycle = (i * FRAME_MS) % 500;
    const punchLeft = cycle < 150 ? Math.sin((Math.PI * cycle) / 150) : 0;
    const punchRight = cycle >= 250 && cycle < 400 ? Math.sin((Math.PI * (cycle - 250)) / 150) : 0;
    return setWorlds(pose(T0 + startMs + i * FRAME_MS), [
      [15, { y: -0.6, z: punchLeft * 0.2 }],
      [16, { y: -0.6, z: punchRight * 0.2 }],
    ]);
  });
}

function lostFrames(count: number, startMs = 0): PoseSnapshot[] {
  return idleFrames(count, startMs).map((snapshot) => ({ ...snapshot, trackingState: 'lost' as const }));
}

function feed(classifier: ContextClassifier, frames: readonly PoseSnapshot[]) {
  let decision = classifier.update(frames[0]!);
  for (const snapshot of frames.slice(1)) decision = classifier.update(snapshot);
  return decision;
}

describe('BodyFeatureExtractor', () => {
  it('normalizes landmarks into a shoulder-width body frame without calibration', () => {
    const features = new BodyFeatureExtractor().extract(pose(0))!;
    // world wrist 16 at (-0.2, 0.1): x = 0.5 shoulder widths to the player's right, y = -0.25 down the up-axis.
    expect(features.landmarksLocal[16]!.x).toBeCloseTo(0.5, 5);
    expect(features.landmarksLocal[16]!.y).toBeCloseTo(-0.25, 5);
    expect(features.landmarksLocal).toHaveLength(33);
    expect(features.kneeLiftLeft).toBeCloseTo(-1.125, 3);
  });

  it('reports zero velocity on the first frame and converges to wrist speed in continuous motion', () => {
    const extractor = new BodyFeatureExtractor();
    const first = extractor.extract(pose(0))!;
    expect(first.landmarkVelocities[16]).toEqual({ x: 0, y: 0, z: 0 });
    expect(first.wristVelocityRight).toEqual({ x: 0, y: 0, z: 0 });
    // Steady lateral sweep at 0.05 m/frame ≈ 3.75 shoulder-widths/s. Positions are OneEuro-filtered
    // before differentiation, so a single step change reads low; the filter converges within a few
    // frames of continuous motion (constant lag does not reduce the measured slope).
    let moved = first;
    for (let i = 1; i <= 8; i += 1) moved = extractor.extract(pose(i * 33.33, { wristLateral: 0.05 * i }))!;
    expect(Math.abs(moved.wristVelocityRight.x)).toBeGreaterThan(3);
    expect(Math.abs(moved.wristVelocityRight.z)).toBeLessThan(0.5);
  });

  it('drops velocities after a capture gap longer than the velocity window', () => {
    const extractor = new BodyFeatureExtractor();
    extractor.extract(pose(0));
    const resumed = extractor.extract(pose(1000, { wristLateral: 0.05 }))!;
    expect(resumed.wristVelocityRight).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('rejects non-increasing timestamps', () => {
    const extractor = new BodyFeatureExtractor();
    extractor.extract(pose(100));
    expect(() => extractor.extract(pose(100))).toThrow(RangeError);
    expect(() => extractor.extract(pose(50))).toThrow(RangeError);
  });

  it('reports occluded knee lift as NaN rather than as a phantom raised knee', () => {
    const extractor = new BodyFeatureExtractor();
    expect(extractor.extract(pose(0))!.kneeLiftLeft).toBeCloseTo(-1.125, 3);
    const occluded = extractor.extract(pose(33.33, { hiddenLandmarks: [25] }))!;
    // Zero would mean knee-at-hip-height — the extreme of the lift range — so validity uses NaN.
    expect(occluded.kneeLiftLeft).toBeNaN();
    expect(occluded.kneeLiftRight).toBeCloseTo(-1.125, 3);
  });

  it('zeroes hidden landmarks and their joints, and returns undefined when the core is hidden', () => {
    const extractor = new BodyFeatureExtractor();
    const hidden = extractor.extract(pose(0, { hiddenLandmarks: [15] }))!;
    expect(hidden.landmarksLocal[15]).toEqual({ x: 0, y: 0, z: 0 });
    expect(hidden.jointCosines[0]).toBe(0); // left elbow uses landmark 15
    expect(hidden.jointCosines[2]).toBeCloseTo(1, 3); // left knee (hip→knee→ankle) is straight

    const noCore = new BodyFeatureExtractor().extract(pose(0, { hiddenLandmarks: [11] }));
    expect(noCore).toBeUndefined();
  });
});

describe('ContextClassifier', () => {
  it('starts idle and reports a still player as idle once the window fills', () => {
    const classifier = new ContextClassifier();
    const decision = feed(classifier, idleFrames(48));
    expect(decision.activity).toBe('idle');
    expect(decision.confidence01).toBeGreaterThan(0.4);
  });

  it('detects sustained running', () => {
    const classifier = new ContextClassifier();
    const decision = feed(classifier, runningFrames(90));
    expect(decision.activity).toBe('running');
    expect(decision.scores.running).toBeGreaterThan(decision.scores.idle);
  });

  it('detects repeated lateral racket arcs as swinging', () => {
    const classifier = new ContextClassifier();
    const decision = feed(classifier, swingingFrames(90));
    expect(decision.activity).toBe('swinging');
  });

  it('detects guarded forward punches as striking', () => {
    const classifier = new ContextClassifier();
    const decision = feed(classifier, strikingFrames(120));
    expect(decision.activity).toBe('striking');
  });

  it('returns to idle when the player stops', () => {
    const classifier = new ContextClassifier();
    feed(classifier, runningFrames(90));
    const decision = feed(classifier, idleFrames(60, 3000));
    expect(decision.activity).toBe('idle');
  });

  it('ignores a single swing burst while running — challengers need sustained evidence', () => {
    const classifier = new ContextClassifier();
    feed(classifier, runningFrames(90));
    const burst = swingingFrames(6, 3000);
    for (const snapshot of burst) {
      expect(classifier.update(snapshot).activity).toBe('running');
    }
    expect(classifier.update(pose(T0 + 3300)).activity).toBe('running');
  });

  it('holds the activity through brief tracking loss and decays to idle when it persists', () => {
    const classifier = new ContextClassifier();
    feed(classifier, runningFrames(90));
    const grace = feed(classifier, lostFrames(15, 3000));
    expect(grace.activity).toBe('running');
    const decision = feed(classifier, lostFrames(70, 3500));
    expect(decision.activity).toBe('idle');
    expect(decision.confidence01).toBe(0);
  });

  it('reset() returns the classifier to a clean idle state', () => {
    const classifier = new ContextClassifier();
    feed(classifier, runningFrames(90));
    classifier.reset();
    const decision = feed(classifier, idleFrames(48, 5000));
    expect(decision.activity).toBe('idle');
  });
});

describe('ContextClassifier regression pinning', () => {
  it('never leaves idle for a single isolated lateral burst followed by stillness', () => {
    // One 300 ms arc at ~6 sw/s peak. The evidence lingers in the window longer than the dwell,
    // so if one burst could reach enterScore the mere persistence of stale evidence would flip
    // the context — the exact contract the FSM exists to prevent.
    const frames = [
      ...idleFrames(48),
      ...Array.from({ length: 9 }, (_, i) =>
        pose(T0 + (48 + i) * FRAME_MS, { wristLateral: 0.25 * Math.sin((Math.PI * (i + 1)) / 9) })),
      ...idleFrames(60, 57 * FRAME_MS),
    ];
    const classifier = new ContextClassifier();
    for (const snapshot of frames) {
      expect(classifier.update(snapshot).activity).toBe('idle');
    }
  });

  it('does not advance a pending challenge while tracking is lost', () => {
    const classifier = new ContextClassifier();
    // ~600 ms of swinging: enough to make swinging the winner but short of the 700 ms dwell.
    const burstPhase = swingingFrames(20);
    for (const snapshot of burstPhase) classifier.update(snapshot);
    // 20 lost frames (~660 ms): with the window frozen, the dwell would complete here if
    // lost frames still advanced the challenge.
    const loss = lostFrames(20, 700);
    for (const snapshot of loss) {
      expect(classifier.update(snapshot).activity).toBe('idle');
    }
  });

  it('does not fabricate running cadence from alternating knee occlusion', () => {
    const classifier = new ContextClassifier();
    const frames = Array.from({ length: 120 }, (_, i) =>
      pose(T0 + i * FRAME_MS, { hiddenLandmarks: [i % 2 === 0 ? 25 : 26] }));
    for (const snapshot of frames) {
      const decision = classifier.update(snapshot);
      expect(decision.activity).toBe('idle');
      expect(decision.scores.running).toBe(0);
    }
  });

  it('classifies a lateral swing the same when the player is yawed 90 degrees', () => {
    const classifier = new ContextClassifier();
    const frames = swingingFrames(90).map((snapshot) => rotateWorldYaw(snapshot, Math.PI / 2));
    const decision = feed(classifier, frames);
    expect(decision.activity).toBe('swinging');
  });

  it('detects running despite natural arm pump', () => {
    // Arm pump swings the wrists forward/backward in z at cadence — fast enough to register as
    // forward bursts — but running must rest on the knee-step signature, not on arm stillness.
    const frames = Array.from({ length: 120 }, (_, i) => {
      const phase = (i * FRAME_MS) / 500;
      const liftLeft = Math.max(0, Math.sin(2 * Math.PI * phase));
      const liftRight = Math.max(0, Math.sin(2 * Math.PI * phase + Math.PI));
      const bounce = Math.abs(Math.sin(4 * Math.PI * phase)) * 0.04;
      return setWorlds(pose(T0 + i * FRAME_MS), [
        [25, { y: 0.45 - liftLeft * 0.2 }],
        [26, { y: 0.45 - liftRight * 0.2 }],
        [23, { y: -bounce }],
        [24, { y: -bounce }],
        [15, { z: 0.15 * Math.sin(2 * Math.PI * phase + Math.PI) }],
        [16, { z: 0.15 * Math.sin(2 * Math.PI * phase) }],
      ]);
    });
    expect(feed(new ContextClassifier(), frames).activity).toBe('running');
  });

  it('keeps idle confidence high for a still player with realistic landmark jitter', () => {
    // ±7.5 mm uniform jitter per axis per frame — unfiltered finite differences would amplify
    // it into phantom wrist speed of the same order as real gestures.
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
    const frames = Array.from({ length: 90 }, (_, i) => {
      const base = pose(T0 + i * FRAME_MS);
      return {
        ...base,
        worldLandmarks: base.worldLandmarks.map((point) => ({
          ...point,
          x: point.x + rand() * 0.015,
          y: point.y + rand() * 0.015,
          z: point.z + rand() * 0.015,
        })),
      };
    });
    const decision = feed(new ContextClassifier(), frames);
    expect(decision.activity).toBe('idle');
    expect(decision.scores.idle).toBeGreaterThan(0.5);
  });

  it('does not blend evidence across a silent capture gap', () => {
    const classifier = new ContextClassifier();
    feed(classifier, swingingFrames(60));
    // Player stops during a 5 s inference stall; no callbacks means no lost frames, so the
    // resume frame is the first chance to notice the discontinuity.
    const decision = feed(classifier, idleFrames(70, 5000 + 3000));
    expect(decision.activity).toBe('idle');
    expect(decision.scores.swinging).toBe(0);
  });

  it('pins the dwell: continuous winning evidence still takes ~700 ms to commit', () => {
    // Empirical timeline for this fixture: swinging reaches enterScore at frame ~15; the commit
    // lands at frame ~36 — exactly dwellMs later. With dwellMs mutated to zero the commit would
    // land around frame ~18 instead, so the frame-30 assertion fails under mutation.
    const classifier = new ContextClassifier();
    const frames = swingingFrames(90);
    let commitFrame = -1;
    for (let i = 0; i < frames.length; i += 1) {
      const decision = classifier.update(frames[i]!);
      if (i === 30) expect(decision.activity).toBe('idle');
      if (commitFrame < 0 && decision.activity === 'swinging') commitFrame = i;
    }
    expect(commitFrame).toBeGreaterThanOrEqual(33);
    expect(commitFrame).toBeLessThan(60);
  });
});
