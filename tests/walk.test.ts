import { describe, expect, it } from 'vitest';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { gaitFor } from '../src/games/track/gait';
import { calibration, pose } from './fixtures/syntheticPose';

function drive(frame: (time: number) => ReturnType<typeof pose>, until = 6000) {
  const pipeline = new ActionPipeline();
  const results = [];
  for (let time = 0; time <= until; time += 33) results.push({ time, ...pipeline.update(frame(time), calibration()) });
  return results;
}

// One weight shift per step: a full side-to-side cycle every two steps.
const sway = (time: number, amplitudeSw = 0.1) => amplitudeSw * Math.sin((2 * Math.PI * time) / 1100);

describe('walking from the side-to-side weight shift', () => {
  it('walks, never runs, while the shoulders sway without bouncing', () => {
    const results = drive((time) => pose(time, { shiftUserRightSw: sway(time) }));
    const settled = results.filter((r) => r.time > 3000);
    expect(settled.every((r) => gaitFor(r.controls.sprintSpeed01, 'idle') === 'walk')).toBe(true);
    expect(results.flatMap((r) => r.events).filter((event) => event.type === 'step').length).toBeGreaterThan(3);
  });

  it('walks faster when the weight shifts faster, without ever reading as running', () => {
    const speedAt = (cycleMs: number) => {
      const last = drive((time) => pose(time, { shiftUserRightSw: 0.1 * Math.sin((2 * Math.PI * time) / cycleMs) }), 9000).at(-1)!;
      return last.controls.sprintSpeed01;
    };
    expect(speedAt(900)).toBeGreaterThan(speedAt(1500));
    expect(gaitFor(speedAt(750), 'idle')).toBe('walk');
  });

  it('stops soon after the sway stops', () => {
    const results = drive((time) => pose(time, { shiftUserRightSw: time < 4000 ? sway(time) : 0 }), 7000);
    expect(results.filter((r) => r.time > 5500).every((r) => r.controls.sprintSpeed01 === 0)).toBe(true);
  });

  it.each([
    ['a held step into a lane', (time: number) => (time > 2000 ? 0.8 : 0)],
    ['a slight sway', (time: number) => sway(time, 0.04)],
    ['dodging between lanes', (time: number) => sway(time, 0.8)],
  ])('does not walk for %s', (_name, shift) => {
    expect(drive((time) => pose(time, { shiftUserRightSw: shift(time) })).every((r) => r.controls.sprintSpeed01 === 0)).toBe(true);
  });

  it('does not call it a jump when the shoulders lift under a still head', () => {
    const results = drive((time) => {
      const lift = time > 2000 && time < 2500 ? 0.17 * Math.sin((Math.PI * (time - 2000)) / 500) : 0;
      const base = pose(time);
      return { ...base, landmarks: base.landmarks.map((point, index) => (index === 11 || index === 12 ? { ...point, y: point.y - lift } : point)) };
    });
    expect(results.flatMap((r) => r.events).filter((event) => event.type === 'jump')).toHaveLength(0);
  });
});
