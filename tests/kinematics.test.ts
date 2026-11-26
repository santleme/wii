import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from '@wii/spatial-core';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { landmarkConfidence } from '../src/kinematics/math';
import { LaneLeanDetector, torsoLeanDeltaRad } from '../src/kinematics/postureSignals';
import { hasMeaningfulLateralComponent, SwingDetector } from '../src/kinematics/swingDetector';
import { calibration, pose, poseWithHipBounce, poseWithWorldShoulderWidth, poseWithWorldTorso, rollUpperBody, rotateWorldYaw } from './fixtures/syntheticPose';
import { cadenceHarness } from './fixtures/torsoHarness';

/** Feeds the pipeline with torso bounce at 150 spm between `from` and `until` — the run-in-place signal. */
function driveBounce(pipeline: ActionPipeline, profile: ReturnType<typeof calibration>, from: number, until: number, startAt = 0) {
  const hz = 150 / 60;
  for (let time = startAt; time <= until; time += 33) {
    const units = time >= from ? 0.04 * Math.sin((2 * Math.PI * hz * (time - from)) / 1000) : 0;
    pipeline.update(poseWithHipBounce(time, units * 0.4), profile);
  }
}

function withWorldConfidence(snapshot: ReturnType<typeof pose>, index: number, visibility: number, presence: number) {
  return {
    ...snapshot,
    worldLandmarks: snapshot.worldLandmarks.map((point, pointIndex) => pointIndex === index ? { ...point, visibility, presence } : point),
  };
}

describe('1-Euro filter', () => {
  it('reduces static jitter and follows a fast movement', () => {
    const filter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
    const noisy = [0, 0.02, -0.02, 0.01, -0.01, 0];
    const outputs = noisy.map((value, i) => filter.filter(value, i * 33));
    expect(Math.abs(outputs.at(-1)!)).toBeLessThan(0.02);
    const moved = filter.filter(1, 200);
    expect(moved).toBeGreaterThan(outputs.at(-1)!);
  });
});

describe('landmark confidence', () => {
  it('returns zero for no visible points and falls back to presence when visibility is omitted', () => {
    expect(landmarkConfidence()).toBe(0);
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, presence: 0.8 })).toBe(0.8);
  });

  it('returns zero for non-finite confidence instead of propagating it', () => {
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, visibility: Number.NaN })).toBe(0);
    // NaN masks a finite presence through Math.min; positive infinity masks it only when both are infinite.
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, visibility: Number.NaN, presence: 0.9 })).toBe(0);
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, visibility: Number.POSITIVE_INFINITY, presence: 0.9 })).toBe(0.9);
  });
});

describe('cadence tracker', () => {
  it('counts steps from torso bounce and reports a bounded arcade speed', () => {
    const { feed } = cadenceHarness();
    const results = [];
    for (let time = 0; time <= 4000; time += 33) {
      const active = time >= 200 && time <= 3000;
      const units = active ? 0.04 * Math.sin((2 * Math.PI * 2.5 * (time - 200)) / 1000) : 0;
      results.push({ time, ...feed(poseWithHipBounce(time, units * 0.4)) });
    }
    const steps = results.filter((r) => r.step);
    expect(steps.length).toBeGreaterThan(3);
    const active = results.filter((r) => r.time > 1500 && r.time <= 3000);
    expect(active.every((r) => r.speed01 > 0)).toBe(true);
    expect(Math.max(...results.map((r) => r.speed01))).toBeLessThanOrEqual(1);
    expect(results.at(-1)!.cadenceSpm).toBe(0);
  });

  it('drops the previous cadence window after a long pause', () => {
    const { feed } = cadenceHarness();
    const hz = 2.5;
    const results = [];
    for (let time = 0; time <= 6000; time += 33) {
      const bouncing = (time >= 200 && time <= 2000) || (time >= 4600 && time <= 4700);
      const units = bouncing ? 0.04 * Math.sin((2 * Math.PI * hz * time) / 1000) : 0;
      results.push({ time, ...feed(poseWithHipBounce(time, units * 0.4)) });
    }
    // Steady bouncing establishes a cadence...
    expect(results.filter((r) => r.time > 1200 && r.time <= 2000).every((r) => r.speed01 > 0)).toBe(true);
    // ...it stops during the pause (within the 1.6-period stop deadline), and the brief
    // pulse afterwards cannot resurrect it.
    expect(results.filter((r) => r.time > 2800).every((r) => r.cadenceSpm === 0)).toBe(true);
  });
});

describe('swing detector', () => {
  it('uses a bounded lateral component for stroke candidates', () => {
    expect(hasMeaningfulLateralComponent(10, 2.4)).toBe(false);
    expect(hasMeaningfulLateralComponent(10, 2.5)).toBe(true);
    expect(hasMeaningfulLateralComponent(10, 2.6)).toBe(true);
  });

  it('emits one swing and ignores the fast return until the ready pose is held', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    expect(detector.update(pose(0), profile)).toBeUndefined();
    expect(detector.update(pose(100, { wristLateral: -0.3 }), profile)).toMatchObject({ kind: 'onset' });
    expect(detector.update(pose(150, { wristLateral: 0.2 }), profile)).toMatchObject({ side: 'forehand' });
    expect(detector.update(pose(200, { wristLateral: 0 }), profile)).toBeUndefined();
    expect(detector.update(pose(400, { wristLateral: 0 }), profile)).toBeUndefined();
  });

  it.each(['wristVertical', 'wristDepth'] as const)('does not confirm a swing from %s motion', (axis) => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    const signals = [detector.update(pose(0), profile)];
    for (let time = 100; time <= 500; time += 40) {
      signals.push(detector.update(pose(time, { [axis]: 0.3, wristLateral: 0.02 }), profile));
    }
    expect(signals.filter(Boolean)).toHaveLength(0);
  });

  it('keeps a lateral peak when the wrist finishes upward', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    const frames = [pose(0), pose(33), pose(66, { wristLateral: -0.11 })];
    for (let time = 99; time <= 495; time += 33) frames.push(pose(time, { wristLateral: -0.12, wristVertical: 0.3 }));
    const signals = frames.map((frame) => detector.update(frame, profile)).filter((output) => output?.kind === 'confirmed');
    expect(signals).toMatchObject([{ side: 'forehand' }]);
  });

  it('requires a new neutral dwell after each swing', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    detector.reset();
    for (let time = 0; time <= 240; time += 40) detector.update(pose(time), profile);
    detector.update(pose(270, { wristLateral: -0.2 }), profile);
    expect(detector.update(pose(310, { wristLateral: 0.2 }), profile)).toBeDefined();
    detector.update(pose(1500), profile); // a single neutral frame
    detector.update(pose(1540, { wristLateral: -0.2 }), profile);
    expect(detector.update(pose(1580, { wristLateral: 0.2 }), profile)).toBeUndefined();
  });

  it('drops a pending swing after a tracking gap', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    detector.update(pose(0), profile);
    detector.update(pose(99, { wristLateral: -0.3 }), profile);
    expect(detector.update(pose(3099, { wristLateral: -0.3 }), profile)).toBeUndefined();
  });

  it('classifies the peak stroke direction, robust to body yaw', () => {
    const classify = (hand: 'left' | 'right', displacement: number, rotate = false) => {
      const detector = new SwingDetector(hand);
      const profile = calibration();
      let signal: ReturnType<SwingDetector['update']>;
      for (const time of [0, 20, 40, 60, 80, 110]) {
        const progress = time <= 80 ? time / 80 : 1 - (time - 80) / 30;
        const snapshot = pose(time, { [hand === 'right' ? 'wristLateral' : 'leftWristLateral']: displacement * progress });
        const current = detector.update(rotate ? rotateWorldYaw(snapshot, 0.9) : snapshot, profile);
        if (current?.kind === 'confirmed') signal = current;
      }
      return signal;
    };
    expect(classify('right', 0.2)).toMatchObject({ side: 'backhand' });
    expect(classify('right', -0.2)).toMatchObject({ side: 'forehand' });
    expect(classify('left', 0.2)).toMatchObject({ side: 'forehand' });
    expect(classify('right', -0.2, true)).toMatchObject({ side: 'forehand' });
    expect(classify('left', 0.2, true)).toMatchObject({ side: 'forehand' });
  });

  it('does not infer a swing from frame-to-frame shoulder-width variation', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    const frames = [0.4, 0.6, 0.4, 0.6, 0.4].map((width, index) => poseWithWorldShoulderWidth(index * 33, width));
    const signals = frames.map((frame) => detector.update(frame, profile)).filter(Boolean);
    expect(signals).toHaveLength(0);
  });

  it('waits for a neutral ready pose before rearming after a confirmed tracking loss', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    detector.reset();
    for (let time = 0; time <= 240; time += 40) expect(detector.update(pose(time), profile)).toBeUndefined();
    expect(detector.update(pose(270, { wristLateral: -0.2 }), profile)).toMatchObject({ kind: 'onset' });
    expect(detector.update(pose(310, { wristLateral: 0.2 }), profile)).toMatchObject({ side: 'forehand' });
  });

  it('re-arms without a wrist reference after low speed is sustained', () => {
    const detector = new SwingDetector('right');
    const base = calibration();
    const profile = { ...base, world: { ...base.world, readyWristLocal: undefined } };
    detector.update(pose(0), profile);
    detector.update(pose(100, { wristLateral: -0.3 }), profile);
    expect(detector.update(pose(150, { wristLateral: 0.2 }), profile)).toMatchObject({ kind: 'confirmed' });
    for (let time = 200; time <= 700; time += 50) detector.update(pose(time), profile);

    expect(detector.update(pose(750, { wristLateral: -0.3 }), profile)).toMatchObject({ kind: 'onset' });
    expect(detector.update(pose(800, { wristLateral: 0.2 }), profile)).toMatchObject({ kind: 'confirmed' });
  });

  it('does not count a tracking gap as velocity-only re-arm dwell', () => {
    const detector = new SwingDetector('right');
    const base = calibration();
    const profile = { ...base, world: { ...base.world, readyWristLocal: undefined } };
    detector.update(pose(0), profile);
    detector.update(pose(100, { wristLateral: -0.3 }), profile);
    detector.update(pose(150, { wristLateral: 0.2 }), profile);
    for (let time = 200; time <= 600; time += 50) detector.update(pose(time), profile);
    detector.update(pose(900), profile); // resumes after a 300 ms hole: not observed rest

    expect(detector.update(pose(950, { wristLateral: -0.3 }), profile)).toBeUndefined();
  });
});

describe('world-space posture calibration', () => {
  it('uses world torso geometry for lane lean and emits one direction while the pose is held', () => {
    const detector = new LaneLeanDetector();
    const profile = calibration();
    const leanPose = pose(99, { leanRad: 0.24 });
    expect(torsoLeanDeltaRad(leanPose, profile)).toBeCloseTo(0.24, 2);
    expect(torsoLeanDeltaRad(rotateWorldYaw(leanPose, 0.9), profile)).toBeCloseTo(0.24, 2);
    const signals = [0, 33, 66, 99, 132, 165, 198].map((time) => detector.update(
      pose(time, { leanRad: time < 99 ? 0 : 0.24 }), profile,
    )).filter(Boolean);
    expect(signals).toEqual(['right']);
  });

  it.each([
    [0.3, 0, 'right'], [-0.3, 0, 'left'], [0.3, 0.9, 'right'], [-0.3, 0.9, 'left'],
  ] as const)('measures a rigid trunk roll of %s rad at yaw %s', (roll, yaw, direction) => {
    const frame = (time: number, radians: number) => rotateWorldYaw(rollUpperBody(pose(time), radians), yaw);
    const profile = calibration();
    expect(torsoLeanDeltaRad(frame(0, roll), profile)).toBeCloseTo(roll, 1);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 12 }, (_, i) => detector.update(frame(i * 33, i < 4 ? 0 : roll), profile));
    expect(signals.filter(Boolean)).toEqual([direction]);
  });

  it('does not read a body turn as lean after calibrating with a forward-tilted trunk', () => {
    // Level camera, trunk calibrated 20° forward: the slanted trunk would lean the reference,
    // but the stored vertical comes from the legs, which point along gravity.
    const tilt = (20 * Math.PI) / 180;
    const up = { x: 0, y: -Math.cos(tilt), z: Math.sin(tilt) };
    const down = { x: 0, y: 1, z: 0 };
    const profile = calibration();
    const turned = rotateWorldYaw(poseWithWorldTorso(0, { up, down }), Math.PI / 4);
    expect(torsoLeanDeltaRad(turned, profile)).toBeCloseTo(0, 2);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 10 }, (_, i) => detector.update(
      rotateWorldYaw(poseWithWorldTorso(i * 33, { up, down }), (i * Math.PI) / 20), profile,
    ));
    expect(signals.filter(Boolean)).toHaveLength(0);
  });

  it('does not read an upright body turn as lean when the camera is tilted', () => {
    // Webcam pitched 25°: the calibrated trunk-up is tilted in camera space.
    const tilt = (25 * Math.PI) / 180;
    const up = { x: 0, y: -Math.cos(tilt), z: Math.sin(tilt) };
    const profile = { ...calibration(), world: { ...calibration().world, leanUp0: up } };
    expect(torsoLeanDeltaRad(poseWithWorldTorso(0, { up }), profile)).toBeCloseTo(0, 3);
    // A 45° body turn measured ≈ −0.30 rad against the camera's horizontal plane.
    expect(torsoLeanDeltaRad(poseWithWorldTorso(0, { up, yawRad: Math.PI / 4 }), profile)).toBeCloseTo(0, 2);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 10 }, (_, i) => detector.update(
      poseWithWorldTorso(i * 33, { up, yawRad: (i * Math.PI) / 20 }), profile,
    ));
    expect(signals.filter(Boolean)).toHaveLength(0);
  });

  it.each([[0.24, 'right'], [-0.24, 'left']] as const)('measures a real %s rad lean at 45° yaw with a tilted camera', (leanRad, direction) => {
    const tilt = (25 * Math.PI) / 180;
    const up = { x: 0, y: -Math.cos(tilt), z: Math.sin(tilt) };
    const profile = { ...calibration(), world: { ...calibration().world, leanUp0: up } };
    expect(torsoLeanDeltaRad(poseWithWorldTorso(0, { up, yawRad: Math.PI / 4, leanRad }), profile)).toBeCloseTo(leanRad, 2);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 10 }, (_, i) => detector.update(
      poseWithWorldTorso(i * 33, { up, yawRad: Math.PI / 4, leanRad: i < 4 ? 0 : leanRad }), profile,
    ));
    expect(signals.filter(Boolean)).toEqual([direction]);
  });

  it('measures a whole-body lean where the thighs rotate with the trunk', () => {
    // Ankle-pivot lean: trunk and thighs stay parallel, so the fixed reference must not follow.
    const down = { x: Math.sin(0.24), y: Math.cos(0.24), z: 0 };
    const profile = calibration();
    expect(torsoLeanDeltaRad(poseWithWorldTorso(0, { leanRad: 0.24, down }), profile)).toBeCloseTo(0.24, 2);
  });

  it('keeps the neutral baseline when the knees leave the camera frame', () => {
    const profile = { ...calibration(), world: { ...calibration().world, torsoLeanRad0: 0.2 } };
    const hiddenKnees = (time: number) => withWorldConfidence(
      withWorldConfidence(pose(time, { leanRad: 0.2 }), 25, 0, 0), 26, 0, 0,
    );
    expect(torsoLeanDeltaRad(hiddenKnees(0), profile)).toBeCloseTo(0, 2);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 8 }, (_, i) => detector.update(hiddenKnees(i * 33), profile));
    expect(signals.filter(Boolean)).toHaveLength(0);
  });

  it('keeps lane lean working with a trunk-derived reference when the legs were never visible', () => {
    // The trunk-derived reference absorbs the habitual posture at calibration; a lean AWAY
    // from neutral must still read as a delta and emit lane changes.
    const noLegs = (time: number, leanRad = 0) => {
      const snapshot = pose(time, { leanRad, hiddenLandmarks: [25, 26, 27, 28] });
      return {
        ...snapshot,
        worldLandmarks: snapshot.worldLandmarks.map((point, index) => (index >= 25 ? { ...point, visibility: 0, presence: 0 } : point)),
      };
    };
    const profile = calibration();
    // Neutral reads zero...
    expect(torsoLeanDeltaRad(noLegs(0), profile)).toBeCloseTo(0, 1);
    // ...and a real lean reads as a delta of the right size.
    expect(torsoLeanDeltaRad(noLegs(0, 0.24), profile)).toBeCloseTo(0.24, 1);
    const detector = new LaneLeanDetector();
    const signals = [0, 33, 66, 99, 132, 165, 198].map((time) => detector.update(
      noLegs(time, time < 99 ? 0 : 0.24), profile,
    )).filter(Boolean);
    expect(signals).toEqual(['right']);
  });

  it('waits for neutral posture before emitting a lane change after tracking reset', () => {
    const detector = new LaneLeanDetector();
    const profile = calibration();
    detector.reset();
    expect(detector.update(pose(0, { leanRad: 0.24 }), profile)).toBeUndefined();
    for (let time = 33; time <= 500; time += 33) expect(detector.update(pose(time), profile)).toBeUndefined();
    const signals = [533, 566, 599, 632, 665].map((time) => detector.update(pose(time, { leanRad: 0.24 }), profile)).filter(Boolean);
    expect(signals).toEqual(['right']);
  });
});

describe('action pipeline tracking gate', () => {
  it('keeps all discrete action signals quiet for a stationary jitter fixture', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const events = Array.from({ length: 90 }, (_, index) => {
      const jitter = index % 2 === 0 ? 0.015 : -0.015;
      return pipeline.update(pose(index * 33, { kneeLeft: jitter, kneeRight: -jitter, wristLateral: jitter / 10 }), profile).events;
    }).flat().filter((event) => event.type !== 'sprint');
    expect(events).toHaveLength(0);
  });

  it('does not emit sport actions while pose confidence is lost', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const visible = [pose(0), pose(33), pose(66)];
    visible.forEach((frame) => { pipeline.update(frame, profile); });
    const lost = [pose(100, { confidence: 0.1 }), pose(133, { confidence: 0.1 }), pose(166, { confidence: 0.1 }), pose(199, { confidence: 0.1 })];
    expect(lost.flatMap((frame) => pipeline.update(frame, profile).events)).toHaveLength(0);
  });

  it('keeps upper-body swings available when knees are outside the camera frame', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hiddenKnees = { hiddenLandmarks: [25, 26] } as const;
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time, hiddenKnees), profile); });
    pipeline.update(pose(100, { ...hiddenKnees, wristLateral: -0.3 }), profile);
    const result = pipeline.update(pose(133, { ...hiddenKnees, wristLateral: 0.2 }), profile);
    expect(result.snapshot.trackingState).toBe('tracked');
    expect(result.events.filter((event) => event.type === 'swing')).toHaveLength(1);
    expect(result.events.filter((event) => event.type === 'sprint').every((event) => event.speed01 === 0)).toBe(true);
  });

  it('preserves the step stream through a one-frame confidence dip', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const bounceAt = (time: number) => poseWithHipBounce(time, 0.04 * Math.sin((2 * Math.PI * hz * time) / 1000) * 0.4);
    for (let time = 0; time <= 1500; time += 33) pipeline.update(bounceAt(time), profile);
    const before = pipeline.update(bounceAt(1533), profile);
    expect(before.controls.trackingState).toBe('tracked');
    const degraded = pipeline.update(pose(1566, { confidence: 0.1 }), profile);
    expect(degraded.controls).toMatchObject({ sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'degraded' });
    expect(degraded.events.filter((event) => event.type === 'step')).toHaveLength(0);
    // The gate needs three consecutive good frames to leave 'degraded' — and no spurious
    // step fires out of the dip itself.
    const recovery = [1599, 1632, 1665].map((time) => pipeline.update(bounceAt(time), profile));
    expect(recovery.at(-1)!.controls.trackingState).toBe('tracked');
  });

  it('exposes neutral continuous sprint control as cadence tracking is lost', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    const active = pipeline.update(poseWithHipBounce(1079, 0), profile);
    expect(active.controls.sprintSpeed01).toBeGreaterThan(0);
    // A sustained blackout — past the gate's 800 ms window — ends in 'lost' with the
    // sprint fully stopped (the coast has long decayed by then).
    const blackout = [];
    for (let time = 1112; time <= 2000; time += 33) blackout.push(pipeline.update(pose(time, { hiddenLandmarks: [23, 24] }), profile));
    const lost = blackout.at(-1)!;
    expect(lost.controls).toMatchObject({ sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'lost' });
  });

  it.each([
    ['hidden hips', 'degraded'],
    ['reset', 'lost'],
  ] as const)('stops the sprint exactly once on %s', (cause, state) => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    pipeline.update(poseWithHipBounce(1079, 0), profile);
    const after = [1112, 1145, 1178, 1211, 1244, 2000].flatMap((time) => {
      if (cause === 'reset') return pipeline.reset();
      return pipeline.update(pose(time, { hiddenLandmarks: [23, 24] }), profile).events;
    });
    const stops = after.filter((event) => event.type === 'sprint' && event.speed01 === 0);
    expect(stops).toHaveLength(1);
    // The stop rides whatever tracking state the frame carries when the coast runs out —
    // degraded early in the blackout, lost once the blackout is sustained.
    if (cause === 'reset') expect(stops[0]).toMatchObject({ speed01: 0, cadenceSpm: 0, trackingState: state });
    else expect(stops[0]?.trackingState).not.toBe('tracked');
  });

  it('coasts the sprint with damping through a brief blackout instead of dropping it in a step', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    const active = pipeline.update(poseWithHipBounce(1079, 0), profile);
    const speedBefore = active.controls.sprintSpeed01;
    expect(speedBefore).toBeGreaterThan(0.3);
    // A ~200 ms blur burst: the speed must decay smoothly, never hitting zero — and no
    // stop event may fire.
    const burst = [1112, 1145, 1178, 1211, 1244, 1277].map((time) => pipeline.update(pose(time, { hiddenLandmarks: [23, 24] }), profile));
    const speeds = burst.map((result) => result.controls.sprintSpeed01);
    expect(speeds.every((speed) => speed > 0)).toBe(true);
    expect(speeds[0]!).toBeLessThan(speedBefore);
    expect(speeds.at(-1)!).toBeLessThan(speeds[0]!);
    // Half-life 150 ms: ~230 ms into the blackout the carried speed sits at roughly a third.
    expect(speeds.at(-1)!).toBeGreaterThan(speedBefore * 0.2);
    expect(speeds.at(-1)!).toBeLessThan(speedBefore * 0.6);
    expect(burst.flatMap((result) => result.events).filter((event) => event.type === 'sprint' && event.speed01 === 0)).toHaveLength(0);
    expect(burst.every((result) => result.controls.trackingState === 'degraded')).toBe(true);
  });

  it('keeps the cadence memory through a burst: the run re-engages within a few frames of return', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const bounceAt = (time: number) => poseWithHipBounce(time, 0.04 * Math.sin((2 * Math.PI * hz * (time - 66)) / 1000) * 0.4);
    driveBounce(pipeline, profile, 66, 1046);
    pipeline.update(bounceAt(1079), profile);
    // The player keeps running through a ~300 ms blackout the camera cannot see.
    for (let time = 1112; time <= 1400; time += 33) pipeline.update(pose(time, { hiddenLandmarks: [23, 24] }), profile);
    // Detectors were never reset: the cadence memory is warm, so measured cadence flows
    // within the first tracked frames — a from-scratch restart would emit nothing for
    // ~2 step intervals (~800 ms at 150 spm). The median-of-three then purges the
    // blackout-stretched intervals over the next few steps, converging back to full pace.
    const early = [1433, 1466, 1499, 1532].map((time) => pipeline.update(bounceAt(time), profile));
    expect(early.at(-1)!.controls.trackingState).toBe('tracked');
    expect(early.at(-1)!.controls.cadenceSpm).toBeGreaterThan(40);
    const settled = [];
    for (let time = 1565; time <= 2400; time += 33) settled.push(pipeline.update(bounceAt(time), profile));
    expect(Math.max(...settled.map((result) => result.controls.sprintSpeed01))).toBeGreaterThan(0.4);
  });

  it('ends the coast in a single clean stop when the blackout outlasts the timeout', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    pipeline.update(poseWithHipBounce(1079, 0), profile);
    // Beyond the 600 ms coast timeout the runner must be fully stopped — and the zero
    // emitted exactly once even though bad frames keep coming.
    const blackout = [];
    for (let time = 1112; time <= 1750; time += 33) blackout.push(pipeline.update(pose(time, { hiddenLandmarks: [23, 24] }), profile));
    const stops = blackout.flatMap((result) => result.events).filter((event) => event.type === 'sprint' && event.speed01 === 0);
    expect(stops).toHaveLength(1);
    expect(blackout.at(-1)!.controls.sprintSpeed01).toBe(0);
    // 600+ ms is still inside the gate's 800 ms blackout window: degraded, not lost —
    // the detectors survive even this.
    expect(blackout.at(-1)!.controls.trackingState).toBe('degraded');
  });

  it('keeps cadence running when calibration is removed mid-stream', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const bounceAt = (time: number) => poseWithHipBounce(time, 0.04 * Math.sin((2 * Math.PI * hz * (time - 66)) / 1000) * 0.4);
    for (let time = 0; time <= 1046; time += 33) pipeline.update(bounceAt(time), profile);

    const frames = [1079, 1112, 1145].map((time) => pipeline.update(bounceAt(time)));
    expect(frames.every((frame) => frame.controls.trackingState === 'tracked')).toBe(true);
    expect(frames.at(-1)!.controls.sprintSpeed01).toBeGreaterThan(0);
    expect(frames.flatMap((frame) => frame.events).filter((event) => event.type === 'sprint' && event.speed01 === 0)).toHaveLength(0);
  });

  it('keeps the sprint going when the knees leave the camera frame', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const events = [];
    for (let time = 0; time <= 2500; time += 33) {
      const units = time >= 66 ? 0.04 * Math.sin((2 * Math.PI * hz * (time - 66)) / 1000) : 0;
      const snapshot = poseWithHipBounce(time, units * 0.4);
      // Knees and ankles are out of frame the whole time — irrelevant for torso-driven cadence.
      const hiddenLegs = {
        ...snapshot,
        landmarks: snapshot.landmarks.map((point, index) => (index >= 25 ? { ...point, visibility: 0, presence: 0 } : point)),
      };
      events.push(...pipeline.update(hiddenLegs, profile).events);
    }
    const steps = events.filter((event) => event.type === 'step');
    expect(steps.length).toBeGreaterThan(3);
    expect(events.filter((event) => event.type === 'sprint').every((event) => event.trackingState === 'tracked')).toBe(true);
  });

  it('keeps a standstill measured on a tracked pose stamped as tracked', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    pipeline.update(poseWithHipBounce(1079, 0), profile);
    const still = [1600, 1633].flatMap((time) => pipeline.update(pose(time), profile).events);
    expect(still.filter((event) => event.type === 'sprint')).toMatchObject([
      { speed01: 0, cadenceSpm: 0, trackingState: 'tracked' },
      { speed01: 0, cadenceSpm: 0, trackingState: 'tracked' },
    ]);
  });

  it('keeps the swing arc across a brief wrist occlusion and reports the gate confidence', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(withWorldConfidence(pose(99, { wristLateral: -0.3 }), 11, 0.6, 0.6), profile);
    pipeline.update(withWorldConfidence(pose(132, { wristLateral: -0.3 }), 16, 0.1, 0.1), profile);
    pipeline.update(pose(165, { wristLateral: 0.2 }), profile);
    pipeline.update(pose(198, { wristLateral: 0.2 }), profile);
    const recovery = pipeline.update(pose(231, { wristLateral: 0.2 }), profile);
    const swing = recovery.events.find((event) => event.type === 'swing');
    expect(swing).toMatchObject({ type: 'swing', confidence: 0.6 });
    expect(swing?.timestampMs).toBe(231);
    expect(swing?.type === 'swing' ? swing.peakTimestampMs : undefined).toBe(99);
  });

  it('keeps cadence events while filtering a small periodic hip bounce out of jump events', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const events = [];
    for (let time = 0; time <= 3000; time += 33) {
      const units = time >= 200 ? 0.05 * Math.sin((2 * Math.PI * time) / 500) : 0;
      events.push(...pipeline.update(poseWithHipBounce(time, units * 0.4), profile).events);
    }
    // The hip bounce IS the running signal now — cadence comes from the same channel that
    // the jump detector must reject as a jump.
    expect(events.filter((event) => event.type === 'step').length).toBeGreaterThan(3);
    expect(events.filter((event) => event.type === 'jump')).toHaveLength(0);
  });

  it('uses peak-frame confidence even when confidence is lower at confirmation time', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.3 }), profile);
    pipeline.update(withWorldConfidence(pose(132, { wristLateral: -0.3 }), 16, 0.1, 0.1), profile);
    pipeline.update(pose(165, { wristLateral: 0.2 }), profile);
    pipeline.update(pose(198, { wristLateral: 0.2 }), profile);
    const recovery = pipeline.update(withWorldConfidence(pose(231, { wristLateral: 0.2 }), 11, 0.6, 0.6), profile);
    const swing = recovery.events.find((event) => event.type === 'swing');
    expect(swing).toMatchObject({ type: 'swing', confidence: 0.95, timestampMs: 231, peakTimestampMs: 99 });
  });

  it('uses landmark presence as well as visibility to gate a swing', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const lowPresence = (time: number, wristLateral = 0) => withWorldConfidence(pose(time, { wristLateral }), 11, 0.95, 0.4);
    [0, 33, 66].forEach((time) => { pipeline.update(lowPresence(time), profile); });
    pipeline.update(lowPresence(99, -0.3), profile);
    const result = pipeline.update(lowPresence(132, 0.2), profile);
    expect(result.events.filter((event) => event.type === 'swing')).toHaveLength(0);
  });

  it('allows a swing when only its feature landmarks are tracked, and labels that local gate', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const missingHips = (time: number, wristLateral = 0) => {
      const snapshot = pose(time, { wristLateral });
      snapshot.landmarks = snapshot.landmarks.map((point, index) => [23, 24].includes(index) ? { ...point, visibility: 0.1, presence: 0.1 } : point);
      return snapshot;
    };
    [0, 33, 66].forEach((time) => { pipeline.update(missingHips(time), profile); });
    pipeline.update(missingHips(99, -0.3), profile);
    const recovery = pipeline.update(missingHips(132, 0.2), profile);
    const swing = recovery.events.find((event) => event.type === 'swing');
    expect(recovery.snapshot.trackingState).toBe('lost');
    expect(swing).toMatchObject({ type: 'swing', trackingState: 'tracked' });
  });
});

describe('mão da raquete', () => {
  it.each(['wristLateral', 'leftWristLateral'] as const)('reconhece o golpe sem escolher a mão (%s)', (wrist) => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const frames = [pose(0), pose(33), pose(66), pose(99), pose(132, { [wrist]: -0.3 }), pose(165, { [wrist]: 0.2 }), pose(198, { [wrist]: 0.2 })];
    const swings = frames.flatMap((frame) => pipeline.update(frame, profile).events).filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
  });

  it('segura a confirmação enquanto a outra mão ainda voa e deixa o golpe mais forte vencer', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    // Weak right arc reverses and confirms fast; the left wrist starts a strong arc in the
    // same frame, so the right's confirmation is held instead of locking the left out.
    pipeline.update(pose(99, { wristLateral: -0.15 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.15 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    pipeline.update(pose(165, { leftWristLateral: 0.35 }), profile);
    pipeline.update(pose(198, { leftWristLateral: 0.55 }), profile);
    const released = pipeline.update(pose(231, { leftWristLateral: 0.2 }), profile);
    const swings = released.events.filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
    expect(swings[0]).toMatchObject({ side: 'forehand' });
    expect(swings[0]!.type === 'swing' && swings[0]!.power01).toBeGreaterThan(0.5);
  });

  it('descarta o golpe segurado quando a escala deixa de ser confiável antes da liberação', () => {
    const pipeline = new ActionPipeline();
    const ready = { ...calibration(), readiness: { scale01: 1, neutral01: 1 } };
    const unready = { ...calibration(), readiness: { scale01: 0, neutral01: 1 } };
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), ready); });
    pipeline.update(pose(99, { wristLateral: -0.15 }), ready);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.35 }), ready);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);

    const fallen = pipeline.update(pose(165, { wristLateral: 0.05, leftWristLateral: 0.35 }), unready);
    expect(fallen.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    const recovered = pipeline.update(pose(198, { wristLateral: 0.05, leftWristLateral: 0.35 }), ready);
    expect(recovered.events.filter((event) => event.type === 'swing')).toHaveLength(0);
  });

  it('solta o golpe segurado quando a mão rival perde o rastreamento sem confirmar', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.15, leftWristLateral: 0.15 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.35 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    // Left wrist vanishes for good: once its gate crosses the sustained-blackout window
    // into lost the pending arc dies and the held swing emits.
    const frames = [];
    for (let time = 165; time <= 1100; time += 33) frames.push(time);
    const swings = frames
      .flatMap((time) => pipeline.update(withWorldConfidence(pose(time, { wristLateral: 0.05 }), 15, 0, 0), profile).events)
      .filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
  });

  it('desiste de esperar quando o rival fica degradado sem confirmar nem perder o rastreamento', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.15, leftWristLateral: 0.15 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.35 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    // 3 bad + 1 good keeps the rival gate forever degraded: its pending arc is never updated,
    // never confirmed and never reset — only the hold bound frees the waiting swing.
    const flapping = (time: number) => (Math.floor((time - 165) / 33) % 4 === 3
      ? pose(time, { wristLateral: 0.05 })
      : withWorldConfidence(pose(time, { wristLateral: 0.05 }), 15, 0, 0));
    const frames = Array.from({ length: 15 }, (_, i) => 165 + i * 33);
    const swings = frames.flatMap((time) => pipeline.update(flapping(time), profile).events).filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
  });

  it('descarta a confirmação dentro do bloqueio em vez de deixá-la disputar depois', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.3 }), profile);
    const first = pipeline.update(pose(132, { wristLateral: 0.2 }), profile);
    expect(first.events.filter((event) => event.type === 'swing')).toHaveLength(1);
    // Back near the ready pose (|wristLateral| < 0.14 keeps the wrist within reach) the
    // right detector re-readies before its second arc.
    for (let time = 165; time <= 495; time += 33) pipeline.update(pose(time, { wristLateral: -0.05 }), profile);
    pipeline.update(pose(495, { wristLateral: -0.05, leftWristLateral: 0.5 }), profile);
    // Block runs to 532 ms: the dominant left arc confirms inside it and is discarded;
    // only the right's post-block confirmation may reach the game.
    const blocked = pipeline.update(pose(528, { wristLateral: 0.35, leftWristLateral: 0.15 }), profile);
    const released = pipeline.update(pose(561, { wristLateral: -0.05, leftWristLateral: 0.15 }), profile);
    const swings = [blocked, released].flatMap((result) => result.events).filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
    expect(swings[0]).toMatchObject({ type: 'swing', side: 'backhand', timestampMs: 561, peakTimestampMs: 528 });
  });

  it('descarta o golpe segurado quando o próprio pulso perde o rastreamento', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.15, leftWristLateral: 0.15 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.35 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    // Both wrists vanish: the held swing's own basis is gone — it must be dropped, not released.
    const lost = (time: number) => withWorldConfidence(withWorldConfidence(pose(time, { wristLateral: 0.05 }), 15, 0, 0), 16, 0, 0);
    const frames = Array.from({ length: 10 }, (_, index) => 165 + index * 33);
    const swings = frames.flatMap((time) => pipeline.update(lost(time), profile).events).filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(0);
  });
});

describe('action pipeline (upper-body only)', () => {
  /** Full torso-core visibility, legs and wrists absent in BOTH spaces the whole time. */
  const torsoOnly = (time: number, hipYOffset = 0) => {
    const snapshot = poseWithHipBounce(time, hipYOffset);
    return {
      ...snapshot,
      landmarks: snapshot.landmarks.map((point, index) => (index >= 25 || index === 15 || index === 16 ? { ...point, visibility: 0, presence: 0 } : point)),
      worldLandmarks: snapshot.worldLandmarks.map((point, index) => (index >= 25 || index === 15 || index === 16 ? { ...point, visibility: 0, presence: 0 } : point)),
    };
  };

  it('produces sprint and step events with legs and wrists absent the whole time', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const events = [];
    for (let time = 0; time <= 3000; time += 33) {
      const units = time >= 200 ? 0.04 * Math.sin((2 * Math.PI * hz * (time - 200)) / 1000) : 0;
      events.push(...pipeline.update(torsoOnly(time, -units * 0.4), profile).events);
    }
    expect(events.filter((event) => event.type === 'step').length).toBeGreaterThan(3);
    expect(events.some((event) => event.type === 'sprint' && event.speed01 > 0)).toBe(true);
  });

  it('does not emit jumps for running bounce but does emit a mid-run jump, torso-only', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 2.8;
    // Same physics-coherent shape as the detector tests: crouch, quadratic powered rise
    // (velocity peaks at liftoff), simplified hold and landing.
    const jumpAt = (timeMs: number) => {
      const t = timeMs - 3000;
      if (t < 0) return 0;
      if (t < 250) return -0.1 * Math.sin((Math.PI * t) / 250) * 0.5 - (0.1 * t) / 500;
      if (t < 430) { const u = (t - 250) / 180; return -0.1 + 0.35 * u * u; }
      if (t < 700) return 0.25;
      if (t < 1000) return 0.25 * (1 - (t - 700) / 300);
      return 0;
    };
    const events = [];
    for (let time = 0; time <= 5000; time += 33) {
      // Quiet standing first (arms the jump detector), then bounce, then bounce+jump.
      const bouncing = time >= 1000;
      const units = (bouncing ? 0.05 * Math.sin((2 * Math.PI * hz * (time - 1000)) / 1000) : 0) + jumpAt(time);
      events.push(...pipeline.update(torsoOnly(time, -units * 0.4), profile).events);
    }
    const jumps = events.filter((event) => event.type === 'jump');
    expect(jumps).toHaveLength(1);
    expect(jumps[0]!.timestampMs).toBeGreaterThan(3000);
    // No jump is emitted during the pure-bounce portion before 3000.
    expect(events.filter((event) => event.type === 'jump' && event.timestampMs < 3000)).toHaveLength(0);
  });

  it('restarts swing re-arm continuity across an explicitly degraded wrist frame', () => {
    const pipeline = new ActionPipeline();
    const profile = { ...calibration(), world: { ...calibration().world, readyWristLocal: undefined } };
    const events: import('../src/cv/protocol').SportActionEvent[] = [];
    const feed = (time: number, lateral = 0, degraded = false) => {
      const base = pose(time, { wristLateral: lateral });
      const frame = degraded ? withWorldConfidence(base, 16, 0, 0) : base;
      events.push(...pipeline.update(frame, profile).events);
    };

    [0, 33, 66].forEach((time) => { feed(time); });
    feed(99, -0.3);
    feed(132, 0.2);
    for (let time = 165; time <= 599; time += 33) feed(time);
    feed(998, 0, true);
    for (let time = 1031; time <= 1331; time += 33) feed(time);
    feed(1364, -0.3);
    expect(events.filter((event) => event.type === 'swing-start' && event.timestampMs === 1364)).toHaveLength(0);

    for (let time = 1397; time <= 2200; time += 33) feed(time);
    feed(2233, -0.3);
    expect(events.some((event) => event.type === 'swing-start' && event.timestampMs === 2233)).toBe(true);
  });

  it('keeps swings available without readyWristLocal; lanes, cadence and jump still work', () => {
    const pipeline = new ActionPipeline();
    const noWristProfile = {
      ...calibration(),
      world: { ...calibration().world, readyWristLocal: undefined },
    };
    const events = [];
    const hz = 150 / 60;
    for (let time = 0; time <= 2500; time += 33) {
      const units = time >= 200 && time <= 1500 ? 0.04 * Math.sin((2 * Math.PI * hz * (time - 200)) / 1000) : 0;
      // Big wrist arcs on top — swings remain available because their references are only
      // a re-arm fast path, not an onset prerequisite.
      const snapshot = torsoOnly(time, units * 0.4);
      const withWrist = {
        ...snapshot,
        worldLandmarks: snapshot.worldLandmarks.map((point, index) => (index === 16 ? { ...point, x: -0.2 - (time % 2 === 0 ? -0.3 : 0.3), visibility: 0.95, presence: 0.95 } : point)),
      };
      events.push(...pipeline.update(withWrist, noWristProfile).events);
    }
    expect(events.filter((event) => event.type === 'swing').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'step').length).toBeGreaterThan(2);
  });
});
