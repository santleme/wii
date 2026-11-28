import { describe, expect, it } from 'vitest';
import type { PoseSnapshot } from '../src/cv/protocol';
import { DuckTracker, ENTER_DUCK_SW } from '../src/kinematics/postureSignals';
import { pose } from './fixtures/syntheticPose';

/** Drops (or raises) both shoulders in the image by `dy` frame-height units. */
function shifted(snapshot: PoseSnapshot, dy: number): PoseSnapshot {
  const landmarks = snapshot.landmarks.map((point, index) => (
    index === 11 || index === 12 ? { ...point, y: point.y + dy } : point
  ));
  return { ...snapshot, landmarks };
}

/** Image shoulder width 0.14, aspect 0.5625: a drop of `sw` shoulder widths is this much image y. */
const DROP_PER_SW = 0.14 / 0.5625;

function drive(dropAt: (time: number) => number, totalMs: number, punchingAt: (time: number) => boolean = () => false) {
  const tracker = new DuckTracker();
  const trace: { time: number; ducked: boolean | undefined }[] = [];
  for (let time = 0; time <= totalMs; time += 33) {
    trace.push({ time, ducked: tracker.update(shifted(pose(time), dropAt(time) * DROP_PER_SW), punchingAt(time)) });
  }
  return trace;
}

const during = (time: number, from: number, to: number) => time >= from && time < to;

describe('DuckTracker', () => {
  it('has no opinion before the player has stood still long enough for a baseline', () => {
    const trace = drive(() => 0, 700);
    expect(new Set(trace.map((p) => p.ducked))).toEqual(new Set([undefined]));
  });

  it('enters a duck on a deep drop and exits on standing back up', () => {
    const trace = drive((t) => (during(t, 1500, 2500) ? 0.3 : 0), 3500);
    expect(trace.filter((p) => during(p.time, 1000, 1450)).every((p) => p.ducked === false)).toBe(true);
    const ducked = trace.filter((p) => during(p.time, 1800, 2450));
    expect(ducked.every((p) => p.ducked === true)).toBe(true);
    expect(trace.at(-1)!.ducked).toBe(false);
  });

  it('ignores a dip smaller than the enter threshold', () => {
    const trace = drive((t) => (during(t, 1500, 2500) ? ENTER_DUCK_SW * 0.7 : 0), 3500);
    expect(trace.filter((p) => p.time > 1000).every((p) => p.ducked === false)).toBe(true);
  });

  it('holds the state while a punch is in flight', () => {
    const tracker = new DuckTracker();
    for (let time = 0; time <= 1200; time += 33) tracker.update(pose(time));
    // Punch starts as the player dips: the dip is punched-in noise, not a duck.
    const dipped = shifted(pose(1300), 0.4 * DROP_PER_SW);
    expect(tracker.update(dipped, true)).toBe(false);
    expect(tracker.update(shifted(pose(1333), 0.4 * DROP_PER_SW), true)).toBe(false);
  });

  it('a held duck never drags the baseline down and erases itself', () => {
    const trace = drive((t) => (t >= 1500 ? 0.3 : 0), 6000);
    expect(trace.at(-1)!.ducked).toBe(true);
  });
});
