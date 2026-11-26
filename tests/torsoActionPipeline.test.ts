import { describe, expect, it } from 'vitest';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { calibration, pose, poseWithHipBounce } from './fixtures/syntheticPose';

const TORSO_HEIGHT = 0.4;

function jumpRise(timeMs: number): number {
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
    expect(frames.flatMap((frame) => frame.events).filter((event) => event.type === 'lane' || event.type === 'swing' || event.type === 'swing-start')).toHaveLength(0);
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


  it('keeps lane quiet until the online neutral estimate has converged', () => {
    const run = (neutral01: number) => {
      const pipeline = new ActionPipeline();
      const profile = { ...calibration(), readiness: { scale01: 1, neutral01 } };
      const events = [];
      for (let time = 0; time <= 500; time += 33) {
        events.push(...pipeline.update(pose(time, { leanRad: time < 150 ? 0 : 0.24 }), profile).events);
      }
      return events.filter((event) => event.type === 'lane');
    };

    expect(run(0)).toHaveLength(0);
    expect(run(1)).toHaveLength(1);
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

});
