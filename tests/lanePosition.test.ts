import { describe, expect, it } from 'vitest';
import { AdaptiveCalibrator } from '../src/cv/adaptiveCalibrator';
import type { CalibrationProfile } from '../src/cv/protocol';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { LanePositionTracker } from '../src/kinematics/postureSignals';
import { pose } from './fixtures/syntheticPose';

/** Smoothly ramps toward each keyframed displacement — bodies accelerate, they don't teleport. */
function shiftAt(timeMs: number, timeline: { atMs: number; shiftSw: number; rampMs?: number }[]): number {
  let value = 0;
  for (const key of timeline) {
    const t = Math.max(0, Math.min(1, (timeMs - key.atMs) / (key.rampMs ?? 400)));
    const ease = t * t * (3 - 2 * t);
    value += (key.shiftSw - value) * ease;
  }
  return value;
}

function driveTracker(timeline: { atMs: number; shiftSw: number; rampMs?: number }[], totalMs: number, stepMs = 33) {
  const tracker = new LanePositionTracker();
  const zoneTrace: { atMs: number; zone: number }[] = [];
  for (let time = 0; time <= totalMs + 1100; time += stepMs) {
    const zone = tracker.update(pose(time, { shiftUserRightSw: shiftAt(time - 1100, timeline) }));
    zoneTrace.push({ atMs: time - 1100, zone: zone ?? 0 });
  }
  return zoneTrace;
}

function zoneExtremes(trace: { zone: number }[]): { min: number; max: number } {
  return { min: Math.min(...trace.map((p) => p.zone)), max: Math.max(...trace.map((p) => p.zone)) };
}

describe('LanePositionTracker', () => {
  it('follows a held right displacement into the right zone and back to center on return', () => {
    const zoneTrace = driveTracker([
      { atMs: 1000, shiftSw: 0.7 },
      { atMs: 2500, shiftSw: 0 },
    ], 4000);
    expect(zoneExtremes(zoneTrace)).toEqual({ min: 0, max: 1 });
    expect(zoneTrace.at(-1)!.zone).toBe(0);
  });

  it('never enters the left zone when the player only leans right, even with overshoot on return', () => {
    // The exact failure mode of the gesture detector: fast lean right, fast return overshooting
    // past center. Position control can at most return to center — never invert.
    const zoneTrace = driveTracker([
      { atMs: 1000, shiftSw: 0.7, rampMs: 250 },
      { atMs: 1800, shiftSw: -0.25, rampMs: 250 },
      { atMs: 2600, shiftSw: 0 },
    ], 3500);
    expect(zoneExtremes(zoneTrace).min).toBe(0);
    expect(zoneTrace.at(-1)!.zone).toBe(0);
  });

  it('reaches the right zone while the body is still out there during a quick dodge', () => {
    const zoneTrace = driveTracker([
      { atMs: 1000, shiftSw: 0.7, rampMs: 250 },
      { atMs: 1500, shiftSw: 0, rampMs: 300 },
    ], 2500);
    const displacedWindow = zoneTrace.filter((p) => p.atMs >= 1000 && p.atMs <= 1500);
    // While the body is out there the zone must already be right — not after the gesture ends.
    expect(Math.max(...displacedWindow.map((p) => p.zone))).toBe(1);
  });

  it('reads a whole-body step to the right as right zone, not just a spine lean', () => {
    // shiftUserRightSw moves the torso core in image space — the same signal a lateral step produces.
    const zoneTrace = driveTracker([{ atMs: 800, shiftSw: 0.8 }], 2500);
    expect(zoneExtremes(zoneTrace).max).toBe(1);
    expect(zoneTrace.at(-1)!.zone).toBe(1); // still out there, still right zone
  });

  it('mirrors the behavior for the left side', () => {
    const zoneTrace = driveTracker([{ atMs: 800, shiftSw: -0.7 }], 2500);
    expect(zoneExtremes(zoneTrace).min).toBe(-1);
    expect(zoneTrace.at(-1)!.zone).toBe(-1);
  });

  it('does not flap zones around noisy center postures', () => {
    const tracker = new LanePositionTracker();
    const zones = new Set<number>();
    for (let time = 0; time <= 3000; time += 33) {
      const jitter = Math.sin(time / 61) * 0.15; // sub-threshold sway, ±0.15 shoulder widths
      zones.add(tracker.update(pose(time, { shiftUserRightSw: time < 1100 ? 0 : jitter })) ?? 0);
    }
    expect([...zones]).toEqual([0]);
  });

  it('treats a frame with non-finite shoulder coordinates as unreadable without poisoning the filter', () => {
    const tracker = new LanePositionTracker();
    const base = pose(0);
    const nanPose = { ...base, landmarks: base.landmarks.map((point, index) => (index === 11 ? { ...point, x: Number.NaN } : point)) };

    for (let time = 0; time <= 1089; time += 33) tracker.update(pose(time));
    expect(tracker.update({ ...nanPose, timestampMs: 1122 })).toBeUndefined();
    let zone = 0;
    for (let time = 1155; time <= 1450; time += 33) zone = tracker.update(pose(time, { shiftUserRightSw: 0.7 })) ?? zone;
    expect(zone).toBe(1);
  });

  it('waits for the player to stand still before choosing the center', () => {
    const tracker = new LanePositionTracker();
    // Walking into position, then standing 0.8 sw to the right of where the walk started.
    for (let time = 0; time <= 1500; time += 33) expect(tracker.update(pose(time, { shiftUserRightSw: (time / 1500) * 0.8 }))).toBeUndefined();
    let zone: number | undefined;
    for (let time = 1533; time <= 3000; time += 33) zone = tracker.update(pose(time, { shiftUserRightSw: 0.8 }));
    expect(zone).toBe(0);
  });
});

describe('aspect-corrected shoulder width', () => {
  // Rotate the two shoulder landmarks around their center within the image plane. Rotation is
  // done in pixel units — x and y landmarks are normalized independently, so a naive rotation in
  // normalized coordinates would shear the pose instead of tilting it.
  const tiltShoulders = (snapshot: ReturnType<typeof pose>, tiltDeg: number) => {
    const tilt = (tiltDeg * Math.PI) / 180;
    const aspect = snapshot.frameWidth / snapshot.frameHeight;
    const landmarks = snapshot.landmarks.map((point, index) => {
      if (index !== 11 && index !== 12) return point;
      const cx = (snapshot.landmarks[11]!.x + snapshot.landmarks[12]!.x) / 2;
      const cy = (snapshot.landmarks[11]!.y + snapshot.landmarks[12]!.y) / 2;
      const dx = point.x - cx;
      const dy = point.y - cy;
      return { ...point, x: cx + dx * Math.cos(tilt) - (dy * Math.sin(tilt)) / aspect, y: cy + dx * Math.sin(tilt) * aspect + dy * Math.cos(tilt) };
    });
    return { ...snapshot, landmarks };
  };

  it('keeps a marginal displacement inside the lane at every in-plane shoulder tilt', () => {
    // x and y are normalized by frame width and height independently, so a raw hypot would let a
    // tilted shoulder line measure wider than a horizontal one — deflating sensitivity exactly
    // while the player leans. The step here is marginal on purpose: 0.37sw corrected still
    // crosses the 0.35sw entry at any tilt, but the ~31% width inflation of a raw hypot at 35°
    // would deflate it to ~0.28sw and the runner would never leave the center.
    const measure = (tiltDeg: number) => {
      const tracker = new LanePositionTracker();
      for (let time = 0; time <= 1100; time += 33) tracker.update(pose(time));
      let zone: -1 | 0 | 1 = 0;
      for (let time = 1133; time <= 1700; time += 33) {
        zone = tracker.update(tiltShoulders(pose(time, { shiftUserRightSw: 0.37 }), tiltDeg)) ?? zone;
      }
      return zone;
    };
    for (const tiltDeg of [0, 15, 25, 35]) expect(measure(tiltDeg)).toBe(1);
  });
});

describe('lane position control through the real pipeline and calibrator', () => {
  function drivePipeline(timeline: { atMs: number; shiftSw: number; rampMs?: number }[], totalMs: number) {
    const calibrator = new AdaptiveCalibrator();
    const pipeline = new ActionPipeline();
    let profile: CalibrationProfile | undefined;
    const zoneTrace: { atMs: number; zone: number | undefined }[] = [];
    for (let time = 0; time <= totalMs; time += 33) {
      const snapshot = pose(time, { shiftUserRightSw: shiftAt(time, timeline) });
      // The exact App.tsx wiring: every frame is calibration evidence first — with the lane zone
      // as context — control input second.
      profile = calibrator.update(snapshot, pipeline.laneZone) ?? profile;
      const result = pipeline.update(snapshot, profile);
      zoneTrace.push({ atMs: time, zone: result.controls.laneZone });
    }
    return { zoneTrace, profile };
  }

  function lanes(zoneTrace: { zone: number | undefined }[]): number[] {
    return zoneTrace.filter((p) => p.zone !== undefined).map((p) => p.zone!);
  }

  it('converges calibration and follows the player into the right lane', () => {
    const { zoneTrace } = drivePipeline([
      { atMs: 4000, shiftSw: 0.7 },
      { atMs: 6000, shiftSw: 0 },
    ], 8000);
    expect(Math.max(...lanes(zoneTrace))).toBe(1);
    expect(Math.min(...lanes(zoneTrace))).toBe(0);
    expect(zoneTrace.at(-1)!.zone).toBe(0);
  });

  it.each([8, 15, 30])('does not chase a %i s held lane position into the neutral reference', (holdS) => {
    // Holding the right lane is how position control is played — even a 30 s hold must not move
    // neutral, and the return to center must land back in the center zone, never the opposite one.
    const holdMs = holdS * 1000;
    const { zoneTrace, profile } = drivePipeline([
      { atMs: 4000, shiftSw: 0.7, rampMs: 0 },
      { atMs: 4000 + holdMs, shiftSw: 0, rampMs: 0 },
    ], 4000 + holdMs + 4000);
    const held = zoneTrace.filter((p) => p.atMs >= 4000 + holdMs / 2 && p.atMs < 4000 + holdMs);
    expect(Math.min(...held.map((p) => p.zone ?? 0))).toBe(1); // zone never dropped back while held
    expect(Math.abs(profile!.image.shoulderCenterX0 - 0.5)).toBeLessThan(0.005);
    expect(zoneTrace.at(-1)!.zone).toBe(0);
    expect(Math.min(...lanes(zoneTrace))).toBe(0); // never inverted, even on return
  });

  it.each([0.4, 0.5])('does not chase a shallow %f sw hold either', (shiftSw) => {
    // Regression for the shallow-hold hole: a displacement just past the lane-enter threshold is
    // an active lane, so it must contribute zero posture evidence even though it is small.
    const { zoneTrace, profile } = drivePipeline([
      { atMs: 4000, shiftSw, rampMs: 0 },
      { atMs: 34000, shiftSw: 0, rampMs: 0 },
    ], 38000);
    const held = zoneTrace.filter((p) => p.atMs >= 20000 && p.atMs < 34000);
    expect(Math.min(...held.map((p) => p.zone ?? 0))).toBe(1); // lane held all the way through
    expect(zoneTrace.at(-1)!.zone).toBe(0);
    expect(Math.abs(profile!.image.shoulderCenterX0 - 0.5)).toBeLessThan(0.005);
  });

  it('a player who only ever leans right never ends up in the left lane', () => {
    const { zoneTrace } = drivePipeline([
      { atMs: 4000, shiftSw: 0.7, rampMs: 250 },
      { atMs: 4800, shiftSw: -0.15, rampMs: 250 }, // snap-back overshoot past center
      { atMs: 5600, shiftSw: 0 },
      { atMs: 7000, shiftSw: 0.7, rampMs: 250 },
      { atMs: 7800, shiftSw: 0, rampMs: 300 },
    ], 9500);
    expect(Math.min(...lanes(zoneTrace))).toBe(0);
  });

  it('alternating dodge gameplay tracks both lanes and returns to center at rest', () => {
    const timeline = [
      { atMs: 4000, shiftSw: 0.7, rampMs: 250 }, // dodge right
      { atMs: 6000, shiftSw: 0, rampMs: 300 },
      { atMs: 8000, shiftSw: -0.7, rampMs: 250 }, // dodge left
      { atMs: 10000, shiftSw: 0, rampMs: 300 },
      { atMs: 12000, shiftSw: 0.7, rampMs: 250 }, // dodge right again
      { atMs: 14000, shiftSw: 0, rampMs: 300 },
    ];
    const { zoneTrace, profile } = drivePipeline(timeline, 16000);
    expect(Math.min(...lanes(zoneTrace))).toBe(-1);
    expect(Math.max(...lanes(zoneTrace))).toBe(1);
    expect(zoneTrace.at(-1)!.zone).toBe(0);
    expect(Math.abs(profile!.image.shoulderCenterX0 - 0.5)).toBeLessThan(0.005);
  });
});
