import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from '../src/cv/oneEuroFilter';
import { AutoCalibrator } from '../src/cv/autoCalibrator';
import { Calibrator } from '../src/cv/calibrator';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { CadenceTracker } from '../src/kinematics/cadenceTracker';
import { JumpDetector } from '../src/kinematics/jumpDetector';
import { landmarkConfidence } from '../src/kinematics/math';
import { LaneLeanDetector, torsoLeanDeltaRad } from '../src/kinematics/postureSignals';
import { SchmittTrigger } from '../src/kinematics/schmittTrigger';
import { hasMeaningfulLateralComponent, SwingDetector } from '../src/kinematics/swingDetector';
import { calibration, pose, poseWithWorldShoulderWidth, poseWithWorldTorso, rollUpperBody, rotateWorldYaw } from './fixtures/syntheticPose';

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

describe('Schmitt trigger', () => {
  it('fires once on the upward crossing and rearms below the off threshold', () => {
    const trigger = new SchmittTrigger(0.1, 0.05, 200);
    expect(trigger.update(0.11, 0)).toBe(true);
    expect(trigger.update(0.18, 40)).toBe(false);
    expect(trigger.update(0.04, 70)).toBe(false);
    expect(trigger.update(0.11, 240)).toBe(true);
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
  it('counts alternating knee lifts and reports a bounded arcade speed', () => {
    const tracker = new CadenceTracker();
    const profile = calibration();
    const samples = [
      [0, 0, 0], [100, 0.16, 0], [180, 0.16, 0], [240, 0, 0],
      [500, 0, 0.16], [580, 0, 0.16], [640, 0, 0],
      [900, 0.16, 0], [980, 0.16, 0], [1040, 0, 0],
    ] as const;
    const result = samples.map(([time, left, right]) => tracker.update(pose(time, { kneeLeft: left, kneeRight: right }), profile));
    expect(result.filter((item) => item.step)).toHaveLength(3);
    expect(result.at(-1)!.cadenceSpm).toBeGreaterThan(0);
    expect(result.at(-1)!.speed01).toBeGreaterThan(0);
    expect(result.at(-1)!.speed01).toBeLessThanOrEqual(1);
    expect(tracker.update(pose(1600), profile).cadenceSpm).toBe(0);
  });

  it('drops the previous cadence window after a long pause', () => {
    const tracker = new CadenceTracker();
    const profile = calibration();
    const frames = [
      [0, 0, 0], [100, 0.16, 0], [180, 0.16, 0], [220, 0, 0],
      [400, 0, 0.16], [480, 0, 0.16], [520, 0, 0],
      [700, 0.16, 0], [780, 0.16, 0], [820, 0, 0], [2100, 0, 0],
      [2600, 0.16, 0], [2680, 0.16, 0], [2720, 0, 0],
    ] as const;
    const result = frames.map(([time, left, right]) => tracker.update(pose(time, { kneeLeft: left, kneeRight: right }), profile));
    expect(result.at(-3)!.step).toBe('left');
    expect(result.at(-3)!.cadenceSpm).toBe(0);
  });

  it('counts synchronized knee crossings once and alternates exact ties', () => {
    const tracker = new CadenceTracker();
    const profile = calibration();
    const frames = [pose(0), pose(33), pose(66)];
    for (let time = 100; time <= 199; time += 33) frames.push(pose(time, { kneeLeft: 0.16, kneeRight: 0.16 }));
    for (let time = 232; time <= 532; time += 33) frames.push(pose(time));
    for (let time = 600; time <= 699; time += 33) frames.push(pose(time, { kneeLeft: 0.16, kneeRight: 0.16 }));
    const steps = frames.map((frame) => tracker.update(frame, profile).step).filter(Boolean);
    expect(steps).toEqual(['left', 'right']);
  });
});

describe('jump detector', () => {
  it('emits once on takeoff and does not emit again on landing', () => {
    const detector = new JumpDetector();
    const profile = calibration();
    const frames = [
      pose(0), pose(33), pose(66), pose(100), pose(133), pose(166),
      pose(199, { hipRise: 0.07 }), pose(232, { hipRise: 0.12 }), pose(266, { hipRise: 0.18 }),
      pose(299, { hipRise: 0.25 }), pose(332, { hipRise: 0.3 }), pose(366, { hipRise: 0.28 }),
      pose(399, { hipRise: 0.22 }), pose(432, { hipRise: 0.12 }), pose(466, { hipRise: 0.06 }),
      pose(499, { hipRise: 0.02 }), pose(666), pose(833),
    ];
    const fired = frames.map((frame) => detector.update(frame, profile)).filter(Boolean);
    expect(fired).toHaveLength(1);
  });

  it('keeps takeoff detection stable when the same movement is sampled at different frame rates', () => {
    const profile = calibration();
    const riseAt = (time: number): number => {
      if (time < 50 || time >= 650) return 0;
      if (time <= 250) return 0.3 * (time - 50) / 200;
      if (time <= 350) return 0.3;
      return 0.3 * (650 - time) / 300;
    };
    const fireTimes: number[] = [];
    for (const frameInterval of [16, 33, 50, 67]) {
      const detector = new JumpDetector();
      const fired: number[] = [];
      for (let time = 0; time <= 1300; time += frameInterval) {
        if (detector.update(pose(time, { hipRise: riseAt(time - 200) }), profile)) fired.push(time);
      }
      expect(fired).toHaveLength(1);
      fireTimes.push(fired[0]!);
    }
    expect(Math.max(...fireTimes) - Math.min(...fireTimes)).toBeLessThanOrEqual(75);
  });

  it('arms through resting hip jitter and fires the first jump', () => {
    const detector = new JumpDetector();
    const profile = calibration();
    const rises = [...Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.002 : -0.002)), 0.07, 0.12, 0.18, 0.25, 0.3];
    const fired = rises.filter((hipRise, i) => detector.update(pose(i * 33, { hipRise }), profile));
    expect(fired).toHaveLength(1);
  });

  it('does not classify small periodic hip bob as a jump', () => {
    const detector = new JumpDetector();
    const profile = calibration();
    const events: boolean[] = [];
    for (let time = 0; time <= 2000; time += 33) {
      const hipRise = 0.05 * Math.sin((2 * Math.PI * time) / 500);
      events.push(detector.update(pose(time, { hipRise }), profile));
    }
    expect(events.filter(Boolean)).toHaveLength(0);
  });

  it('re-arms for a second jump while the hip still oscillates', () => {
    const detector = new JumpDetector();
    const profile = calibration();
    const bump = (time: number, start: number) => {
      const elapsed = time - start;
      if (elapsed < 0 || elapsed > 500) return 0;
      if (elapsed <= 200) return (0.3 * elapsed) / 200;
      if (elapsed <= 300) return 0.3;
      return (0.3 * (500 - elapsed)) / 200;
    };
    const fired: number[] = [];
    for (let time = 0; time <= 3400; time += 33) {
      const hipRise = 0.05 * Math.sin((2 * Math.PI * time) / 500) + bump(time, 800) + bump(time, 2600);
      if (detector.update(pose(time, { hipRise }), profile)) fired.push(time);
    }
    expect(fired).toHaveLength(2);
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
    expect(detector.update(pose(100, { wristLateral: -0.3 }), profile)).toBeUndefined();
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
    const signals = frames.map((frame) => detector.update(frame, profile)).filter(Boolean);
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

  it('classifies the peak stroke direction and maps the peak wrist position into three aim zones', () => {
    const classify = (hand: 'left' | 'right', displacement: number, rotate = false) => {
      const detector = new SwingDetector(hand);
      const profile = calibration();
      let signal: ReturnType<SwingDetector['update']>;
      for (const time of [0, 20, 40, 60, 80, 110]) {
        const progress = time <= 80 ? time / 80 : 1 - (time - 80) / 30;
        const snapshot = pose(time, { [hand === 'right' ? 'wristLateral' : 'leftWristLateral']: displacement * progress });
        const current = detector.update(rotate ? rotateWorldYaw(snapshot, 0.9) : snapshot, profile);
        if (current) signal = current;
      }
      return signal;
    };
    expect(classify('right', 0.2)).toMatchObject({ side: 'backhand', aimZone: 'cross' });
    expect(classify('right', 0.1)).toMatchObject({ aimZone: 'center' });
    expect(classify('right', -0.2)).toMatchObject({ side: 'forehand', aimZone: 'line' });
    expect(classify('left', 0.2)).toMatchObject({ side: 'forehand' });
    expect(classify('right', -0.2, true)).toMatchObject({ side: 'forehand', aimZone: 'line' });
    expect(classify('left', 0.2, true)).toMatchObject({ side: 'forehand', aimZone: 'line' });
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
    expect(detector.update(pose(270, { wristLateral: -0.2 }), profile)).toBeUndefined();
    expect(detector.update(pose(310, { wristLateral: 0.2 }), profile)).toMatchObject({ side: 'forehand' });
  });
});

describe('world-space posture calibration', () => {
  it('stores the leg-derived vertical and the habitual lean baseline', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time, { leanRad: 0.2 }));
    const world = calibrator.finish()!.world;
    expect(world.leanUp0?.x).toBeCloseTo(0, 2);
    expect(world.leanUp0?.y).toBeCloseTo(-1, 2);
    expect(world.leanUp0?.z).toBeCloseTo(0, 2);
    expect(world.torsoLeanRad0).toBeCloseTo(0.2, 2);
  });

  it('rejects calibration when the full-body landmarks stay below the confidence gate', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time, { hiddenLandmarks: [25, 26] }));
    expect(calibrator.finish()).toBeNull();
  });

  it('rejects calibration when confidence is NaN instead of counting those frames as valid', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    // `< 0.55` rejection gates never fire on NaN — without the non-finite floor these frames
    // passed every gate and poisoned the medians (medianConfidence came out NaN, ratio 1).
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time, { confidence: Number.NaN }));
    expect(calibrator.finish()).toBeNull();
  });

  it('counts degraded frames in calibration coverage instead of hiding them from the ratio', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0, frame = 0; time <= 3000; time += 100, frame += 1) {
      const invalid = frame % 2 === 1;
      const snapshot = pose(time, invalid ? { hiddenLandmarks: [25, 26] } : {});
      if (invalid) snapshot.trackingState = 'degraded';
      calibrator.add(snapshot);
    }
    expect(calibrator.finish()).toBeNull();
  });

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
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(frame(time, time % 200 === 0 ? 0.01 : -0.01));
    const profile = calibrator.finish()!;
    expect(torsoLeanDeltaRad(frame(0, roll), profile)).toBeCloseTo(roll, 1);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 12 }, (_, i) => detector.update(frame(i * 33, i < 4 ? 0 : roll), profile));
    expect(signals.filter(Boolean)).toEqual([direction]);
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

  it('does not read a body turn as lean after calibrating with a forward-tilted trunk', () => {
    // Level camera, trunk calibrated 20° forward: the slanted trunk would lean the reference,
    // but the stored vertical comes from the legs, which point along gravity.
    const tilt = (20 * Math.PI) / 180;
    const up = { x: 0, y: -Math.cos(tilt), z: Math.sin(tilt) };
    const down = { x: 0, y: 1, z: 0 };
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(poseWithWorldTorso(time, { up, down }));
    const profile = calibrator.finish()!;
    const turned = rotateWorldYaw(poseWithWorldTorso(0, { up, down }), Math.PI / 4);
    expect(torsoLeanDeltaRad(turned, profile)).toBeCloseTo(0, 2);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 10 }, (_, i) => detector.update(
      rotateWorldYaw(poseWithWorldTorso(i * 33, { up, down }), (i * Math.PI) / 20), profile,
    ));
    expect(signals.filter(Boolean)).toHaveLength(0);
  });

  it('saves a lean-less profile when the leg vertical cannot be verified', () => {
    // Ankles hidden (tennis framing): the thigh direction cannot be checked against the shins,
    // so the profile ships without a lean reference — swings still work, lane changes stay off.
    const noAnkles = (time: number, options?: Parameters<typeof pose>[1]) => withWorldConfidence(
      withWorldConfidence(pose(time, options), 27, 0, 0), 28, 0, 0,
    );
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(noAnkles(time));
    const profile = calibrator.finish()!;
    expect(profile.world.leanUp0).toBeUndefined();
    expect(profile.image.hipY0).toBeUndefined();
    const swing = new SwingDetector('right');
    for (let time = 0; time <= 240; time += 40) expect(swing.update(noAnkles(time), profile)).toBeUndefined();
    swing.update(noAnkles(270, { wristLateral: -0.2 }), profile);
    expect(swing.update(noAnkles(310, { wristLateral: 0.2 }), profile)).toMatchObject({ side: 'forehand' });
    const lane = new LaneLeanDetector();
    const signals = [0, 33, 66, 99, 132, 165, 198].map((time) => lane.update(
      pose(time, { leanRad: 0.3 }), profile,
    ));
    expect(signals.filter(Boolean)).toHaveLength(0);
    // The same takeoff sequence emits one jump with a complete profile and stays silent
    // with the partial one — the neutral dwell is what arms the detector.
    const frames = [
      pose(0), pose(33), pose(66), pose(100), pose(133), pose(166),
      pose(199, { hipRise: 0.07 }), pose(232, { hipRise: 0.12 }), pose(266, { hipRise: 0.18 }),
      pose(299, { hipRise: 0.25 }), pose(332, { hipRise: 0.3 }), pose(366, { hipRise: 0.28 }),
      pose(399, { hipRise: 0.22 }), pose(432, { hipRise: 0.12 }), pose(466, { hipRise: 0.06 }),
      pose(499, { hipRise: 0.02 }), pose(666), pose(833),
    ];
    const complete = new JumpDetector();
    expect(frames.map((frame) => complete.update(frame, calibration())).filter(Boolean)).toHaveLength(1);
    const jump = new JumpDetector();
    expect(frames.map((frame) => jump.update(frame, profile)).filter(Boolean)).toHaveLength(0);
  });

  it('verifies the stance references only when most samples show straight legs', () => {
    const noAnkles = (time: number) => withWorldConfidence(
      withWorldConfidence(pose(time), 27, 0, 0), 28, 0, 0,
    );
    const calibrateWithGaps = (hideAnkles: (frame: number) => boolean) => {
      const calibrator = new Calibrator();
      calibrator.start(0);
      for (let time = 0, frame = 0; time <= 3000; time += 100, frame += 1) {
        calibrator.add(hideAnkles(frame) ? noAnkles(time) : pose(time));
      }
      return calibrator.finish()!.world;
    };
    expect(calibrateWithGaps((frame) => frame % 4 === 0).leanUp0).toBeDefined();
    const unverified = calibrateWithGaps((frame) => frame % 2 === 0);
    expect(unverified.leanUp0).toBeUndefined();
  });

  it('counts the leg-verification threshold over all captured frames, not just the valid ones', () => {
    // 9 pose-less frames leave 22 valid (still ≥65% of the window); the legs verify in 17
    // of them — over half the valid set, but under 65% of everything captured.
    const noAnkles = (time: number) => withWorldConfidence(
      withWorldConfidence(pose(time), 27, 0, 0), 28, 0, 0,
    );
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0, frame = 0; time <= 3000; time += 100, frame += 1) {
      calibrator.add(frame < 9 ? pose(time, { confidence: 0.1 }) : frame < 14 ? noAnkles(time) : pose(time));
    }
    const profile = calibrator.finish()!;
    expect(profile).not.toBeNull();
    expect(profile.world.leanUp0).toBeUndefined();
  });

  it('verifies the stance separately from the racket reference', () => {
    // Wrist and ankle confidence drop on different frames: each gate sees enough samples
    // on its own, so the profile keeps both the racket and the stance references.
    const noWrist = (time: number) => withWorldConfidence(pose(time), 16, 0, 0);
    const noAnkles = (time: number) => withWorldConfidence(
      withWorldConfidence(pose(time), 27, 0, 0), 28, 0, 0,
    );
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0, frame = 0; time <= 3000; time += 100, frame += 1) {
      calibrator.add(frame < 8 ? noWrist(time) : frame < 15 ? noAnkles(time) : pose(time));
    }
    const profile = calibrator.finish()!;
    expect(profile.world.leanUp0).toBeDefined();
    expect(profile.image.hipY0).toBeDefined();
  });

  it('measures the jump baseline only over verified-stance frames', () => {
    // A third of the window crouches on bent knees: those frames still feed the swing and
    // cadence baselines, but the hip height comes only from the verified standing frames.
    const bend = (20 * Math.PI) / 180;
    const thighDown = { x: 0, y: Math.cos(bend), z: Math.sin(bend) };
    const shinDown = { x: 0, y: 1, z: 0 };
    const crouched = (time: number) => {
      const snapshot = poseWithWorldTorso(time, { down: thighDown, shinDown });
      return {
        ...snapshot,
        landmarks: snapshot.landmarks.map((p, i) => ((i === 23 || i === 24) ? { ...p, y: 0.59 } : p)),
      };
    };
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0, frame = 0; time <= 3000; time += 100, frame += 1) {
      calibrator.add(frame < 10 ? crouched(time) : pose(time));
    }
    const profile = calibrator.finish()!;
    expect(profile.world.leanUp0).toBeDefined();
    expect(profile.image.hipY0).toBeCloseTo(0.55, 5);
  });

  it('leaves the lean reference unset when the knees are bent at calibration', () => {
    // Standing with knees bent 20°: shins stay vertical, thighs tilt forward — the thigh
    // direction is not a standing vertical and cannot back the lean reference.
    const bend = (20 * Math.PI) / 180;
    const thighDown = { x: 0, y: Math.cos(bend), z: Math.sin(bend) };
    const shinDown = { x: 0, y: 1, z: 0 };
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) {
      calibrator.add(poseWithWorldTorso(time, { down: thighDown, shinDown }));
    }
    expect(calibrator.finish()!.world.leanUp0).toBeUndefined();
  });

  it('measures a whole-body lean where the thighs rotate with the trunk', () => {
    // Ankle-pivot lean: trunk and thighs stay parallel, so the fixed reference must not follow.
    const down = { x: Math.sin(0.24), y: Math.cos(0.24), z: 0 };
    const profile = calibration();
    expect(torsoLeanDeltaRad(poseWithWorldTorso(0, { leanRad: 0.24, down }), profile)).toBeCloseTo(0.24, 2);
  });

  it('keeps the neutral baseline when the knees leave the camera frame', () => {
    const calibrator = new Calibrator();
    calibrator.start(0);
    for (let time = 0; time <= 3000; time += 100) calibrator.add(pose(time, { leanRad: 0.2 }));
    const profile = calibrator.finish()!;
    const hiddenKnees = (time: number) => withWorldConfidence(
      withWorldConfidence(pose(time, { leanRad: 0.2 }), 25, 0, 0), 26, 0, 0,
    );
    expect(torsoLeanDeltaRad(hiddenKnees(0), profile)).toBeCloseTo(0, 2);
    const detector = new LaneLeanDetector();
    const signals = Array.from({ length: 8 }, (_, i) => detector.update(hiddenKnees(i * 33), profile));
    expect(signals.filter(Boolean)).toHaveLength(0);
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
    expect(result.events.filter((event) => event.type === 'sprint')).toHaveLength(0);
  });

  it('preserves a raised-knee latch through a one-frame confidence dip', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { kneeLeft: 0.16 }), profile);
    pipeline.update(pose(132, { kneeLeft: 0.16 }), profile);
    pipeline.update(pose(165, { kneeLeft: 0.16 }), profile);
    const firstStep = pipeline.update(pose(198, { kneeLeft: 0.16 }), profile);
    expect(firstStep.events.filter((event) => event.type === 'step')).toHaveLength(1);
    const degraded = pipeline.update(pose(231, { kneeLeft: 0.16, confidence: 0.1 }), profile);
    expect(degraded.controls).toMatchObject({ sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'degraded' });
    const recovery = [264, 297, 330].map((time) => pipeline.update(pose(time, { kneeLeft: 0.16 }), profile));
    expect(recovery.flatMap((result) => result.events).filter((event) => event.type === 'step')).toHaveLength(0);
  });

  it('exposes neutral continuous sprint control as cadence tracking is lost', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const frames = [
      [0, 0, 0], [33, 0, 0], [66, 0, 0],
      [166, 0.16, 0], [246, 0.16, 0], [306, 0, 0],
      [566, 0, 0.16], [646, 0, 0.16], [706, 0, 0],
      [966, 0.16, 0], [1046, 0.16, 0],
    ] as const;
    const active = frames.map(([time, left, right]) => pipeline.update(pose(time, { kneeLeft: left, kneeRight: right }), profile)).at(-1)!;
    expect(active.controls.sprintSpeed01).toBeGreaterThan(0);
    const lost = [1110, 1143, 1176, 1209].map((time) => pipeline.update(pose(time, { hiddenLandmarks: [25, 26] }), profile)).at(-1)!;
    expect(lost.controls).toMatchObject({ sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'lost' });
  });

  it.each([
    ['hidden knees', 'degraded'],
    ['removed calibration', 'lost'],
    ['reset', 'lost'],
  ] as const)('stops the sprint exactly once on %s', (cause, state) => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const frames = [
      [0, 0, 0], [33, 0, 0], [66, 0, 0],
      [166, 0.16, 0], [246, 0.16, 0], [306, 0, 0],
      [566, 0, 0.16], [646, 0, 0.16], [706, 0, 0],
      [966, 0.16, 0], [1046, 0.16, 0],
    ] as const;
    frames.forEach(([time, left, right]) => { pipeline.update(pose(time, { kneeLeft: left, kneeRight: right }), profile); });
    const after = [1079, 1112].flatMap((time) => {
      if (cause === 'reset') return pipeline.reset();
      if (cause === 'removed calibration') return pipeline.update(pose(time)).events;
      return pipeline.update(pose(time, { hiddenLandmarks: [25, 26] }), profile).events;
    });
    expect(after.filter((event) => event.type === 'sprint')).toMatchObject([{ speed01: 0, cadenceSpm: 0, trackingState: state }]);
  });

  it('keeps a standstill measured on a tracked pose stamped as tracked', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const frames = [
      [0, 0, 0], [33, 0, 0], [66, 0, 0],
      [166, 0.16, 0], [246, 0.16, 0], [306, 0, 0],
      [566, 0, 0.16], [646, 0, 0.16], [706, 0, 0],
      [966, 0.16, 0], [1046, 0.16, 0],
    ] as const;
    frames.forEach(([time, left, right]) => { pipeline.update(pose(time, { kneeLeft: left, kneeRight: right }), profile); });
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
    for (let time = 0; time <= 2100; time += 33) {
      const elapsed = Math.max(0, time - 200);
      const cycle = Math.floor(elapsed / 400);
      const withinStep = elapsed % 400;
      const lift = time >= 200 && withinStep < 200 ? 0.16 : 0;
      const snapshot = pose(time, {
        kneeLeft: cycle % 2 === 0 ? lift : 0,
        kneeRight: cycle % 2 === 1 ? lift : 0,
        hipRise: 0.05 * Math.sin((2 * Math.PI * time) / 500),
      });
      events.push(...pipeline.update(snapshot, profile).events);
    }
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
    expect(swings[0]).toMatchObject({ side: 'forehand', aimZone: 'line' });
    expect(swings[0]!.type === 'swing' && swings[0]!.power01).toBeGreaterThan(0.5);
  });

  it('solta o golpe segurado quando a mão rival perde o rastreamento sem confirmar', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.15, leftWristLateral: 0.15 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.35 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    // Left wrist vanishes: once its gate is lost the pending arc dies and the held swing emits.
    const swings = [165, 198, 231, 264]
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
    const swings = [165, 198, 231, 264].flatMap((time) => pipeline.update(lost(time), profile).events).filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(0);
  });
});

describe('calibração automática', () => {
  const run = (frame: (time: number) => ReturnType<typeof pose>) => {
    const auto = new AutoCalibrator();
    return Array.from({ length: 61 }, (_, i) => auto.update(frame(i * 100)));
  };

  it('calibra sozinha com o corpo parado, com repouso para as duas mãos', () => {
    const profile = run((time) => pose(time)).find((step) => step.profile)?.profile;
    expect(profile?.world.readyWristLocal.left).toBeDefined();
    expect(profile?.world.readyWristLocal.right).toBeDefined();
  });

  it('não calibra enquanto a pessoa se mexe', () => {
    expect(run((time) => pose(time, { hipRise: time % 1000 < 500 ? 0 : 0.3 })).some((step) => step.profile)).toBe(false);
  });

  it('pede enquadramento sem rastreamento', () => {
    expect(run((time) => ({ ...pose(time), trackingState: 'lost' })).every((step) => step.phase === 'framing')).toBe(true);
  });
});

it('pede enquadramento enquanto os joelhos não aparecem', () => {
  const auto = new AutoCalibrator();
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(pose(i * 100, { hiddenLandmarks: [25, 26] })));
  expect(steps.every((step) => step.phase === 'framing')).toBe(true);
});

it('pede enquadramento quando não há ninguém no quadro', () => {
  const empty = { ...pose(0), landmarks: [], worldLandmarks: [], trackingState: 'lost' as const };
  expect(new AutoCalibrator().update(empty)).toEqual({ phase: 'framing', progress: 0 });
});

it('conta quadros sem enquadramento na cobertura em vez de escondê-los da razão', () => {
  const auto = new AutoCalibrator();
  // All good until the collection starts (~1 s), then every other frame goes bad: in the
  // 3 s window they are ~half the total — under the 65% coverage gate, so it must retry.
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(pose(i * 100, { confidence: i <= 10 || i % 2 === 0 ? 0.95 : 0.1 })));
  expect(steps.some((step) => step.profile)).toBe(false);
});

it('exige tornozelos no enquadramento quando o esporte precisa de postura em pé', () => {
  const auto = new AutoCalibrator();
  const steps = Array.from({ length: 45 }, (_, i) => auto.update(pose(i * 100, { hiddenLandmarks: [27, 28] }), true));
  expect(steps.every((step) => step.phase === 'framing')).toBe(true);
});

it('rejeita perfil sem vertical das pernas quando o esporte precisa dela', () => {
  const auto = new AutoCalibrator();
  const noWorldAnkles = (time: number) => withWorldConfidence(withWorldConfidence(pose(time), 27, 0, 0), 28, 0, 0);
  const steps = Array.from({ length: 45 }, (_, i) => auto.update(noWorldAnkles(i * 100), true));
  expect(steps.some((step) => step.profile)).toBe(false);
});

it('aceita perfil parcial quando o esporte não precisa da vertical das pernas', () => {
  const auto = new AutoCalibrator();
  const noWorldAnkles = (time: number) => withWorldConfidence(withWorldConfidence(pose(time), 27, 0, 0), 28, 0, 0);
  const steps = Array.from({ length: 45 }, (_, i) => auto.update(noWorldAnkles(i * 100)));
  const done = steps.find((step) => step.profile);
  expect(done?.profile).toBeDefined();
  expect(done?.profile?.world.leanUp0).toBeUndefined();
});

it('encerra a tentativa no prazo mesmo quando os tornozelos não voltam', () => {
  const auto = new AutoCalibrator();
  // Ankles leave the frame right after the collection starts and never come back: the
  // deadline still applies, the buffer is dropped and framing resumes — no stuck 100%.
  const steps = Array.from({ length: 45 }, (_, i) => auto.update(pose(i * 100, { hiddenLandmarks: i <= 10 ? [] : [27, 28] }), true));
  expect(steps.some((step) => step.phase === 'collecting')).toBe(true);
  expect(steps.some((step) => step.phase === 'collecting' && step.progress >= 1)).toBe(false);
  expect(steps.at(-1)?.phase).toBe('framing');
});

it('tolera um quadro ruim isolado no meio da coleta', () => {
  const auto = new AutoCalibrator();
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(pose(i * 100, { confidence: i === 25 ? 0.1 : 0.95 })));
  expect(steps.some((step) => step.profile)).toBe(true);
});

const lostPose = (time: number) => ({ ...pose(time), landmarks: [], worldLandmarks: [], trackingState: 'lost' as const });

it('absorve uma perda curta de rastreamento na cobertura da coleta', () => {
  const auto = new AutoCalibrator();
  // ~600 ms sem pose no meio da janela: ~20% dos quadros — a cobertura de 65% ainda aprova.
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(i >= 20 && i < 26 ? lostPose(i * 100) : pose(i * 100)));
  expect(steps.some((step) => step.profile)).toBe(true);
});

it('encerra a tentativa no prazo mesmo quando o rastreamento não volta', () => {
  const auto = new AutoCalibrator();
  // Coleta começa (~1 s) e a pose some de vez: o prazo encerra a tentativa, a cobertura
  // rejeita e o framing retorna — nada de coleta travada nem reset antecipado.
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(i <= 12 ? pose(i * 100) : lostPose(i * 100)));
  expect(steps.some((step) => step.phase === 'collecting')).toBe(true);
  expect(steps.some((step) => step.profile)).toBe(false);
  expect(steps.at(-1)?.phase).toBe('framing');
});

it('rejeita pela cobertura e retenta quando a perda cobre boa parte da janela', () => {
  const auto = new AutoCalibrator();
  // 1,2 s sem pose numa janela de 3 s: ~60% de válidos, abaixo dos 65% — a tentativa morre
  // na cobertura, não no reset, e a coleta recomeça com o corpo de volta.
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(i >= 20 && i < 32 ? lostPose(i * 100) : pose(i * 100)));
  expect(steps.some((step) => step.profile)).toBe(false);
  expect(steps.at(-1)?.phase).toBe('collecting');
});

it('reinicia o repouso quando o rastreamento se perde antes de coletar', () => {
  const auto = new AutoCalibrator();
  // Perda durante o settling não tem coleta a proteger: o repouso recomeça do zero.
  const steps = Array.from({ length: 61 }, (_, i) => auto.update(i >= 5 && i < 9 ? lostPose(i * 100) : pose(i * 100)));
  const firstCollect = steps.findIndex((step) => step.phase === 'collecting');
  expect(firstCollect).toBeGreaterThanOrEqual(19);
  expect(steps.some((step) => step.profile)).toBe(true);
});
