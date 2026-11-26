import { describe, expect, it } from 'vitest';
import { JumpDetector } from '../src/kinematics/jumpDetector';
import { TorsoVerticalChannel, type TorsoVerticalSample } from '../src/kinematics/torsoVertical';
import { poseWithHipBounce } from './fixtures/syntheticPose';

const TORSO = 0.4; // fixture torso height in image units

/**
 * Integration chain: the trajectory drives real pose frames through the actual channel — the
 * velocity the detector sees is the filtered one the system really produces, not a raw numeric
 * derivative. Bounce-interference cases belong here, because the channel's filtering is what
 * separates the jump transient from the 2.8 Hz bounce modulation.
 */
function feedChain(
  trajectory: (timeMs: number) => number,
  options: { fps?: number; durationMs?: number; armMs?: number } = {},
) {
  const channel = new TorsoVerticalChannel();
  const detector = new JumpDetector();
  const fps = options.fps ?? 30;
  const durationMs = options.durationMs ?? 6000;
  const dt = 1000 / fps;
  const events: number[] = [];
  const feedOne = (time: number, input: number) => {
    // Negative sign: trajectory is up-positive rise, image y offset is down-positive.
    const sample = channel.update(poseWithHipBounce(time, -input * TORSO));
    if (sample && detector.update(sample)) events.push(time);
  };
  // Arming means quiet standing — zero input, never the trajectory itself (a bounce
  // trajectory is already moving at negative times, which would never arm).
  for (let t = -(options.armMs ?? 600); t < 0; t += dt) feedOne(Math.round(t), 0);
  for (let t = 0; t <= durationMs; t += dt) feedOne(Math.round(t), trajectory(Math.round(t)));
  return events;
}

/**
 * Builds physics-coherent samples from a position trajectory: rise is the position relative
 * to baseline (torsoHeights, up positive), velocityUp is the numeric derivative — no cheating
 * by feeding the detector a velocity the position never had.
 */
function feed(detector: JumpDetector, trajectory: (timeMs: number) => number, fps = 30, durationMs = 6000, amplitude = 0) {
  const dt = 1000 / fps;
  const events: number[] = [];
  let previous = trajectory(0);
  for (let t = 0; t <= durationMs; t += dt) {
    const time = Math.round(t);
    const rise = trajectory(time);
    const velocityUp = (rise - previous) / (dt / 1000);
    previous = rise;
    const sample: TorsoVerticalSample = {
      timestampMs: time, rise, velocityUp, oscillationAmplitude: amplitude, sustainedOscillationAmplitude: amplitude,
    };
    if (detector.update(sample)) events.push(time);
  }
  return events;
}

/** Quiet standing long enough to arm the detector (|rise| in band for 160 ms+). */
function arm(detector: JumpDetector, untilMs = 0) {
  for (let t = -600; t < untilMs; t += 33) {
    detector.update({ timestampMs: t, rise: 0, velocityUp: 0, oscillationAmplitude: 0, sustainedOscillationAmplitude: 0 });
  }
}

/** Running bounce: sine of the given semi-amplitude and frequency, zero mean. */
const bounce = (amplitude: number, hz: number) => (timeMs: number) => amplitude * Math.sin((2 * Math.PI * hz * timeMs) / 1000);

/** A jump shape: crouch to -depth over 250 ms, then a powered rise to +height in ~180 ms.
 *  The powered phase is quadratic in time — muscles accelerate the body through push-off, so
 *  velocity peaks at liftoff (the sine profile I started with peaks at the start, which is
 *  backwards). Flight and landing are simplified to a hold and a linear descent: detection
 *  happens during push-off, before either matters. */
function jumpProfile(height: number, depth = 0.1) {
  return (timeMs: number): number => {
    const t = timeMs - 2000; // jump starts at t=2000
    if (t < 0) return 0;
    if (t < 250) return (-depth * (1 - Math.cos((Math.PI * t) / 250))) / 2; // crouch dip: 0 → -depth, zero velocity at both ends
    if (t < 430) {
      const u = (t - 250) / 180;
      return -depth + (height + depth) * u * u; // powered rise — velocity peaks at liftoff
    }
    if (t < 700) return height; // airborne plateau (simplified flight)
    if (t < 1000) return height * (1 - (t - 700) / 300); // landing descent
    return 0;
  };
}

/** Bounce with a jump superimposed at t=2000. */
function bouncePlusJump(bounceAmp: number, hz: number, jumpHeight: number) {
  const b = bounce(bounceAmp, hz);
  const j = jumpProfile(jumpHeight);
  return (timeMs: number) => b(timeMs) + j(timeMs);
}

describe('JumpDetector (adaptive baseline)', () => {
  it('fires once on a crouch+jump of 0.3 torso and does not repeat on landing', () => {
    const detector = new JumpDetector();
    arm(detector);
    const events = feed(detector, jumpProfile(0.3));
    expect(events).toHaveLength(1);
    expect(events[0]).toBeGreaterThan(2000);
    expect(events[0]).toBeLessThan(2500);
  });

  it('never fires on running bounce of 0.09 torso semi-amplitude at 3 Hz for 5 s', () => {
    expect(feedChain(bounce(0.09, 3), { durationMs: 5000 })).toHaveLength(0);
  });

  it('never fires on moderate bounce of 0.05 torso and does not jam the arm state', () => {
    expect(feedChain(bounce(0.05, 2.5), { durationMs: 4000 })).toHaveLength(0);
    // Still operational afterwards: a real jump right after the bounce fires normally.
    expect(feedChain(bouncePlusJump(0.05, 2.5, 0.25), { durationMs: 4000 })).toHaveLength(1);
  });

  it('fires exactly once on a 0.2 torso jump during running bounce of 0.06', () => {
    const events = feedChain(bouncePlusJump(0.06, 2.8, 0.2), { durationMs: 5000 });
    expect(events).toHaveLength(1);
    expect(events[0]).toBeGreaterThan(2000);
    // Detection must land while the jump is still in the air (flight ends ~2700, landing
    // completes by 3000). The smallest realistic hop at an adverse bounce phase takes the
    // longest to confirm — latency here is the marginal case, not the typical one.
    expect(events[0]).toBeLessThan(3000);
  });

  it('does not fire on a small hop of 0.12 torso with bounce-like velocity (1.2 torso/s peak)', () => {
    const detector = new JumpDetector();
    arm(detector);
    // A slow small hop: same height profile but stretched so peak velocity stays ~1.2 torso/s.
    const slow = (timeMs: number) => jumpProfile(0.12)((timeMs - 2000) * 0.5 + 2000);
    const events = feed(detector, slow);
    expect(events).toHaveLength(0);
  });

  it('does not fire on rest jitter of ±0.008 torso and still arms', () => {
    const detector = new JumpDetector();
    arm(detector);
    const jitter = (timeMs: number) => 0.006 * Math.sin(timeMs / 91) + 0.002 * Math.sin(timeMs / 37);
    expect(feed(detector, jitter, 30, 4000)).toHaveLength(0);
    const events = feed(detector, jumpProfile(0.25));
    expect(events).toHaveLength(1);
  });

  it('fires twice on two jumps 1 s apart', () => {
    const detector = new JumpDetector();
    arm(detector);
    const twoJumps = (timeMs: number) => jumpProfile(0.25)(timeMs) + jumpProfile(0.25)(timeMs - 1500);
    const events = feed(detector, twoJumps, 30, 7000);
    expect(events).toHaveLength(2);
    expect(events[1]! - events[0]!).toBeGreaterThan(900);
  });

  it('re-arms through tracking micro-oscillation that never dips under the rearm band', () => {
    const detector = new JumpDetector();
    arm(detector);
    // First takeoff at t=2000; from t=3000 on the signal hovers at rise ≈0.07 — a wobble
    // pinned just over the 0.05 rearm band, so the band itself can never free the detector.
    // The airborne bound re-arms it anyway and the second takeoff at t=4200 still fires.
    const twoJumps = (timeMs: number) =>
      jumpProfile(0.25)(timeMs) + jumpProfile(0.25)(timeMs - 2200) + (timeMs > 3000 ? 0.07 : 0);
    const events = feed(detector, twoJumps, 30, 8000);
    expect(events).toHaveLength(2);
    expect(events[1]).toBeGreaterThan(4200);
  });

  it('re-arms at the airborne timeout when rise never returns below the band', () => {
    const detector = new JumpDetector();
    arm(detector);
    const update = (timestampMs: number, rise: number, velocityUp: number) => detector.update({
      timestampMs, rise, velocityUp, oscillationAmplitude: 0, sustainedOscillationAmplitude: 0,
    });

    expect(update(2000, 0.12, 2)).toBe(false);
    expect(update(2033, 0.12, 2)).toBe(true);
    for (let time = 2066; time < 2733; time += 33) expect(update(time, 0.07, 0)).toBe(false);
    expect(update(2733, 0.07, 0)).toBe(false);
    expect(update(2766, 0.12, 2)).toBe(false);
    expect(update(2799, 0.12, 2)).toBe(true);
  });

  it.each([15, 30, 60])('fires the same jump once at %i fps', (fps) => {
    expect(feedChain(jumpProfile(0.3), { fps })).toHaveLength(1);
  });

  it('does not fire before being armed by quiet standing', () => {
    // No arming: the detector starts mid-bounce and a jump-shaped rise happens immediately.
    expect(feedChain(bouncePlusJump(0.06, 2.8, 0.25), { durationMs: 3000, armMs: 0 })).toHaveLength(0);
  });
});
