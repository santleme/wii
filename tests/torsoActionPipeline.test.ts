import { describe, expect, it } from 'vitest';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { calibration, pose, poseWithHipBounce } from './fixtures/syntheticPose';

const TORSO_HEIGHT = 0.4;

/** Twice the old profile: real recordings put jumps at 0.5–0.9 shoulder widths of rise. */
function jumpRise(timeMs: number): number {
  return 2 * jumpShape(timeMs);
}

function jumpShape(timeMs: number): number {
  const t = timeMs - 3000;
  if (t < 0) return 0;
  if (t < 250) return (-0.1 * (1 - Math.cos((Math.PI * t) / 250))) / 2;
  if (t < 430) {
    const progress = (t - 250) / 180;
    return -0.1 + 0.3 * progress * progress;
  }
  if (t < 700) return 0.2;
  if (t < 1000) return 0.2 * (1 - (t - 700) / 300);
  return 0;
}

function runningRise(timeMs: number): number {
  if (timeMs < 500) return 0;
  return 0.04 * Math.sin((2 * Math.PI * 2.5 * (timeMs - 500)) / 1000);
}

describe('torso action pipeline integration', () => {
  it.each([{ visibility: 1, presence: 0, offset: 0.7 }, { visibility: 1, presence: 1, offset: 1.3 }])(
    'ignores a moving wrist with low presence or outside the frame (%j)',
    ({ visibility, presence, offset }) => {
      const pipeline = new ActionPipeline();
      for (let t = 0; t <= 3000; t += 33) {
        const snapshot = pose(t);
        const landmarks = snapshot.landmarks.map((point, i) => i === 15
          ? { ...point, y: offset + Math.sin(t / 70) * 0.2, visibility, presence }
          : point);
        expect(pipeline.update({ ...snapshot, landmarks }).rawEffort).toBe(0);
      }
    },
  );

  it('feeds effort for a centered rhythmic jog even without sideways sway', () => {
    // Bouncing in place with both feet: strong rhythmic vertical strides, arms pumping, but the
    // weight never transfers sideways — the lateral channel stays quiet and cannot corroborate.
    const pipeline = new ActionPipeline();
    let peak = 0;
    for (let timeMs = 0; timeMs <= 3000; timeMs += 33) {
      const bounceY = 0.016 * Math.sin((2 * Math.PI * 2.5 * timeMs) / 1000);
      const swing = 0.1 * Math.sin((2 * Math.PI * 2.5 * timeMs) / 1000);
      const snapshot = pose(timeMs);
      const landmarks = snapshot.landmarks.map((point, index) => {
        if (index === 15 || index === 16) return { ...point, y: point.y + (index === 15 ? swing : -swing) };
        if (index === 0 || index === 11 || index === 12) return { ...point, y: point.y + bounceY };
        return point;
      });
      peak = Math.max(peak, pipeline.update({ ...snapshot, landmarks }).rawEffort);
    }
    expect(peak).toBeGreaterThan(0.1);
  });

  it('distinguishes running intensity when hidden hips are estimated above the shoulders', () => {
    const measure = (amplitude: number, running = true) => {
      const pipeline = new ActionPipeline();
      const results = [];
      for (let timeMs = 0; timeMs <= 3000; timeMs += 33) {
        // Arms only feed running effort while the torso bounces: head and shoulders oscillate
        // at running cadence here, and the arm swing amplitude scales the effort on top.
        const bounceY = running ? 0.016 * Math.sin((2 * Math.PI * 2.5 * timeMs) / 1000) : 0;
        const swayX = running ? 0.04 * Math.cos((2 * Math.PI * 2.5 * timeMs) / 1000) : 0;
        const snapshot = pose(timeMs);
        const swing = amplitude * Math.sin((2 * Math.PI * 1.5 * timeMs) / 1000);
        const landmarks = snapshot.landmarks.map((point, index) => {
          if (index >= 23) return { ...point, y: 0.1, visibility: 0, presence: 0 };
          if (index === 15 || index === 16) return { ...point, y: point.y + (index === 15 ? swing : -swing) };
          if (index === 0 || index === 11 || index === 12) return { ...point, y: point.y + bounceY, x: point.x + swayX };
          return point;
        });
        results.push(pipeline.update({ ...snapshot, landmarks }));
      }
      return results.at(-1)!;
    };

    const still = measure(0, false);
    const easy = measure(0.08);
    const hard = measure(0.16);
    expect(still.rawEffort).toBe(0);
    expect(easy.rawEffort).toBeGreaterThan(0.12);
    expect(hard.rawEffort).toBeGreaterThan(easy.rawEffort + 0.1);
    expect(hard.effortSampleAtMs).toBe(hard.snapshot.timestampMs);
  });

  it('keeps cadence and jump active without a calibration profile', () => {
    const pipeline = new ActionPipeline();
    const frames = [];

    for (let timeMs = 0; timeMs <= 7200; timeMs += 33) {
      const rise = runningRise(timeMs) + jumpRise(timeMs);
      const result = pipeline.update(poseWithHipBounce(timeMs, -rise * TORSO_HEIGHT));
      frames.push({ timeMs, ...result });
    }

    const jumps = frames.flatMap((frame) => frame.events).filter((event) => event.type === 'jump');
    expect(jumps).toHaveLength(1);
    expect(frames.some((frame) => frame.controls.sprintSpeed01 > 0)).toBe(true);
    expect(frames.at(-1)!.controls.trackingState).toBe('tracked');
    expect(frames.flatMap((frame) => frame.events).filter((event) => event.type === 'swing' || event.type === 'swing-start')).toHaveLength(0);
    expect(frames.every((frame) => (frame.controls.laneZone ?? 0) === 0)).toBe(true);
  });

  it('keeps cadence alive when a jump overlaps continuous running', () => {
    const pipeline = new ActionPipeline();
    const frames = [];

    for (let timeMs = 0; timeMs <= 7200; timeMs += 33) {
      const rise = runningRise(timeMs) + jumpRise(timeMs);
      const result = pipeline.update(poseWithHipBounce(timeMs, -rise * TORSO_HEIGHT), calibration());
      frames.push({ timeMs, ...result });
    }

    const jumps = frames.flatMap((frame) => frame.events).filter((event) => event.type === 'jump');
    expect(jumps).toHaveLength(1);

    const runningAfterLanding = frames.filter((frame) => frame.timeMs >= 4500 && frame.timeMs <= 6200);
    expect(runningAfterLanding.every((frame) => frame.controls.sprintSpeed01 > 0)).toBe(true);
  });

  it('does not interpret a high but continuous 3 Hz bounce as repeated jumps', () => {
    const pipeline = new ActionPipeline();
    const jumps = [];

    for (let timeMs = -600; timeMs <= 6000; timeMs += 33) {
      const rise = timeMs < 0 ? 0 : 0.14 * Math.sin((2 * Math.PI * 3 * timeMs) / 1000);
      const result = pipeline.update(poseWithHipBounce(timeMs, -rise * TORSO_HEIGHT), calibration());
      jumps.push(...result.events.filter((event) => event.type === 'jump'));
    }

    expect(jumps).toHaveLength(0);
  });


  it('keeps swing quiet until the online body scale is trustworthy', () => {
    const run = (scale01: number) => {
      const pipeline = new ActionPipeline();
      const profile = { ...calibration(), readiness: { scale01, neutral01: 1 } };
      for (const time of [0, 33, 66]) pipeline.update(pose(time), profile);
      return [
        ...pipeline.update(pose(100, { wristLateral: -0.3 }), profile).events,
        ...pipeline.update(pose(150, { wristLateral: 0.2 }), profile).events,
      ].filter((event) => event.type === 'swing' || event.type === 'swing-start');
    };

    expect(run(0)).toHaveLength(0);
    expect(run(1).length).toBeGreaterThan(0);
  });

  it('keeps running cadence and tracking alive when arm pump occludes one hip landmark every stride', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const results = [];
    for (let timeMs = 0; timeMs <= 3500; timeMs += 33) {
      const rise = runningRise(timeMs);
      const snapshot = poseWithHipBounce(timeMs, -rise * TORSO_HEIGHT);
      // Alternate occluding left (23) or right (24) hip as arms pump across the waist.
      const occludedHip = Math.floor(timeMs / 165) % 2 === 0 ? 23 : 24;
      const landmarks = snapshot.landmarks.map((point, index) => (
        index === occludedHip ? { ...point, visibility: 0.2, presence: 0.2 } : point
      ));
      results.push(pipeline.update({ ...snapshot, landmarks }, profile));
    }
    const tail = results.slice(-20);
    expect(tail.every((r) => r.controls.trackingState === 'tracked')).toBe(true);
    expect(tail.every((r) => r.controls.sprintSpeed01 > 0.3)).toBe(true);
  });

  it('rejects asymmetric single-shoulder shrugs and one-arm waving while standing still', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const speeds: number[] = [];
    for (let timeMs = 0; timeMs <= 3000; timeMs += 33) {
      const base = pose(timeMs);
      // Shrug/wave only the right shoulder (12) and wrist (16) up and down at 2.5 Hz while left shoulder (11) stays put.
      const wave = 0.08 * Math.sin((2 * Math.PI * 2.5 * timeMs) / 1000);
      const landmarks = base.landmarks.map((point, index) => (
        index === 12 || index === 16 ? { ...point, y: point.y + wave } : point
      ));
      // Also hide hips to force shoulder-driven vertical measurement, proving asymmetry gates it.
      landmarks[23] = { ...landmarks[23]!, visibility: 0.1, presence: 0.1 };
      landmarks[24] = { ...landmarks[24]!, visibility: 0.6, presence: 0.6 };
      const result = pipeline.update({ ...base, landmarks }, profile);
      speeds.push(result.controls.sprintSpeed01);
    }
    expect(Math.max(...speeds)).toBe(0);
  });

  it('recovers full running speed on the very first step after a 700 ms tracking blackout', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 165 / 60;
    const bounceAt = (t: number) => poseWithHipBounce(t, t < 300 ? 0 : -0.05 * Math.sin((2 * Math.PI * hz * (t - 300)) / 1000) * TORSO_HEIGHT);

    for (let t = 0; t <= 2200; t += 33) pipeline.update(bounceAt(t), profile);
    // 700 ms blackout (past the old 580 ms deadline, inside the 800 ms gate loss window):
    for (let t = 2233; t <= 2900; t += 33) {
      pipeline.update(pose(t, { confidence: 0.1 }), profile);
    }
    // Tracking returns: within one single step crossing (~360 ms — not two steps / ~730 ms),
    // full running speed (>0.55) is already restored.
    let recoveredSpeed = 0;
    for (let t = 2933; t <= 3329; t += 33) {
      recoveredSpeed = Math.max(recoveredSpeed, pipeline.update(bounceAt(t), profile).controls.sprintSpeed01);
    }
    expect(recoveredSpeed).toBeGreaterThan(0.55);
  });

});
