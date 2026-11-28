import { describe, expect, it } from 'vitest';
import { AdaptiveCalibrator } from '../src/cv/adaptiveCalibrator';
import type { CalibrationProfile } from '../src/cv/protocol';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { DodgeZoneTracker, EXIT_DODGE_SW, RingDepthTracker } from '../src/kinematics/postureSignals';
import { calibration, pose } from './fixtures/syntheticPose';

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
  const tracker = new DodgeZoneTracker();
  const zoneTrace: { atMs: number; zone: number }[] = [];
  for (let time = 0; time <= totalMs; time += stepMs) {
    const zone = tracker.update(pose(time, { shiftUserRightSw: shiftAt(time, timeline) }), calibration());
    zoneTrace.push({ atMs: time, zone: zone ?? 0 });
  }
  return zoneTrace;
}

function zoneExtremes(trace: { zone: number }[]): { min: number; max: number } {
  return { min: Math.min(...trace.map((p) => p.zone)), max: Math.max(...trace.map((p) => p.zone)) };
}

describe('DodgeZoneTracker', () => {
  it('follows a held right displacement into the right zone and back to center on return', () => {
    const zoneTrace = driveTracker([
      { atMs: 1000, shiftSw: 0.3 },
      { atMs: 2500, shiftSw: 0 },
    ], 4000);
    expect(zoneExtremes(zoneTrace)).toEqual({ min: 0, max: 1 });
    expect(zoneTrace.at(-1)!.zone).toBe(0);
  });

  it('never enters the left zone when the player only leans right, even with overshoot on return', () => {
    // The exact failure mode of the gesture detector: fast lean right, fast return overshooting
    // past center. Position control can at most return to center — never invert.
    const zoneTrace = driveTracker([
      { atMs: 1000, shiftSw: 0.3, rampMs: 250 },
      { atMs: 1800, shiftSw: -0.09, rampMs: 250 },
      { atMs: 2600, shiftSw: 0 },
    ], 3500);
    expect(zoneExtremes(zoneTrace).min).toBe(0);
    expect(zoneTrace.at(-1)!.zone).toBe(0);
  });

  it('reaches the right zone while the body is still out there during a quick dodge', () => {
    const zoneTrace = driveTracker([
      { atMs: 1000, shiftSw: 0.3, rampMs: 250 },
      { atMs: 1500, shiftSw: 0, rampMs: 300 },
    ], 2500);
    const displacedWindow = zoneTrace.filter((p) => p.atMs >= 1000 && p.atMs <= 1500);
    // While the body is out there the zone must already be right — not after the gesture ends.
    expect(Math.max(...displacedWindow.map((p) => p.zone))).toBe(1);
  });

  it('reads a whole-body step to the right as right zone, not just a spine lean', () => {
    // shiftUserRightSw moves the torso core in image space — the same signal a lateral step produces.
    const zoneTrace = driveTracker([{ atMs: 800, shiftSw: 0.5 }], 2500);
    expect(zoneExtremes(zoneTrace).max).toBe(1);
    expect(zoneTrace.at(-1)!.zone).toBe(1); // still out there, still right zone
  });

  it('mirrors the behavior for the left side', () => {
    const zoneTrace = driveTracker([{ atMs: 800, shiftSw: -0.3 }], 2500);
    expect(zoneExtremes(zoneTrace).min).toBe(-1);
    expect(zoneTrace.at(-1)!.zone).toBe(-1);
  });

  it('does not flap zones around noisy center postures', () => {
    const tracker = new DodgeZoneTracker();
    const zones = new Set<number>();
    for (let time = 0; time <= 3000; time += 33) {
      const jitter = Math.sin(time / 61) * 0.03; // sub-threshold noise, ±0.03 shoulder widths
      zones.add(tracker.update(pose(time, { shiftUserRightSw: jitter }), calibration()) ?? 0);
    }
    expect([...zones]).toEqual([0]);
  });

  it('treats a frame with non-finite shoulder coordinates as unreadable without poisoning the filter', () => {
    const tracker = new DodgeZoneTracker();
    const profile = calibration();
    const base = pose(0);
    const nanPose = { ...base, landmarks: base.landmarks.map((point, index) => (index === 11 ? { ...point, x: Number.NaN } : point)) };

    for (let time = 0; time <= 99; time += 33) expect(tracker.update(pose(time), profile)).toBe(0);
    expect(tracker.update({ ...nanPose, timestampMs: 132 }, profile)).toBeUndefined();
    let zone = 0;
    for (let time = 165; time <= 396; time += 33) {
      zone = tracker.update(pose(time, { shiftUserRightSw: 0.3 }), profile) ?? zone;
    }
    expect(zone).toBe(1);
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
    // while the player leans. The step here is marginal on purpose: 0.13sw corrected still
    // crosses the 0.12sw entry at any tilt, but the ~31% width inflation of a raw hypot at 35°
    // would deflate it to ~0.10sw and the runner would never leave the center.
    const measure = (tiltDeg: number) => {
      const tracker = new DodgeZoneTracker();
      for (let time = 0; time <= 1000; time += 33) tracker.update(pose(time), calibration());
      let zone: -1 | 0 | 1 = 0;
      for (let time = 1033; time <= 1300; time += 33) {
        zone = tracker.update(tiltShoulders(pose(time, { shiftUserRightSw: 0.13 }), tiltDeg), calibration()) ?? zone;
      }
      return zone;
    };
    for (const tiltDeg of [0, 15, 25, 35]) expect(measure(tiltDeg)).toBe(1);
  });
});

describe('torso yaw while punching', () => {
  /** Yaw foreshortens the 2D shoulder line to `widthRatio` and nudges its center sideways. */
  const turned = (timeMs: number, widthRatio: number, shiftSw: number) => {
    const snapshot = pose(timeMs, { shiftUserRightSw: shiftSw });
    const center = (snapshot.landmarks[11]!.x + snapshot.landmarks[12]!.x) / 2;
    const landmarks = snapshot.landmarks.map((point, index) =>
      index === 11 || index === 12 ? { ...point, x: center + (point.x - center) * widthRatio } : point);
    return { ...snapshot, landmarks };
  };

  const zonesWhileTurning = (shiftSw: number) => {
    const tracker = new DodgeZoneTracker();
    for (let time = 0; time <= 990; time += 33) tracker.update(pose(time), calibration());
    const zones = new Set<number>();
    for (let time = 1023; time <= 1500; time += 33) {
      zones.add(tracker.update(turned(time, 0.5, shiftSw), calibration()) ?? 0);
    }
    return [...zones];
  };

  it.each([0.08, -0.08])('does not read a %f sw nudge with foreshortened shoulders as a dodge', (shiftSw) => {
    expect(zonesWhileTurning(shiftSw)).toEqual([0]);
  });

  it('still follows a real lean made while turned', () => {
    expect(zonesWhileTurning(0.3)).toContain(1);
  });

  it('regains full sensitivity after the player stays farther from the camera', () => {
    const tracker = new DodgeZoneTracker();
    for (let time = 0; time <= 990; time += 33) tracker.update(pose(time), calibration());
    for (let time = 1023; time <= 15000; time += 33) tracker.update(turned(time, 0.6, 0), calibration());
    let zone: number | undefined;
    // 0.08 neutral widths is 0.133 of the new, narrower shoulders: past the 0.12 entry.
    for (let time = 15033; time <= 16000; time += 33) zone = tracker.update(turned(time, 0.6, 0.08), calibration());
    expect(zone).toBe(1);
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
      profile = calibrator.update(snapshot, pipeline.dodgeZone, EXIT_DODGE_SW) ?? profile;
      const result = pipeline.update(snapshot, profile);
      zoneTrace.push({ atMs: time, zone: result.controls.dodgeZone });
    }
    return { zoneTrace, profile };
  }

  function lanes(zoneTrace: { zone: number | undefined }[]): number[] {
    return zoneTrace.filter((p) => p.zone !== undefined).map((p) => p.zone!);
  }

  it('converges calibration and follows the player into the right lane', () => {
    const { zoneTrace } = drivePipeline([
      { atMs: 4000, shiftSw: 0.3 },
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
      { atMs: 4000, shiftSw: 0.3, rampMs: 0 },
      { atMs: 4000 + holdMs, shiftSw: 0, rampMs: 0 },
    ], 4000 + holdMs + 4000);
    const held = zoneTrace.filter((p) => p.atMs >= 4000 + holdMs / 2 && p.atMs < 4000 + holdMs);
    expect(Math.min(...held.map((p) => p.zone ?? 0))).toBe(1); // zone never dropped back while held
    expect(Math.abs(profile!.image.shoulderCenterX0 - 0.5)).toBeLessThan(0.005);
    expect(zoneTrace.at(-1)!.zone).toBe(0);
    expect(Math.min(...lanes(zoneTrace))).toBe(0); // never inverted, even on return
  });

  it.each([0.13, 0.2])('does not chase a shallow %f sw hold either — the admission gate clears the lane band', (shiftSw) => {
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

  it('adapts to a small sustained stance shift so dodges away from it still reach the lane', () => {
    // Regression for the hysteresis-band hole: settling 0.07 sw right of center never enters a
    // lane, so it is stance rather than control — the reference must follow it, or a leftward
    // dodge measured from the stale center falls short of the left lane.
    const { zoneTrace, profile } = drivePipeline([
      { atMs: 5000, shiftSw: 0.07, rampMs: 500 },
      { atMs: 28000, shiftSw: -0.08, rampMs: 300 }, // 0.15 sw dodge left from the shifted stance
      { atMs: 29500, shiftSw: 0.07, rampMs: 400 },
    ], 31000);
    const duringDodge = zoneTrace.filter((p) => p.atMs >= 28100 && p.atMs <= 29400);
    expect(Math.min(...duringDodge.map((p) => p.zone ?? 0))).toBe(-1);
    // And the shift is stance, not a lane: while settled, the zone stays center.
    const settled = zoneTrace.filter((p) => p.atMs >= 15000 && p.atMs <= 27000);
    expect(settled.every((p) => p.zone === 0 || p.zone === undefined)).toBe(true);
    void profile;
  });

  it('a player who only ever leans right never ends up in the left lane', () => {
    const { zoneTrace } = drivePipeline([
      { atMs: 4000, shiftSw: 0.3, rampMs: 250 },
      { atMs: 4800, shiftSw: -0.06, rampMs: 250 }, // snap-back overshoot past center
      { atMs: 5600, shiftSw: 0 },
      { atMs: 7000, shiftSw: 0.3, rampMs: 250 },
      { atMs: 7800, shiftSw: 0, rampMs: 300 },
    ], 9500);
    expect(Math.min(...lanes(zoneTrace))).toBe(0);
  });

  it('alternating dodge gameplay tracks both lanes and returns to center at rest', () => {
    const timeline = [
      { atMs: 4000, shiftSw: 0.3, rampMs: 250 }, // dodge right
      { atMs: 6000, shiftSw: 0, rampMs: 300 },
      { atMs: 8000, shiftSw: -0.3, rampMs: 250 }, // dodge left
      { atMs: 10000, shiftSw: 0, rampMs: 300 },
      { atMs: 12000, shiftSw: 0.3, rampMs: 250 }, // dodge right again
      { atMs: 14000, shiftSw: 0, rampMs: 300 },
    ];
    const { zoneTrace, profile } = drivePipeline(timeline, 16000);
    expect(Math.min(...lanes(zoneTrace))).toBe(-1);
    expect(Math.max(...lanes(zoneTrace))).toBe(1);
    expect(zoneTrace.at(-1)!.zone).toBe(0);
    expect(Math.abs(profile!.image.shoulderCenterX0 - 0.5)).toBeLessThan(0.005);
  });
});

describe('RingDepthTracker', () => {
  const profile = (): CalibrationProfile => {
    const base = calibration();
    const first = pose(0);
    const width = Math.abs(first.landmarks[11]!.x - first.landmarks[12]!.x);
    return { ...base, image: { ...base.image, shoulderWidth0: width } };
  };
  /** The same pose with the whole torso `ratio` times the calibrated size, as a step in depth does. */
  const scaled = (timeMs: number, ratio: number) => {
    const snapshot = pose(timeMs);
    const core = [11, 12, 23, 24];
    const mean = (axis: 'x' | 'y') => core.reduce((sum, index) => sum + snapshot.landmarks[index]![axis], 0) / core.length;
    const [x, y] = [mean('x'), mean('y')];
    const landmarks = snapshot.landmarks.map((point, index) => (
      core.includes(index) ? { ...point, x: x + (point.x - x) * ratio, y: y + (point.y - y) * ratio } : point
    ));
    return { ...snapshot, landmarks };
  };
  const drive = (ratioAt: (timeMs: number) => number, totalMs: number, speeds: number[] = []) => {
    const tracker = new RingDepthTracker();
    const trace: number[] = [];
    for (let time = 0; time <= totalMs; time += 33) {
      trace.push(tracker.update(scaled(time, ratioAt(time)), profile())!);
      speeds.push(tracker.approach01 ?? 0);
    }
    return trace;
  };

  it('reads a held step in either direction and releases it on return', () => {
    for (const [ratio, move] of [[1.3, 1], [0.75, -1]] as const) {
      const trace = drive((t) => (t > 500 && t < 2000 ? ratio : 1), 3000);
      expect(new Set(trace)).toEqual(new Set([0, move]));
      expect(trace.at(-1)).toBe(0);
    }
  });

  it('ignores a standing player and a brief change of apparent size', () => {
    expect(new Set(drive((t) => (t % 66 === 0 ? 1.05 : 0.95), 2000))).toEqual(new Set([0]));
    const speeds: number[] = [];
    expect(new Set(drive((t) => (t > 500 && t < 700 ? 0.7 : 1), 2000, speeds))).toEqual(new Set([0]));
    expect(new Set(speeds)).toEqual(new Set([0]));
  });

  it('does not count a punch freeze as time spent stepped away', () => {
    const tracker = new RingDepthTracker();
    const speeds: number[] = [];
    for (let time = 0; time <= 2000; time += 33) {
      const leaning = time >= 500 && time < 1200; // short lean, a 500 ms punch, short lean again
      const punching = time >= 600 && time < 1100;
      tracker.update(scaled(time, leaning ? 0.75 : 1), profile(), punching);
      speeds.push(tracker.approach01 ?? 0);
    }
    expect(new Set(speeds)).toEqual(new Set([0]));
  });

  it('has no opinion without a reference width', () => {
    expect(new RingDepthTracker().update(pose(0), calibration())).toBeUndefined();
  });
});
