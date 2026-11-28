import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROTATIONAL_FLICK_CONFIG,
  RotationalFlickDetector,
  type RotationalFlickState,
} from '@wii/spatial-core';
import { rotationalSample as sample, rotationalWorldLandmarks } from './fixtures/rotationalHand';

function updateSeries(
  detector: RotationalFlickDetector,
  startMs: number,
  angles: readonly number[],
  stepMs: number,
  curl = 0.65,
): RotationalFlickState[] {
  return angles.map((angle, index) => detector.update(sample(startMs + index * stepMs, angle, { curl })));
}

function impulse(
  detector: RotationalFlickDetector,
  options: { startMs?: number; fromDeg?: number; stepDeg?: number; frames?: number; stepMs?: number; curl?: number } = {},
): RotationalFlickState[] {
  const frames = options.frames ?? 12;
  const stepDeg = options.stepDeg ?? 3;
  const fromDeg = options.fromDeg ?? 0;
  const angles = Array.from({ length: frames }, (_, index) => fromDeg + index * stepDeg);
  return updateSeries(detector, options.startMs ?? 0, angles, options.stepMs ?? 16, options.curl ?? 0.65);
}

function rotatingDetector(): { detector: RotationalFlickDetector; states: RotationalFlickState[] } {
  const detector = new RotationalFlickDetector();
  const states = impulse(detector);
  if (!states.some((state) => state.phase === 'ROTATING')) throw new Error('fixture did not enter ROTATING');
  return { detector, states };
}

describe('rotational flick detector — 25 deterministic scenarios', () => {
  it('01 keeps the first valid frame at zero velocity because no relative rotation exists', () => {
    const state = new RotationalFlickDetector().update(sample(0, 20));
    expect(state).toMatchObject({
      phase: 'IDLE',
      active: false,
      direction: 0,
      angularVelocityDegPerSec: 0,
      rawAngularVelocityDegPerSec: 0,
      handShape: 'cupped',
    });
    expect(state.dtMs).toBeUndefined();
    expect(state.orientation).toBeDefined();
  });

  it('02 ignores a missing hand without inventing motion', () => {
    const detector = new RotationalFlickDetector();
    detector.update(sample(0, 0));
    const state = detector.update({ timestampMs: 16, handedness: 'right' });
    expect(state).toMatchObject({ phase: 'IDLE', rejectionReason: 'missing-hand', angularVelocityDegPerSec: 0 });
  });

  it('03 rejects truncated world landmarks instead of reading a partial palm basis', () => {
    const state = new RotationalFlickDetector().update({
      timestampMs: 0,
      worldLandmarks: rotationalWorldLandmarks(0).slice(0, 20),
    });
    expect(state).toMatchObject({ phase: 'IDLE', rejectionReason: 'invalid-landmarks', active: false });
  });

  it('04 rejects non-finite landmark coordinates without poisoning later frames', () => {
    const detector = new RotationalFlickDetector();
    const malformed = rotationalWorldLandmarks(0);
    malformed[9] = { ...malformed[9]!, x: Number.NaN };
    expect(detector.update({ timestampMs: 0, worldLandmarks: malformed }).rejectionReason).toBe('invalid-landmarks');
    expect(detector.update(sample(16, 0))).toMatchObject({ phase: 'IDLE', rejectionReason: undefined });
  });

  it('05 treats invalid timestamps as a quality rejection and does not store them in the timeline', () => {
    const detector = new RotationalFlickDetector();
    expect(detector.update(sample(Number.NaN, 0)).rejectionReason).toBe('invalid-timestamp');
    expect(detector.update(sample(-1, 0)).rejectionReason).toBe('invalid-timestamp');
    const recovered = detector.update(sample(16, 0));
    expect(recovered).toMatchObject({ rejectionReason: undefined, dtMs: undefined });
  });

  it('06 cancels cleanly on a nonmonotonic timestamp and starts a fresh orientation segment', () => {
    const { detector } = rotatingDetector();
    const cancelled = detector.update(sample(50, 30));
    expect(cancelled).toMatchObject({ phase: 'CANCELLED', rejectionReason: 'nonmonotonic-timestamp' });
    const recovered = detector.update(sample(66, 30));
    expect(recovered.rawAngularVelocityDegPerSec).toBe(0);
  });

  it('07 rejects a frame gap before using orientations from opposite sides of the gap', () => {
    const detector = new RotationalFlickDetector({ maxFrameGapMs: 80 });
    detector.update(sample(0, 0));
    const gap = detector.update(sample(100, 30));
    expect(gap).toMatchObject({ rejectionReason: 'frame-gap', rawAngularVelocityDegPerSec: 0 });
    const next = detector.update(sample(116, 33));
    expect(next.dtMs).toBe(16);
    expect(Number.isFinite(next.rawAngularVelocityDegPerSec)).toBe(true);
  });

  it('08 resets the orientation segment when handedness changes', () => {
    const detector = new RotationalFlickDetector();
    detector.update(sample(0, 0, { handedness: 'right' }));
    const changed = detector.update(sample(16, 15, { handedness: 'left', mirrorX: true }));
    expect(changed).toMatchObject({ rejectionReason: 'handedness-change', rawAngularVelocityDegPerSec: 0 });
    const next = detector.update(sample(32, 18, { handedness: 'left', mirrorX: true }));
    expect(next.rejectionReason).toBeUndefined();
  });

  it('09 enters ROTATION_CANDIDATE only for a strong cupped-hand impulse', () => {
    const detector = new RotationalFlickDetector();
    const states = impulse(detector, { frames: 3 });
    expect(states[1]).toMatchObject({ phase: 'ROTATION_CANDIDATE', direction: 1, active: true });
    expect(states[1]!.controlAngularVelocityDegPerSec).toBe(0);
  });

  it('10 confirms ROTATING after sustained impulse inside the 80–120 ms design window', () => {
    const detector = new RotationalFlickDetector();
    const states = impulse(detector);
    const rotatingIndex = states.findIndex((state) => state.phase === 'ROTATING');
    expect(rotatingIndex).toBeGreaterThanOrEqual(5);
    expect(rotatingIndex * 16).toBeLessThanOrEqual(120);
    expect(states[rotatingIndex]!.controlAngularVelocityDegPerSec).toBeGreaterThan(0);
  });

  it('11 does not confirm a flick whose strong motion lasts less than the candidate time', () => {
    const detector = new RotationalFlickDetector();
    const states = impulse(detector, { frames: 4 });
    expect(states.some((state) => state.phase === 'ROTATING')).toBe(false);
  });

  it('12 cancels a candidate that stalls beyond its confirmation window', () => {
    const detector = new RotationalFlickDetector({ candidateTimeoutMs: 80, maxFrameGapMs: 200 });
    const states = impulse(detector, { frames: 2, stepMs: 16 });
    const outputs = [...states];
    for (let index = 0; index < 7; index += 1) {
      outputs.push(detector.update(sample(32 + index * 16, 3, { curl: 0.65 })));
    }
    expect(outputs.some((state) => state.phase === 'CANCELLED' && state.rejectionReason === 'candidate-timeout')).toBe(
      true,
    );
  });

  it('13 keeps a static cupped hand idle', () => {
    const detector = new RotationalFlickDetector();
    const states = updateSeries(detector, 0, Array.from({ length: 12 }, () => 15), 16);
    expect(states.every((state) => state.phase === 'IDLE')).toBe(true);
    expect(Math.max(...states.map((state) => Math.abs(state.angularVelocityDegPerSec)))).toBeLessThan(1);
  });

  it('14 never starts rotation from an open palm, even when the palm spins quickly', () => {
    const detector = new RotationalFlickDetector();
    const states = impulse(detector, { curl: 0 });
    expect(states.every((state) => state.phase === 'IDLE')).toBe(true);
    expect(states.at(-1)).toMatchObject({ handShape: 'open' });
  });

  it('15 never starts rotation from a closed fist', () => {
    const detector = new RotationalFlickDetector();
    const states = impulse(detector, { curl: 1 });
    expect(states.every((state) => state.phase === 'IDLE')).toBe(true);
    expect(states.at(-1)).toMatchObject({ handShape: 'closed' });
  });

  it('16 keeps neutral neither-open-nor-cupped articulation out of the candidate state', () => {
    const detector = new RotationalFlickDetector();
    const states = impulse(detector, { curl: 0.57 });
    expect(states.at(-1)).toMatchObject({ handShape: 'neutral', phase: 'IDLE' });
  });

  it('17 measures 359°↔0° motion through relative rotations without a negative wrap spike', () => {
    const detector = new RotationalFlickDetector({ frameAngularDeadZoneDeg: 0 });
    detector.update(sample(0, 350));
    const velocities = [355, 0, 5, 10].map((angle, index) =>
      detector.update(sample(16 * (index + 1), angle)).rawAngularVelocityDegPerSec,
    );
    expect(velocities.every((velocity) => velocity > 0)).toBe(true);
    expect(Math.max(...velocities) - Math.min(...velocities)).toBeLessThan(1);
  });

  it('18 attenuates small alternating jitter below the angular and velocity dead zones', () => {
    const detector = new RotationalFlickDetector({ frameAngularDeadZoneDeg: 0.2 });
    const angles = Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? 0.08 : -0.08));
    const states = updateSeries(detector, 0, angles, 16);
    expect(states.every((state) => state.phase === 'IDLE')).toBe(true);
    expect(Math.max(...states.map((state) => Math.abs(state.angularVelocityDegPerSec)))).toBeLessThan(
      DEFAULT_ROTATIONAL_FLICK_CONFIG.velocityDeadZoneDegPerSec,
    );
  });

  it('19 uses real timestamp deltas instead of assuming a fixed frame rate', () => {
    const detector = new RotationalFlickDetector({ frameAngularDeadZoneDeg: 0 });
    detector.update(sample(0, 0));
    const fast = detector.update(sample(10, 3));
    expect(fast.rawAngularVelocityDegPerSec).toBeCloseTo(300, 0);
    const slow = detector.update(sample(40, 6));
    expect(slow.rawAngularVelocityDegPerSec).toBeCloseTo(100, 0);
  });

  it('20 confirms at equivalent physical times at 30, 60, and 120 fps', () => {
    const confirmations = [
      { stepMs: 33, stepDeg: 6 },
      { stepMs: 16, stepDeg: 3 },
      { stepMs: 8, stepDeg: 1.5 },
    ].map(({ stepMs, stepDeg }) => {
      const detector = new RotationalFlickDetector();
      const states = impulse(detector, { frames: 30, stepMs, stepDeg });
      const index = states.findIndex((state) => state.phase === 'ROTATING');
      if (index < 0) throw new Error('rotation was not confirmed');
      return index * stepMs;
    });
    expect(Math.max(...confirmations) - Math.min(...confirmations)).toBeLessThanOrEqual(34);
  });

  it('21 brakes immediately when the palm opens during ROTATING', () => {
    const { detector, states } = rotatingDetector();
    const last = states.at(-1)!;
    const braked = detector.update(sample(last.timestampMs + 16, 30, { curl: 0 }));
    expect(braked).toMatchObject({ phase: 'BRAKING', handShape: 'open', controlAngularVelocityDegPerSec: 0 });
  });

  it('22 publishes SNAP_TO_CARD only after the 50–80 ms open-palm confirmation delay', () => {
    const { detector, states } = rotatingDetector();
    let time = states.at(-1)!.timestampMs;
    time += 16;
    const braked = detector.update(sample(time, 30, { curl: 0 }));
    expect(braked.phase).toBe('BRAKING');
    time += 16;
    const early = detector.update(sample(time, 30, { curl: 0 }));
    expect(early.phase).toBe('BRAKING');
    time += 49;
    const snap = detector.update(sample(time, 30, { curl: 0 }));
    expect(snap.phase).toBe('SNAP_TO_CARD');
    expect(snap.timestampMs - braked.timestampMs).toBeGreaterThanOrEqual(50);
    expect(snap.timestampMs - braked.timestampMs).toBeLessThanOrEqual(80);
  });

  it('23 enters RECOVERY on opposite return motion and stops emitting drive velocity', () => {
    const { detector, states } = rotatingDetector();
    let time = states.at(-1)!.timestampMs;
    let angle = 33;
    let latest: RotationalFlickState | undefined;
    for (let index = 0; index < 3; index += 1) {
      angle -= 1.5;
      time += 16;
      latest = detector.update(sample(time, angle));
    }
    expect(latest).toMatchObject({ phase: 'RECOVERY', controlAngularVelocityDegPerSec: 0, direction: 1 });
  });

  it('24 ignores light opposite hand-return motion in RECOVERY instead of reversing direction', () => {
    const { detector, states } = rotatingDetector();
    let time = states.at(-1)!.timestampMs;
    let angle = 33;
    const phases: RotationalFlickState[] = [];
    for (let index = 0; index < 10; index += 1) {
      angle -= 0.8; // ≈50 deg/s, below the 95 deg/s reversal threshold
      time += 16;
      phases.push(detector.update(sample(time, angle)));
    }
    expect(phases.some((state) => state.phase === 'RECOVERY')).toBe(true);
    expect(phases.at(-1)).toMatchObject({ direction: 1 });
    expect(phases.at(-1)!.controlAngularVelocityDegPerSec).toBe(0);
  });

  it('25 reverses only after a sustained strong opposite impulse with hysteresis', () => {
    const { detector, states } = rotatingDetector();
    let time = states.at(-1)!.timestampMs;
    let angle = 33;
    const outputs: RotationalFlickState[] = [];
    for (let index = 0; index < 8; index += 1) {
      angle -= 2; // ≈125 deg/s opposite, above the reversal threshold
      time += 16;
      outputs.push(detector.update(sample(time, angle)));
    }
    const reversed = outputs.find((state) => state.phase === 'ROTATING' && state.direction === -1);
    expect(reversed).toBeDefined();
    expect(reversed!.controlAngularVelocityDegPerSec).toBeLessThan(0);
    const reversalIndex = outputs.indexOf(reversed!);
    expect(outputs.slice(0, reversalIndex).every((state) => state.direction === 1)).toBe(true);
  });
});

describe('rotational flick detector quality boundaries', () => {
  it('cancels an active rotation when tracking is lost and requires a new candidate afterwards', () => {
    const { detector, states } = rotatingDetector();
    const lost = detector.update({ timestampMs: states.at(-1)!.timestampMs + 16, handedness: 'right' });
    expect(lost).toMatchObject({ phase: 'CANCELLED', rejectionReason: 'missing-hand' });
    const reacquired = detector.update(sample(lost.timestampMs + 16, 33));
    expect(reacquired).toMatchObject({ phase: 'IDLE', rawAngularVelocityDegPerSec: 0 });
  });

  it('ends recovery in braking and then snap when no new impulse arrives', () => {
    const { detector, states } = rotatingDetector();
    let time = states.at(-1)!.timestampMs;
    let angle = 33;
    let latest: RotationalFlickState | undefined;
    for (let index = 0; index < 30; index += 1) {
      angle -= 0.25;
      time += 16;
      latest = detector.update(sample(time, angle));
      if (latest.phase === 'BRAKING') break;
    }
    expect(latest?.phase).toBe('BRAKING');
  });

  it('clamps raw spikes to the configured 360 deg/s ceiling', () => {
    const detector = new RotationalFlickDetector({ frameAngularDeadZoneDeg: 0 });
    detector.update(sample(0, 0));
    const spike = detector.update(sample(8, 90));
    expect(spike.rawAngularVelocityDegPerSec).toBe(360);
    expect(Math.abs(spike.angularVelocityDegPerSec)).toBeLessThanOrEqual(360);
  });

  it('honours negative sensitivity as an explicit direction inversion', () => {
    const normal = new RotationalFlickDetector({ frameAngularDeadZoneDeg: 0 });
    const inverted = new RotationalFlickDetector({ frameAngularDeadZoneDeg: 0, sensitivity: -1 });
    normal.update(sample(0, 0));
    inverted.update(sample(0, 0));
    const normalState = normal.update(sample(16, 3));
    const invertedState = inverted.update(sample(16, 3));
    expect(normalState.angularVelocityDegPerSec).toBeCloseTo(-invertedState.angularVelocityDegPerSec);
  });

  it('reset clears both the state machine and orientation timeline', () => {
    const { detector, states } = rotatingDetector();
    void states;
    detector.reset();
    const state = detector.update(sample(10_000, 120));
    expect(state).toMatchObject({ phase: 'IDLE', direction: 0, rawAngularVelocityDegPerSec: 0 });
    expect(state.dtMs).toBeUndefined();
  });

  it('disabled input is an idle reset rather than a cancellation', () => {
    const detector = new RotationalFlickDetector();
    const state = detector.update({ ...sample(0, 0), enabled: false });
    expect(state).toMatchObject({ phase: 'IDLE', rejectionReason: 'disabled', active: false });
  });
});
