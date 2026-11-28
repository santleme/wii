import { describe, expect, it } from 'vitest';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { calibration, pose, poseWithHipBounce } from './fixtures/syntheticPose';

// Image units for the fixture's 0.14-wide shoulders in a 16:9 frame: one shoulder width of rise.
const WIDTH = 0.14 * (1280 / 720);

function drive(riseSw: (time: number) => number, until = 8000, hipsHidden = false) {
  const pipeline = new ActionPipeline();
  const jumps: number[] = [];
  const speeds: { time: number; speed: number }[] = [];
  for (let time = 0; time <= until; time += 33) {
    const frame = poseWithHipBounce(time, -riseSw(time) * WIDTH);
    const hidden = { ...frame, landmarks: frame.landmarks.map((point, index) => (index >= 23 ? { ...point, visibility: 0.1 } : point)) };
    const result = pipeline.update(hipsHidden ? hidden : frame, calibration());
    if (result.events.some((event) => event.type === 'jump')) jumps.push(time);
    speeds.push({ time, speed: result.controls.sprintSpeed01 });
  }
  return { jumps, speeds };
}

const hop = (time: number, at: number, height = 0.7) => (time > at && time < at + 500 ? height * Math.sin((Math.PI * (time - at)) / 500) : 0);
const stride = (time: number) => 0.09 * Math.sin((2 * Math.PI * 2.8 * time) / 1000);

describe('jump from the shoulders', () => {
  it.each([false, true])('fires once for each hop (hips hidden: %s)', (hipsHidden) => {
    const { jumps } = drive((time) => hop(time, 2000) + hop(time, 5000), 8000, hipsHidden);
    expect(jumps).toHaveLength(2);
  });

  it.each([550, 700, 900])('counts every hop of a non-stop series, one every %i ms', (period) => {
    const series = (time: number) => {
      const since = time - 2000;
      return since >= 0 && since < 6 * period && since % period < 400 ? 0.7 * Math.sin((Math.PI * (since % period)) / 400) : 0;
    };
    const { jumps, speeds } = drive(series, 2000 + 6 * period + 500);
    expect(jumps).toHaveLength(6);
    expect(speeds.every((s) => s.speed === 0)).toBe(true);
  });

  it('does not fire on a running bounce or on standing', () => {
    expect(drive(stride).jumps).toHaveLength(0);
    expect(drive(() => 0).jumps).toHaveLength(0);
  });

  it('fires in the middle of a run, and the runner keeps running through it', () => {
    const { jumps, speeds } = drive((time) => (time > 4000 && time < 4500 ? hop(time, 4000) : stride(time)), 7000);
    expect(jumps).toHaveLength(1);
    expect(speeds.filter((s) => s.time > 2500).every((s) => s.speed > 0)).toBe(true);
  });

  it('does not start the runner after a jump from standing, however the landing wobbles', () => {
    const wobble = (time: number) => (time > 2500 && time < 3300 ? stride(time) : 0);
    expect(drive((time) => hop(time, 2000) + wobble(time), 5000).speeds.every((s) => s.speed === 0)).toBe(true);
  });

  it('ignores the legs and arms', () => {
    const pipeline = new ActionPipeline();
    for (let time = 0; time <= 3000; time += 33) {
      const frame = pose(time, { kneeLeft: time > 2000 ? 0.5 : 0, wristVertical: time > 2000 ? 0.5 : 0 });
      expect(pipeline.update(frame, calibration()).events.some((event) => event.type === 'jump')).toBe(false);
    }
  });
});
