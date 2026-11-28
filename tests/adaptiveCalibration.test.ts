import { describe, expect, it } from 'vitest';
import type { CalibrationProfile } from '../src/cv/protocol';
import { AdaptiveCalibrator } from '../src/cv/adaptiveCalibrator';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { pose, poseWithWorldShoulderWidth } from './fixtures/syntheticPose';

function hideWorld(snapshot: ReturnType<typeof pose>, indices: readonly number[]) {
  return {
    ...snapshot,
    worldLandmarks: snapshot.worldLandmarks.map((point, index) => indices.includes(index) ? { ...point, visibility: 0, presence: 0 } : point),
  };
}

function feed(calibrator: AdaptiveCalibrator, frames: ReturnType<typeof pose>[]) {
  let profile: CalibrationProfile | undefined;
  for (const frame of frames) profile = calibrator.update(frame, 0) ?? profile;
  return profile;
}

describe('adaptive calibration', () => {
  it('publishes a torso profile in under a second without legs, feet or wrists', () => {
    const calibrator = new AdaptiveCalibrator();
    const frames = [];
    for (let time = 0; time <= 700; time += 35) {
      frames.push(hideWorld(pose(time, { hiddenLandmarks: [15, 16, 25, 26, 27, 28] }), [15, 16, 25, 26, 27, 28]));
    }

    const profile = feed(calibrator, frames);
    expect(profile).toBeDefined();
    expect(profile!.world.shoulderWidth).toBeCloseTo(0.4, 2);
    expect(profile!.world.readyWristLocal).toBeUndefined();
  });

  it('publishes a valid calibration profile even when hips [23, 24] are completely outside a close webcam frame', () => {
    const calibrator = new AdaptiveCalibrator();
    const frames = [];
    for (let time = 0; time <= 750; time += 35) {
      frames.push(hideWorld(pose(time, { hiddenLandmarks: [23, 24, 25, 26, 27, 28] }), [23, 24, 25, 26, 27, 28]));
    }

    const profile = feed(calibrator, frames);
    expect(profile).toBeDefined();
    expect(profile!.world.shoulderWidth).toBeCloseTo(0.4, 2);
    expect(profile!.image.shoulderCenterX0).toBeCloseTo(0.5, 2);
  });

  it('does not publish before a minimum evidence span', () => {
    const calibrator = new AdaptiveCalibrator();
    expect(feed(calibrator, [pose(0), pose(100), pose(200), pose(300)])).toBeUndefined();
  });

  it.each([
    ['hidden core', () => pose(0, { hiddenLandmarks: [11, 12, 23, 24] })],
    ['NaN confidence', () => pose(0, { confidence: Number.NaN })],
  ] as const)('never publishes from %s', (_name, makeFrame) => {
    const calibrator = new AdaptiveCalibrator();
    const profile = feed(calibrator, Array.from({ length: 40 }, (_, index) => {
      const frame = makeFrame();
      return { ...frame, timestampMs: index * 35 };
    }));

    expect(profile).toBeUndefined();
  });

  it('does not count a long callback gap as calibration evidence', () => {
    const calibrator = new AdaptiveCalibrator();
    const frames = [];
    for (let time = 0; time <= 300; time += 30) frames.push(pose(time));
    frames.push(pose(1000));
    const profile = feed(calibrator, frames);

    expect(profile).toBeUndefined();
  });

  it('does not credit intervals containing rejected frames as continuous evidence', () => {
    const calibrator = new AdaptiveCalibrator();
    const frames = [];
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const start = cycle * 175;
      frames.push(pose(start));
      for (let rejected = 1; rejected <= 4; rejected += 1) {
        frames.push(pose(start + rejected * 35, { confidence: 0.1 }));
      }
    }

    expect(feed(calibrator, frames)).toBeUndefined();
  });

  it('does not let time spent rejecting frames mature neutral readiness', () => {
    const calibrator = new AdaptiveCalibrator();
    let profile: CalibrationProfile | undefined;
    for (let time = 0; time <= 700; time += 35) profile = calibrator.update(pose(time), 0) ?? profile;
    expect(profile).toBeDefined();
    const initialNeutral01 = profile!.readiness!.neutral01;

    for (let time = 735; time <= 3500; time += 35) {
      profile = calibrator.update(pose(time, { confidence: 0.1 }), 0) ?? profile;
    }

    expect(profile!.readiness!.neutral01).toBeLessThanOrEqual(initialNeutral01 + 1e-9);
    expect(profile!.readiness!.neutral01).toBeLessThan(0.65);
  });

  it('still converges when isolated rejected frames leave most of the stream valid', () => {
    const calibrator = new AdaptiveCalibrator();
    const frames = Array.from({ length: 160 }, (_, index) => (
      index % 4 === 3 ? pose(index * 35, { confidence: 0.1 }) : pose(index * 35)
    ));

    expect(feed(calibrator, frames)).toBeDefined();
  });

  it('uses the robust median shoulder width instead of chasing noisy frames', () => {
    const calibrator = new AdaptiveCalibrator();
    const frames = [];
    for (let index = 0; index < 40; index += 1) {
      const outlier = index % 5 === 4;
      frames.push(poseWithWorldShoulderWidth(index * 35, outlier ? 0.62 : 0.4));
    }

    const profile = feed(calibrator, frames);
    expect(profile!.world.shoulderWidth).toBeGreaterThan(0.36);
    expect(profile!.world.shoulderWidth).toBeLessThan(0.45);
  });

  it('adapts the neutral center only after a relocation is sustained far beyond any lane hold', () => {
    const calibrator = new AdaptiveCalibrator();
    for (let time = 0; time <= 1400; time += 35) calibrator.update(pose(time), 0);
    const initial = calibrator.update(pose(1435), 0);
    expect(initial).toBeDefined();
    expect(initial!.image.shoulderCenterX0).toBeCloseTo(0.5, 2);

    // A displaced position sustained for 20 s is indistinguishable from a long lane hold:
    // neutral must not chase it — that ambiguity is exactly how the inverted lane came back.
    let held = initial;
    for (let time = 1470; time <= 21000; time += 35) {
      held = calibrator.update(pose(time, { shiftUserRightSw: 0.3 }), 1) ?? held;
    }
    expect(Math.abs(held!.image.shoulderCenterX0 - 0.5)).toBeLessThan(0.01);

    // Past half a minute without any near-center posture it is a relocation, not a hold:
    // the gate reopens and the reference moves toward the new standing position.
    let adapted = held;
    for (let time = 21035; time <= 55000; time += 35) {
      adapted = calibrator.update(pose(time, { shiftUserRightSw: 0.3 }), 1) ?? adapted;
    }
    // 0.3 shoulder widths toward the player's right is 0.042 normalized units toward image left.
    expect(adapted!.image.shoulderCenterX0).toBeLessThan(0.49);
  });

  it('does not recentre neutral after a short lane-position hold', () => {
    const calibrator = new AdaptiveCalibrator();
    let profile: CalibrationProfile | undefined;
    for (let time = 0; time <= 2500; time += 35) profile = calibrator.update(pose(time), 0) ?? profile;
    for (let time = 2535; time <= 4300; time += 35) profile = calibrator.update(pose(time, { shiftUserRightSw: 0.3 }), 1) ?? profile;
    for (let time = 4335; time <= 7000; time += 35) profile = calibrator.update(pose(time), 0) ?? profile;

    expect(Math.abs(profile!.image.shoulderCenterX0 - 0.5)).toBeLessThan(0.005);
  });

  it('activates scale-dependent controls quickly', () => {
    // Scale-dependent swings come online much earlier than the neutral lane reference.
    const swingCalibrator = new AdaptiveCalibrator();
    const swingPipeline = new ActionPipeline();
    for (let time = 0; time <= 1300; time += 35) {
      const frame = pose(time);
      swingPipeline.update(frame, swingCalibrator.update(frame, 0));
    }
    const swingFrame = pose(1335, { wristLateral: -0.3 });
    const swingEvents = swingPipeline.update(swingFrame, swingCalibrator.update(swingFrame, 0)).events;
    expect(swingEvents.some((event) => event.type === 'swing-start')).toBe(true);
  });

  it('keeps publishing wrist references while the neutral center is starved off-center', () => {
    // Regression: a tennis player standing off-center provides no near-center posture evidence,
    // but scale and wrist learning must not freeze with the center — only the center freezes.
    // The wrists stay hidden until the rolling window has fully aged out the centered bootstrap,
    // so the reference can only mature while the center is genuinely starved.
    const calibrator = new AdaptiveCalibrator();
    let profile: CalibrationProfile | undefined;
    for (let time = 0; time <= 1000; time += 35) {
      profile = calibrator.update(pose(time, { hiddenLandmarks: [15, 16] }), 0) ?? profile;
    }
    for (let time = 1035; time <= 9100; time += 35) {
      profile = calibrator.update(pose(time, { shiftUserRightSw: 0.3, hiddenLandmarks: [15, 16] }), 1) ?? profile;
    }
    expect(profile!.world.readyWristLocal?.right).toBeUndefined(); // no wrist evidence yet at all

    for (let time = 9135; time <= 12500; time += 35) {
      profile = calibrator.update(pose(time, { shiftUserRightSw: 0.3 }), 1) ?? profile;
    }
    expect(profile!.world.readyWristLocal?.right).toBeDefined(); // learned despite the starved center
    expect(profile!.image.shoulderCenterX0).toBeCloseTo(0.5, 2); // while the center stays frozen
  });

  it('does not infer a wrist reference from one short dwell', () => {
    const calibrator = new AdaptiveCalibrator();
    const frames = [];
    for (let time = 0; time <= 1200; time += 35) frames.push(pose(time));
    const profile = feed(calibrator, frames);

    expect(profile).toBeDefined();
    expect(profile!.world.readyWristLocal?.right).toBeUndefined();
  });

  it('learns a wrist reference only after a low-speed position recurs', () => {
    const calibrator = new AdaptiveCalibrator();
    let profile: CalibrationProfile | undefined;
    for (let time = 0; time <= 1000; time += 35) profile = calibrator.update(pose(time), 0) ?? profile;
    expect(profile?.world.readyWristLocal?.right).toBeUndefined();

    // A fast lateral rally creates a gap in the low-speed evidence; returning to the same
    // position later forms a recurrent cluster instead of treating the swing finish as neutral.
    for (let time = 1035; time <= 1500; time += 35) {
      const lateral = 0.35 * Math.sin((time - 1035) / 55);
      profile = calibrator.update(pose(time, { wristLateral: lateral }), 0) ?? profile;
    }
    for (let time = 1535; time <= 3200; time += 35) profile = calibrator.update(pose(time), 0) ?? profile;

    expect(profile?.world.readyWristLocal?.right).toBeDefined();
    expect(profile!.world.readyWristLocal!.right!.y).toBeCloseTo(-1.25, 1);
  });
});
