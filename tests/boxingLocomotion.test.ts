import { describe, expect, it } from 'vitest';
import type { CalibrationProfile, ContinuousControls, PoseSnapshot, SportActionEvent } from '../src/cv/protocol';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { DASH_THRESHOLDS, LateralDashTracker } from '../src/kinematics/boxingLocomotion';
import { RingDepthTracker } from '../src/kinematics/postureSignals';
import { calibration, pose } from './fixtures/syntheticPose';

const CORE = [11, 12, 23, 24];

function profile(): CalibrationProfile {
  const base = calibration();
  const first = pose(0);
  return { ...base, image: { ...base.image, shoulderWidth0: first.landmarks[12]!.x - first.landmarks[11]!.x } };
}

/** Resizes the image torso around its center: `width` scales x, `height` scales y. */
function resized(snapshot: PoseSnapshot, width: number, height = width): PoseSnapshot {
  const mean = (axis: 'x' | 'y') => CORE.reduce((sum, index) => sum + snapshot.landmarks[index]![axis], 0) / CORE.length;
  const [x, y] = [mean('x'), mean('y')];
  const landmarks = snapshot.landmarks.map((point, index) => (
    CORE.includes(index) ? { ...point, x: x + (point.x - x) * width, y: y + (point.y - y) * height } : point
  ));
  return { ...snapshot, landmarks };
}

const during = (time: number, from: number, to: number) => time >= from && time < to;

function driveDepth(sizeAt: (time: number) => [width: number, height: number], totalMs: number, punchingAt = (_time: number) => false) {
  const tracker = new RingDepthTracker();
  const trace: { time: number; move: number | undefined; speed: number | undefined }[] = [];
  for (let time = 0; time <= totalMs; time += 33) {
    const move = tracker.update(resized(pose(time), ...sizeAt(time)), profile(), punchingAt(time));
    trace.push({ time, move, speed: tracker.approach01 });
  }
  return trace;
}

describe('ring depth from torso size', () => {
  it.each([[1.3, 1], [0.75, -1]] as const)('reads a step to %f of the calibrated size as move %i with a matching speed sign', (size, move) => {
    const trace = driveDepth((t) => (during(t, 500, 2000) ? [size, size] : [1, 1]), 3000);
    const held = trace.filter((p) => during(p.time, 1200, 2000));
    expect(held.every((p) => p.move === move && Math.sign(p.speed!) === move && Math.abs(p.speed!) <= 1)).toBe(true);
    expect(trace.at(-1)).toMatchObject({ move: 0, speed: 0 });
  });

  it('stays at zero speed inside the dead band and grows with distance outside it', () => {
    for (const size of [1.05, 0.95]) {
      expect(new Set(driveDepth(() => [size, size], 1000).map((p) => p.speed))).toEqual(new Set([0]));
    }
    const speedAt = (size: number) => driveDepth((t) => (t < 500 ? [1, 1] : [size, size]), 1500).at(-1)!.speed!;
    expect(speedAt(1.12)).toBeGreaterThan(0);
    expect(speedAt(1.2)).toBeGreaterThan(speedAt(1.12));
    expect(speedAt(0.8)).toBeLessThan(speedAt(0.88));
    expect(speedAt(1.6)).toBe(1);
  });

  it('does not read shoulders narrowed by yaw as a step back, however long it lasts', () => {
    const trace = driveDepth((t) => (during(t, 500, 1500) ? [0.6, 1] : [1, 1]), 2000);
    // resized() narrows the hips too, but the torso height — what separates yaw from distance — holds.
    expect(new Set(trace.map((p) => p.move))).toEqual(new Set([0]));
    expect(new Set(trace.map((p) => p.speed))).toEqual(new Set([0]));
  });

  it('holds the move and the speed while a punch is in flight', () => {
    const size = (t: number) => (t < 400 ? 1 : t < 1500 ? 1.3 : 0.7);
    const trace = driveDepth(
      (t) => [size(t), size(t)],
      2200,
      (t) => during(t, 1500, 2200),
    );
    const before = trace.filter((p) => p.time < 1500).at(-1)!;
    expect(before.move).toBe(1);
    for (const p of trace.filter((entry) => entry.time >= 1500)) expect(p).toMatchObject({ move: 1, speed: before.speed });
  });

  it('has no opinion without a reference width or with unreadable hips', () => {
    const tracker = new RingDepthTracker();
    expect(tracker.update(pose(0), calibration())).toBeUndefined();
    const snapshot = pose(33);
    const landmarks = snapshot.landmarks.map((point, index) => (index === 23 ? { ...point, y: Number.NaN } : point));
    expect(tracker.update({ ...snapshot, landmarks }, profile())).toBeUndefined();
    expect(tracker.approach01).toBeUndefined();
  });
});

/** Eased lateral motion toward the player's right (negative: left), starting at `atMs`. */
function shiftAt(time: number, atMs: number, distanceSw: number, rampMs: number): number {
  const t = Math.max(0, Math.min(1, (time - atMs) / rampMs));
  return distanceSw * t * t * (3 - 2 * t);
}

function driveDash(shift: (time: number) => number, totalMs: number, stepMs = 33, punchingAt = (_time: number) => false) {
  const tracker = new LateralDashTracker();
  const trace: { time: number; dash: number | undefined }[] = [];
  for (let time = 0; time <= totalMs; time += stepMs) {
    trace.push({ time, dash: tracker.update(pose(time, { shiftUserRightSw: shift(time) }), punchingAt(time)) });
  }
  return trace;
}

/** Each run of consecutive non-zero values. */
function bursts(trace: { time: number; dash: number | undefined }[]) {
  const found: { dash: number; from: number; to: number }[] = [];
  let previous = 0;
  for (const { time, dash = 0 } of trace) {
    if (dash !== 0 && dash === previous) found.at(-1)!.to = time;
    else if (dash !== 0) found.push({ dash, from: time, to: time });
    previous = dash;
  }
  return found;
}

describe('lateral dash', () => {
  it.each([[1, 33], [-1, 33], [1, 66], [-1, 66]] as const)('fires once for a hop toward %i at %i ms per frame', (direction, stepMs) => {
    const found = bursts(driveDash((t) => shiftAt(t, 500, 0.6 * direction, 250), 2000, stepMs));
    expect(found.map((burst) => burst.dash)).toEqual([direction]);
    expect(found[0]!.to - found[0]!.from).toBeLessThan(DASH_THRESHOLDS.holdMs);
    expect(found[0]!.from).toBeLessThan(750);
  });

  it('fires once per hop for a hop out and a later hop back', () => {
    const trace = driveDash((t) => shiftAt(t, 500, 0.6, 250) - shiftAt(t, 1500, 0.6, 250), 2500);
    expect(bursts(trace).map((burst) => burst.dash)).toEqual([1, -1]);
  });

  it('fires once for one long continuous motion', () => {
    expect(bursts(driveDash((t) => shiftAt(t, 500, 3, 1000), 2000)).map((burst) => burst.dash)).toEqual([1]);
  });

  it('ignores a slow sustained lean, a short jerk and a single jumping frame', () => {
    expect(bursts(driveDash((t) => shiftAt(t, 500, 0.6, 1200), 2500))).toEqual([]);
    expect(bursts(driveDash((t) => shiftAt(t, 500, 0.15, 100), 1500))).toEqual([]);
    expect(bursts(driveDash((t) => (during(t, 500, 525) ? 0.8 : 0), 1500))).toEqual([]);
  });

  it('ignores motion made while a punch is in flight', () => {
    expect(bursts(driveDash((t) => shiftAt(t, 500, 0.6, 250), 1500, 33, (t) => during(t, 450, 900)))).toEqual([]);
  });

  it('has no opinion about an unreadable torso', () => {
    const snapshot = pose(0);
    const landmarks = snapshot.landmarks.map((point, index) => (index === 24 ? { ...point, x: Number.NaN } : point));
    expect(new LateralDashTracker().update({ ...snapshot, landmarks })).toBeUndefined();
  });
});

describe('boxing locomotion through ActionPipeline', () => {
  /** Right arm blended from guard (0) to straight toward the camera (1). */
  function rightArm(snapshot: PoseSnapshot, extension: number): PoseSnapshot {
    const world = [...snapshot.worldLandmarks];
    const shoulder = world[12]!;
    const place = (index: number, y0: number, z0: number, y1: number, z1: number) => {
      world[index] = { x: shoulder.x, y: shoulder.y + y0 + (y1 - y0) * extension, z: z0 + (z1 - z0) * extension, visibility: 0.95, presence: 0.95 };
    };
    place(14, 0.28, -0.05, 0.02, -0.3);
    place(16, 0, -0.18, 0.02, -0.58);
    return { ...snapshot, worldLandmarks: world };
  }

  function drive(frame: (time: number) => PoseSnapshot, totalMs: number, calibrated: CalibrationProfile | null = profile()) {
    const pipeline = new ActionPipeline();
    const trace: (ContinuousControls & { time: number })[] = [];
    const events: SportActionEvent[] = [];
    for (let time = 0; time <= totalMs; time += 33) {
      const result = pipeline.update(frame(time), calibrated ?? undefined);
      trace.push({ ...result.controls, time });
      events.push(...result.events);
    }
    return { pipeline, trace, events };
  }

  it('publishes depth and dash once calibrated', () => {
    const { trace } = drive((t) => pose(t, { shiftUserRightSw: shiftAt(t, 500, 0.6, 250) }), 1500);
    expect(trace.at(-1)).toMatchObject({ ringDepthMove: 0, ringDepth01: 0, lateralDash: 0 });
    expect(trace.some((c) => c.lateralDash === 1)).toBe(true);
  });

  it('has no opinion without calibration or a tracked torso', () => {
    const uncalibrated = drive((t) => pose(t), 600, null).trace.at(-1)!;
    const hidden = drive((t) => pose(t, { hiddenLandmarks: [23, 24] }), 600).trace.at(-1)!;
    for (const controls of [uncalibrated, hidden]) {
      expect(controls.ringDepth01).toBeUndefined();
      expect(controls.lateralDash).toBeUndefined();
    }
  });

  it('keeps depth frozen from a punch onset that never confirms until the timeout', () => {
    // The arm only half extends, and the body starts looking smaller one frame into the punch
    // (an instant 30% shrink is outside the physical envelope — it reads as reference-frame
    // motion to the shoulder-drop veto — so the resize no longer lands exactly on the onset).
    const { trace, events } = drive((t) => {
      // A fast partial twitch: quick enough to onset, but it stops at a third of the reach so
      // neither the travel nor the extension bar is ever met — the unconfirmed window the
      // scenario needs. (A slow half-extension used to fail on the old geometric cosine bar;
      // at the production-geometry bar that movement is honestly a punch.)
      const arm = rightArm(pose(t), 0.35 * Math.min(1, Math.max(0, (t - 300) / 100)));
      return t >= 396 ? resized(arm, 0.7) : arm;
    }, 1500);
    const onset = events.find((event) => event.type === 'punch-start')!;
    expect(onset.timestampMs).toBeLessThanOrEqual(363);
    expect(events.some((event) => event.type === 'punch')).toBe(false);
    const frozen = trace.filter((c) => during(c.time, onset.timestampMs, onset.timestampMs + 400));
    expect(frozen.every((c) => c.ringDepthMove === 0 && c.ringDepth01 === 0)).toBe(true);
    expect(trace.at(-1)!.ringDepthMove).toBe(-1);
    expect(trace.at(-1)!.ringDepth01).toBeLessThan(0);
  });

  it('forgets the trackers on reset', () => {
    const { pipeline } = drive((t) => resized(pose(t), t < 300 ? 1 : 1.3), 1500);
    pipeline.reset(1533);
    let controls: ContinuousControls | undefined;
    for (let time = 1533; time <= 1700; time += 33) controls = pipeline.update(pose(time), profile()).controls;
    expect(controls).toMatchObject({ ringDepthMove: 0, ringDepth01: 0, lateralDash: 0 });
  });
});
