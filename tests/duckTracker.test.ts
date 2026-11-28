import { describe, expect, it } from 'vitest';
import type { PoseSnapshot } from '../src/cv/protocol';
import { DuckTracker } from '../src/kinematics/postureSignals';
import { pose } from './fixtures/syntheticPose';

/**
 * A duck pose: hips dropped in the image (negative hipRise lowers them in frame) and the torso
 * pitched forward in world landmarks — the two channels the detector ANDs, per the validated
 * design: weaves pitch without dropping, camera-lean drops without pitching.
 */
function duckPose(time: number, hipDrop: number, pitchForward: number): PoseSnapshot {
  const snapshot = pose(time, { hipRise: -hipDrop });
  const world = snapshot.worldLandmarks.map((point, index) => (
    index === 11 || index === 12 ? { ...point, z: point.z - pitchForward } : point
  ));
  return { ...snapshot, worldLandmarks: world };
}

/** Fixture geometry: shoulders 0.4 world units above hips, so this z offset pitches atan2(z, 0.4). */
const PITCHED = Math.tan(25 * Math.PI / 180) * 0.4; // 25° of forward pitch
/** hipRise units: hipRise -0.4 drops the hips 0.16 image units, 0.33 of the 0.48 torso length. */
const DROPPED = 0.4;

function drive(dropPitchAt: (time: number) => [number, number], totalMs: number, punchingAt: (time: number) => boolean = () => false) {
  const tracker = new DuckTracker();
  const trace: { time: number; ducked: boolean | undefined }[] = [];
  for (let time = 0; time <= totalMs; time += 33) {
    const [drop, pitch] = dropPitchAt(time);
    trace.push({ time, ducked: tracker.update(duckPose(time, drop, pitch), punchingAt(time)) });
  }
  return trace;
}

const during = (time: number, from: number, to: number) => time >= from && time < to;

describe('DuckTracker', () => {
  it('has no opinion while the rolling baseline is still warming up', () => {
    const trace = drive(() => [0, 0], 1500);
    expect(new Set(trace.map((p) => p.ducked))).toEqual(new Set([undefined]));
  });

  it('enters a duck when the hips drop and the torso pitches, and exits on standing back up', () => {
    const trace = drive((t) => (during(t, 2500, 3500) ? [DROPPED, PITCHED] : [0, 0]), 5000);
    expect(trace.filter((p) => during(p.time, 2000, 2450)).every((p) => p.ducked === false)).toBe(true);
    const ducked = trace.filter((p) => during(p.time, 2700, 3450));
    expect(ducked.length).toBeGreaterThan(0);
    expect(ducked.every((p) => p.ducked === true)).toBe(true);
    expect(trace.at(-1)!.ducked).toBe(false);
  });

  it('rejects a hip drop without forward pitch — leaning toward the camera is not a duck', () => {
    const trace = drive((t) => (during(t, 2500, 3500) ? [DROPPED, 0] : [0, 0]), 5000);
    expect(trace.filter((p) => p.time > 2000).every((p) => p.ducked === false)).toBe(true);
  });

  it('rejects forward pitch without a hip drop — a lateral weave is not a duck', () => {
    const trace = drive((t) => (during(t, 2500, 3500) ? [0, PITCHED] : [0, 0]), 5000);
    expect(trace.filter((p) => p.time > 2000).every((p) => p.ducked === false)).toBe(true);
  });

  it('needs both channels for consecutive frames — a one-frame spike does not enter', () => {
    const trace = drive((t) => (during(t, 2500, 2532) ? [DROPPED, PITCHED] : [0, 0]), 5000);
    expect(trace.filter((p) => p.time > 2000).every((p) => p.ducked === false)).toBe(true);
  });

  it('holds the state while a punch is in flight', () => {
    const tracker = new DuckTracker();
    for (let time = 0; time <= 2500; time += 33) tracker.update(duckPose(time, 0, 0));
    expect(tracker.update(duckPose(2533, DROPPED, PITCHED), true)).toBe(false);
  });

  it('a held duck never drags the baseline down and erases itself', () => {
    const trace = drive((t) => (t >= 2500 ? [DROPPED, PITCHED] : [0, 0]), 7000);
    expect(trace.at(-1)!.ducked).toBe(true);
  });
});
