import { describe, expect, it } from 'vitest';
import type { Hand, Point3, PoseSnapshot } from '../src/cv/protocol';
import { bodyLocalPoint } from '../src/kinematics/bodyFrame';
import { isGuardingPose, PunchDetector, type PunchOutput } from '../src/kinematics/punchDetector';
import { calibration, pose } from './fixtures/syntheticPose';

/** Elbow and wrist offsets from the shoulder, in world metres; -z is toward the camera. */
interface Arm { elbow: Point3; wrist: Point3 }

// The chambered position punches start from. Not a literal face-covering guard — punch
// dynamics tests only need a bent-arm start pose.
const GUARD: Arm = { elbow: { x: 0, y: 0.28, z: -0.05 }, wrist: { x: 0, y: 0, z: -0.18 } };
// A real blocking guard: fist up at cheek level near the nose (which sits at y0), elbow dropped by the ribs.
const CHIN_GUARD: Arm = { elbow: { x: 0.05, y: -0.1, z: -0.02 }, wrist: { x: -0.14, y: 0.32, z: -0.12 } };
const STRAIGHT: Arm = { elbow: { x: 0, y: 0.02, z: -0.3 }, wrist: { x: 0, y: 0.02, z: -0.58 } };
const HANGING: Arm = { elbow: { x: 0, y: 0.3, z: 0 }, wrist: { x: 0, y: 0.58, z: 0 } };
const SIDEWAYS: Arm = { elbow: { x: 0.3, y: 0, z: 0 }, wrist: { x: 0.58, y: 0, z: 0 } };

function mix(from: Arm, to: Arm, amount: number): Arm {
  const lerp = (a: Point3, b: Point3) => ({
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
    z: a.z + (b.z - a.z) * amount,
  });
  return { elbow: lerp(from.elbow, to.elbow), wrist: lerp(from.wrist, to.wrist) };
}

/** The shared fixture leaves the elbows at the origin, so both arms are rebuilt here. */
function armPose(time: number, arms: Partial<Record<Hand, Arm>> = {}): PoseSnapshot {
  const snapshot = pose(time);
  const world = [...snapshot.worldLandmarks];
  for (const [hand, shoulder, elbow, wrist, outward] of [['left', 11, 13, 15, 1], ['right', 12, 14, 16, -1]] as const) {
    const arm = arms[hand] ?? GUARD;
    for (const [index, offset] of [[elbow, arm.elbow], [wrist, arm.wrist]] as const) {
      world[index] = {
        ...world[index]!,
        x: world[shoulder]!.x + offset.x * outward,
        y: world[shoulder]!.y + offset.y,
        z: world[shoulder]!.z + offset.z,
      };
    }
  }
  return { ...snapshot, worldLandmarks: world };
}

/** Piecewise-linear arm motion through [time, arm] keyframes. */
function at(keys: readonly [number, Arm][], time: number): Arm {
  const next = keys.findIndex(([keyTime]) => keyTime >= time);
  if (next === -1) return keys.at(-1)![1];
  if (next === 0) return keys[0]![1];
  const [startTime, start] = keys[next - 1]!;
  const [endTime, end] = keys[next]!;
  return mix(start, end, (time - startTime) / (endTime - startTime));
}

function run(
  detector: PunchDetector,
  keys: readonly [number, Arm][],
  { fps = 30, from = 0, to = keys.at(-1)![0], hand = 'right' as Hand, phaseMs = 0 } = {},
): PunchOutput[] {
  const outputs: PunchOutput[] = [];
  for (let frame = 0; from + phaseMs + (frame * 1000) / fps <= to; frame += 1) {
    const time = from + phaseMs + (frame * 1000) / fps;
    const output = detector.update(armPose(time, { [hand]: at(keys, time) }), calibration());
    if (output) outputs.push(output);
  }
  return outputs;
}

const kinds = (outputs: readonly PunchOutput[]) => outputs.map((output) => output.kind);

/** Guard, extend over `durationMs`, hold extended. */
function jab(durationMs = 150, holdUntil = 900): [number, Arm][] {
  return [[0, GUARD], [300, GUARD], [300 + durationMs, STRAIGHT], [holdUntil, STRAIGHT]];
}

describe('PunchDetector', () => {
  it('treats decreasing body-local z as forward, toward the camera', () => {
    const local = (arm: Arm) => {
      const world = armPose(0, { right: arm }).worldLandmarks;
      return bodyLocalPoint(world[16]!, world[12]!, world[11]!, world[12]!, world[23]!, world[24]!, 0.4)!;
    };
    expect(local(STRAIGHT).z).toBeLessThan(local(GUARD).z);
  });

  for (const hand of ['left', 'right'] as const) {
    it(`fires an onset then exactly one confirmation for a straight ${hand} punch`, () => {
      const outputs = run(new PunchDetector(hand), jab(), { hand });
      expect(kinds(outputs)).toEqual(['onset', 'confirmed']);
      const [onset, punch] = outputs;
      if (onset?.kind !== 'onset' || punch?.kind !== 'confirmed') throw new Error('unexpected outputs');
      expect(punch.onsetTimestampMs).toBe(onset.timestampMs);
      expect(punch.peakTimestampMs).toBeGreaterThanOrEqual(punch.onsetTimestampMs);
      expect(punch.power01).toBeGreaterThan(0);
      expect(punch.power01).toBeLessThanOrEqual(1);
      expect(punch.confidence).toBeCloseTo(0.95);
    });
  }

  it('ignores the other arm', () => {
    expect(run(new PunchDetector('left'), jab(), { hand: 'right' })).toEqual([]);
  });

  for (const fps of [15, 30]) {
    it(`catches fast and moderate punches at ${fps} fps regardless of sampling phase`, () => {
      for (const durationMs of [100, 150, 250]) {
        for (const phaseMs of [0, 11, 23, 41, 59]) {
          const outputs = run(new PunchDetector('right'), jab(durationMs), { fps, phaseMs });
          expect(kinds(outputs), `${durationMs} ms, phase ${phaseMs}`).toEqual(['onset', 'confirmed']);
        }
      }
    });
  }

  it('reports more power for a faster punch', () => {
    const power = (durationMs: number) => {
      const punch = run(new PunchDetector('right'), jab(durationMs)).find((output) => output.kind === 'confirmed');
      return punch?.kind === 'confirmed' ? punch.power01 : Number.NaN;
    };
    expect(power(120)).toBeGreaterThan(power(300));
  });

  it('confirms a compact punch once the travel floor adapts to the player', () => {
    const compact: Arm = { elbow: { x: 0, y: 0.02, z: -0.12 }, wrist: { x: 0, y: 0.02, z: -0.26 } };
    const keys: [number, Arm][] = [[0, GUARD], [300, GUARD], [400, compact], [900, compact]];
    expect(kinds(run(new PunchDetector('right'), keys))).toEqual(['onset']);
    const adapted = new PunchDetector('right');
    adapted.minTravel = 0.15;
    expect(kinds(run(adapted, keys))).toEqual(['onset', 'confirmed']);
  });

  it('does not confirm depth-only motion with the elbow staying bent', () => {
    const forward = (point: Point3) => ({ ...point, z: point.z - 0.4 });
    // A large depth swing of elbow and wrist: plenty of forward travel, never a straight arm.
    const shoved: Arm = { elbow: forward(GUARD.elbow), wrist: forward(GUARD.wrist) };
    const outputs = run(new PunchDetector('right'), [[0, GUARD], [300, GUARD], [450, shoved], [900, shoved]]);
    expect(outputs.filter((output) => output.kind === 'confirmed')).toEqual([]);
  });

  it('stays silent when only the wrist depth drifts toward the camera', () => {
    const drifted: Arm = { elbow: GUARD.elbow, wrist: { ...GUARD.wrist, z: GUARD.wrist.z - 0.12 } };
    expect(run(new PunchDetector('right'), [[0, GUARD], [300, GUARD], [1300, drifted], [1600, drifted]])).toEqual([]);
  });

  for (const [name, target] of [['down', HANGING], ['sideways', SIDEWAYS]] as const) {
    it(`does not fire when the arm opens ${name} without forward travel`, () => {
      expect(run(new PunchDetector('right'), [[0, GUARD], [300, GUARD], [450, target], [900, target]])).toEqual([]);
    });
  }

  it('counts confirmation failure causes without clearing them on reset', () => {
    const detector = new PunchDetector('right');
    const half = mix(GUARD, STRAIGHT, 0.45);
    run(detector, [[0, GUARD], [300, GUARD], [400, half], [500, GUARD], [900, GUARD]]);
    expect(detector.diagnostics).toMatchObject({ onsets: 1, confirmed: 0, missingExtension: 1, missingTravel: 0 });
    detector.reset();
    expect(detector.diagnostics.onsets).toBe(1);
    detector.resetDiagnostics();
    expect(detector.diagnostics.onsets).toBe(0);
  });

  it('does not confirm a feint that retracts before extending', () => {
    const half = mix(GUARD, STRAIGHT, 0.45);
    const outputs = run(new PunchDetector('right'), [[0, GUARD], [300, GUARD], [400, half], [500, GUARD], [900, GUARD]]);
    expect(kinds(outputs)).toEqual(['onset']);
  });

  it('does not confirm an extension too slow to finish inside the window', () => {
    expect(kinds(run(new PunchDetector('right'), jab(800, 1400)))).not.toContain('confirmed');
  });

  it('does not re-fire while the arm stays extended and jitters forward', () => {
    const detector = new PunchDetector('right');
    const dipped = mix(GUARD, STRAIGHT, 0.9);
    const outputs = run(detector, [
      [0, GUARD], [300, GUARD], [450, STRAIGHT], [800, STRAIGHT], [900, dipped], [1000, STRAIGHT], [1500, STRAIGHT],
    ]);
    expect(kinds(outputs)).toEqual(['onset', 'confirmed']);
  });

  for (const fps of [15, 30]) {
    it(`re-arms after retraction at ${fps} fps`, () => {
      const outputs = run(new PunchDetector('right'), [
        [0, GUARD], [300, GUARD], [450, STRAIGHT], [550, STRAIGHT], [700, GUARD],
        [1000, GUARD], [1150, STRAIGHT], [1500, STRAIGHT],
      ], { fps });
      expect(kinds(outputs)).toEqual(['onset', 'confirmed', 'onset', 'confirmed']);
    });
  }

  it('does not fire on landmark jitter at rest', () => {
    for (const rest of [GUARD, STRAIGHT]) {
      const detector = new PunchDetector('right');
      let seed = 7;
      const noise = () => {
        seed = (seed * 48271) % 2147483647;
        return (seed / 2147483647 - 0.5) * 0.04;
      };
      const jitter = (point: Point3) => ({ x: point.x + noise(), y: point.y + noise(), z: point.z + noise() });
      const outputs = Array.from({ length: 300 }, (_, frame) => detector.update(
        armPose(frame * 33, { right: { elbow: jitter(rest.elbow), wrist: jitter(rest.wrist) } }),
        calibration(),
      ));
      expect(outputs.filter(Boolean)).toEqual([]);
    }
  });

  // Elbow pulled back and hand dropped, arm still fairly open: cosine ~0.55, never below 0.4.
  const PARTIAL: Arm = { elbow: { x: 0, y: 0.252, z: 0.122 }, wrist: { x: 0, y: 0.493, z: -0.022 } };

  for (const fps of [15, 30]) {
    it(`re-arms at rest after a partial retraction at ${fps} fps`, () => {
      const outputs = run(new PunchDetector('right'), [
        [0, GUARD], [300, GUARD], [450, STRAIGHT], [550, STRAIGHT], [750, PARTIAL],
        [1300, PARTIAL], [1450, STRAIGHT], [1800, STRAIGHT],
      ], { fps });
      expect(kinds(outputs)).toEqual(['onset', 'confirmed', 'onset', 'confirmed']);
    });
  }

  it('does not count an interrupted rest toward the re-arm', () => {
    const attempt = (interrupt: boolean) => {
      const detector = new PunchDetector('right');
      detector.reset();
      run(detector, [[0, PARTIAL], [200, PARTIAL]]);
      if (interrupt) detector.interruptRearm();
      run(detector, [[233, PARTIAL], [400, PARTIAL]], { from: 233 });
      return kinds(run(detector, [[433, PARTIAL], [583, STRAIGHT], [900, STRAIGHT]], { from: 433 }));
    };
    expect(attempt(false)).toEqual(['onset', 'confirmed']);
    expect(attempt(true)).toEqual([]);
  });

  // Short jabs from guard: the hand travels 0.35 / 0.45 shoulder widths and the elbow stops at cosine 0.68.
  const SHORT_035: Arm = { elbow: { x: 0, y: 0.27, z: -0.072 }, wrist: { x: 0, y: 0.401, z: -0.32 } };
  const SHORT_045: Arm = { elbow: { x: 0, y: 0.262, z: -0.1 }, wrist: { x: 0, y: 0.366, z: -0.36 } };

  for (const [travel, target] of [[0.35, SHORT_035], [0.45, SHORT_045]] as const) {
    for (const fps of [15, 30]) {
      it(`confirms a short jab of ${travel} shoulder widths at ${fps} fps`, () => {
        for (const phaseMs of [0, 11, 23]) {
          const outputs = run(new PunchDetector('right'), [[0, GUARD], [300, GUARD], [420, target], [900, target]], { fps, phaseMs });
          expect(kinds(outputs), `phase ${phaseMs}`).toEqual(['onset', 'confirmed']);
        }
      });
    }
  }

  it('requires a retraction after reset, so the next extension from there does not fire', () => {
    const detector = new PunchDetector('right');
    run(detector, [[0, GUARD], [300, GUARD]]);
    detector.reset();
    // Extending right after the reset, with no dwell in guard first.
    expect(run(detector, [[333, GUARD], [483, STRAIGHT], [900, STRAIGHT]], { from: 333 })).toEqual([]);
    const next = run(detector, [[933, GUARD], [1200, GUARD], [1350, STRAIGHT], [1700, STRAIGHT]], { from: 933 });
    expect(kinds(next)).toEqual(['onset', 'confirmed']);
  });

  it('drops a punch in flight across a sample gap and stays quiet while extended', () => {
    const detector = new PunchDetector('right');
    const started = run(detector, jab(), { to: 370 });
    expect(kinds(started)).toEqual(['onset']);
    expect(run(detector, [[900, STRAIGHT], [1300, STRAIGHT]], { from: 900 })).toEqual([]);
  });

  it('does not measure speed across a sample gap', () => {
    const detector = new PunchDetector('right');
    run(detector, [[0, GUARD], [300, GUARD]]);
    expect(detector.update(armPose(900, { right: STRAIGHT }), calibration())).toBeUndefined();
    expect(detector.update(armPose(933, { right: STRAIGHT }), calibration())).toBeUndefined();
  });

  it('treats a missing elbow as a reset', () => {
    const detector = new PunchDetector('right');
    run(detector, jab(), { to: 370 });
    const broken = armPose(400);
    expect(detector.update({ ...broken, worldLandmarks: broken.worldLandmarks.slice(0, 14) }, calibration())).toBeUndefined();
    expect(run(detector, [[433, STRAIGHT], [900, STRAIGHT]], { from: 433 })).toEqual([]);
  });

  it('restarts the re-arm dwell when interrupted', () => {
    const attempt = (interrupt: boolean) => {
      const detector = new PunchDetector('right');
      detector.reset();
      run(detector, [[0, GUARD], [66, GUARD]]);
      if (interrupt) detector.interruptRearm();
      return kinds(run(detector, [[99, GUARD], [249, STRAIGHT], [600, STRAIGHT]], { from: 99 }));
    };
    expect(attempt(false)).toEqual(['onset', 'confirmed']);
    expect(attempt(true)).toEqual([]);
  });
  it('measures travel from where the motion started, not from the late onset', () => {
    // A slow wind-up accelerates into the punch: the onset fires mid-course, but the travel
    // must reach back to the guard position, or compact punches never satisfy confirmation.
    const keys: [number, Arm][] = [
      [0, GUARD], [300, GUARD],
      [600, mix(GUARD, STRAIGHT, 0.35)], // gradual start: below onset speed
      [750, STRAIGHT], [950, STRAIGHT], [1200, GUARD], [1600, GUARD],
    ];
    const detector = new PunchDetector('right');
    const outputs = run(detector, keys, { fps: 30, to: 1600 });
    const confirmed = outputs.find((output) => output.kind === 'confirmed');
    expect(confirmed).toBeDefined();
    if (confirmed?.kind !== 'confirmed') return;
    // The full GUARD -> STRAIGHT course is ~0.4 shoulder widths at the fixture scale; measuring
    // from the onset instead of the motion start would report only a fraction of it.
    expect(confirmed.measurement.forwardTravel).toBeGreaterThan(0.5);
    expect(confirmed.measurement.origin.forward).toBeLessThan(confirmed.measurement.contact.forward - 0.5);
  });

  it('confirms a compact punch whose extension peak coincides with the retraction', () => {
    // Shadow-boxing punches retract as soon as they extend: at 15 fps the filtered extension
    // peak only appears in the first retracting frames, and the window must not close before it.
    const partial = mix(GUARD, STRAIGHT, 0.8);
    const keys: [number, Arm][] = [
      [0, GUARD], [300, GUARD], [450, partial], [520, partial], [700, GUARD], [1400, GUARD],
    ];
    const detector = new PunchDetector('right');
    const outputs = run(detector, keys, { fps: 15, to: 1400 });
    expect(kinds(outputs)).toContain('confirmed');
  });

});

describe('isGuardingPose', () => {
  const guarding = (left: Arm, right: Arm) => isGuardingPose(armPose(0, { left, right }), calibration());
  // Fists wide of the head with folded elbows: hands up, nothing covered.
  const WIDE: Arm = { elbow: { x: 0.28, y: 0.1, z: 0 }, wrist: { x: 0.42, y: -0.14, z: 0 } };

  it('reads both folded fists up at the cheeks as a guard', () => {
    expect(guarding(CHIN_GUARD, CHIN_GUARD)).toBe(true);
  });

  it('does not read shoulder-height folded fists as a guard — they cover nothing', () => {
    expect(guarding(GUARD, GUARD)).toBe(false);
  });

  it.each([['extended', STRAIGHT], ['hanging', HANGING], ['stretched sideways', SIDEWAYS], ['wide', WIDE]] as const)(
    'is not a guard with one arm %s',
    (_name, arm) => {
      expect(guarding(arm, CHIN_GUARD)).toBe(false);
      expect(guarding(CHIN_GUARD, arm)).toBe(false);
    },
  );

  it('has no guard when a wrist is not visible', () => {
    const snapshot = armPose(0, { left: CHIN_GUARD, right: CHIN_GUARD });
    const worldLandmarks = snapshot.worldLandmarks.map((point, index) => (index === 15 ? { ...point, visibility: 0 } : point));
    expect(isGuardingPose({ ...snapshot, worldLandmarks }, calibration())).toBe(false);
  });

});
