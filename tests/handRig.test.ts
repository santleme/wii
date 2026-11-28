import { describe, expect, it } from 'vitest';
import {
  CANONICAL_BONE_LENGTHS,
  CREATOR_HAND_POSE,
  DEFAULT_HAND_JOINTS,
  ENTER_BLEND_MS,
  EXIT_BLEND_MS,
  FINGER_CHAINS,
  type HandRigPose,
  HandRigSmoother,
  LOSS_GRACE_MS,
  mapObservationToRig,
  sampleIdleHand,
  type Vec3,
} from '../src/lib/handRig';

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function expectCanonicalLengths(joints: readonly Vec3[]) {
  FINGER_CHAINS.forEach((chain, finger) => {
    for (let segment = 0; segment < 4; segment += 1) {
      expect(distance(joints[chain[segment]!]!, joints[chain[segment + 1]!]!)).toBeCloseTo(
        CANONICAL_BONE_LENGTHS[finger]![segment]!,
        6,
      );
    }
  });
}

/** MediaPipe-space observation of the rest pose, optionally stretched as monocular noise would. */
function observation(stretch = { x: 1, y: 1, z: 1 }) {
  const worldLandmarks = DEFAULT_HAND_JOINTS.map((p) => ({
    x: -p.x * stretch.x * 0.08,
    y: -p.y * stretch.y * 0.08,
    z: -p.z * stretch.z * 0.08,
  }));
  const landmarks = DEFAULT_HAND_JOINTS.map((p) => ({ x: 0.3 - p.x * 0.1, y: 0.7 - p.y * 0.2, z: 0 }));
  return { landmarks, worldLandmarks };
}

function expectOrthonormal({ xAxis, yAxis, zAxis }: HandRigPose['palmBasis']) {
  const axes = [xAxis, yAxis, zAxis];
  axes.forEach((a, i) => {
    axes.forEach((b, j) => {
      expect(dot(a, b)).toBeCloseTo(i === j ? 1 : 0, 6);
    });
  });
}

const TIPS = [4, 8, 12, 16, 20];
const at = (pose: HandRigPose, joint: number): Vec3 => ({
  x: pose.offset.x + pose.joints[joint]!.x,
  y: pose.offset.y + pose.joints[joint]!.y,
  z: pose.offset.z + pose.joints[joint]!.z,
});

function expectSeparatedTips(pose: HandRigPose) {
  TIPS.forEach((a, i) => {
    for (const b of TIPS.slice(i + 1)) expect(distance(pose.joints[a]!, pose.joints[b]!)).toBeGreaterThan(0.3);
  });
}

function shifted(pose: HandRigPose, x: number): HandRigPose {
  return { ...pose, offset: { ...pose.offset, x } };
}

describe('sampleIdleHand', () => {
  it('returns 21 finite joints and an orthonormal palm basis', () => {
    for (const time of [0, 1.3, 42]) {
      const { joints, palmBasis } = sampleIdleHand(time);
      expect(joints).toHaveLength(21);
      expect(joints.flatMap((p) => [p.x, p.y, p.z]).every(Number.isFinite)).toBe(true);
      expectOrthonormal(palmBasis);
      expectCanonicalLengths(joints);
    }
  });

  it('reaches rightward from the left like Adam, palm down and fingers apart', () => {
    for (const time of [0, 1.3, 42]) {
      const pose = sampleIdleHand(time);
      expect(pose.offset.x).toBeLessThan(-1);
      const index = pose.joints[8]!;
      expect(index.x).toBeGreaterThan(1.7);
      // The index leads; the other fingers fall away below it.
      for (const tip of [12, 16, 20]) expect(pose.joints[tip]!.y).toBeLessThan(index.y - 0.5);
      expect(pose.palmBasis.zAxis.y * pose.palmSide).toBeLessThan(-0.5);
      expectSeparatedTips(pose);
    }
  });
});

describe('CREATOR_HAND_POSE', () => {
  it('is a valid rig reaching leftward from the right, palm down', () => {
    const { joints, offset, palmBasis, palmSide } = CREATOR_HAND_POSE;
    expect(joints).toHaveLength(21);
    expect(joints.flatMap((p) => [p.x, p.y, p.z]).every(Number.isFinite)).toBe(true);
    expectCanonicalLengths(joints);
    expectOrthonormal(palmBasis);
    expect(offset.x).toBeGreaterThan(1);
    expect(joints[8]!.x).toBeLessThan(-1.7);
    expect(palmBasis.zAxis.y * palmSide).toBeLessThan(-0.5);
    expectSeparatedTips(CREATOR_HAND_POSE);
  });

  it("leaves a small gap between its index tip and Adam's", () => {
    const gap = distance(at(sampleIdleHand(0), 8), at(CREATOR_HAND_POSE, 8));
    expect(gap).toBeGreaterThan(0.6);
    expect(gap).toBeLessThan(0.95);
  });
});

describe('mapObservationToRig', () => {
  it('rejects short or non-finite landmark sets', () => {
    const good = observation();
    expect(mapObservationToRig({ ...good, worldLandmarks: good.worldLandmarks.slice(0, 20) })).toBeUndefined();
    expect(mapObservationToRig({ ...good, landmarks: [] })).toBeUndefined();
    const broken = good.worldLandmarks.map((p, i) => (i === 8 ? { ...p, z: Number.NaN } : p));
    expect(mapObservationToRig({ ...good, worldLandmarks: broken })).toBeUndefined();
  });

  it('mirrors x and flips y and z around the wrist', () => {
    const source = observation();
    const world = source.worldLandmarks.map((p) => ({ x: p.x + 1, y: p.y + 2, z: p.z + 3 }));
    const pose = mapObservationToRig({ ...source, worldLandmarks: world })!;
    expect(pose.joints[0]).toEqual({ x: 0, y: 0, z: 0 });
    pose.joints.forEach((joint, i) => {
      expect(distance(joint, DEFAULT_HAND_JOINTS[i]!)).toBeCloseTo(0, 6);
    });
    // Image wrist on the left half, below center, appears on the right half, below center.
    expect(pose.offset.x).toBeGreaterThan(0);
    expect(pose.offset.y).toBeLessThan(0);
  });

  it('keeps anatomical bone lengths when raw landmarks are stretched', () => {
    const pose = mapObservationToRig(observation({ x: 1.4, y: 0.7, z: 3 }))!;
    expectCanonicalLengths(pose.joints);
  });

  it('puts the palm on opposite basis sides for the two hands', () => {
    const left = mapObservationToRig({ ...observation(), handedness: 'left' })!;
    const right = mapObservationToRig({ ...observation(), handedness: 'right' })!;
    expect(left.palmSide).toBe(-right.palmSide);
  });
});

describe('HandRigSmoother', () => {
  const idle = sampleIdleHand(0);
  const ease = (p: number) => p * p * (3 - 2 * p);
  /** Expected stage x when a hand held at `target` has the given presence. */
  const blendedX = (target: number, presence: number) => idle.offset.x + (target - idle.offset.x) * ease(presence);

  /** A hand held still at x = 1, seen every 25 ms from t = 1000 until it is fully present at t = 1500. */
  function raised() {
    const smoother = new HandRigSmoother();
    for (let t = 1000; t <= 1000 + ENTER_BLEND_MS; t += 25) smoother.observe(shifted(idle, 1), t);
    return { smoother, seen: 1000 + ENTER_BLEND_MS };
  }

  it('raises the hand gradually instead of snapping to it', () => {
    const smoother = new HandRigSmoother();
    smoother.observe(shifted(idle, 1), 1000);
    expect(smoother.presence(1000)).toBe(0);
    expect(smoother.sample(1000, idle)).toBe(idle);
    for (let t = 1025; t <= 1000 + ENTER_BLEND_MS; t += 25) {
      smoother.observe(shifted(idle, 1), t);
      const presence = (t - 1000) / ENTER_BLEND_MS;
      const pose = smoother.sample(t, idle);
      expect(smoother.presence(t)).toBeCloseTo(presence);
      expect(pose.offset.x).toBeCloseTo(blendedX(1, presence));
      expectCanonicalLengths(pose.joints);
    }
  });

  it('holds through a loss shorter than the grace period and resumes without starting over', () => {
    const { smoother, seen } = raised();
    const held = smoother.sample(seen, idle);
    expect(smoother.sample(seen + LOSS_GRACE_MS, idle)).toBe(held);
    smoother.observe(shifted(idle, 1), seen + LOSS_GRACE_MS - 100);
    expect(smoother.presence(seen + LOSS_GRACE_MS - 100)).toBe(1);
  });

  it('returns smoothly to idle after the grace period', () => {
    const { smoother, seen } = raised();
    const halfway = seen + LOSS_GRACE_MS + EXIT_BLEND_MS / 2;
    const pose = smoother.sample(halfway, idle);
    expect(pose.offset.x).toBeCloseTo(blendedX(1, 0.5));
    expectCanonicalLengths(pose.joints);
    expect(smoother.sample(seen + LOSS_GRACE_MS + EXIT_BLEND_MS, idle)).toBe(idle);
  });

  it('climbs back from the current weight when the hand reappears mid-descent', () => {
    const { smoother, seen } = raised();
    const halfway = seen + LOSS_GRACE_MS + EXIT_BLEND_MS / 2;
    smoother.observe(shifted(idle, 1), halfway);
    expect(smoother.presence(halfway)).toBeCloseTo(0.5);
    expect(smoother.sample(halfway, idle).offset.x).toBeCloseTo(blendedX(1, 0.5));
    expect(smoother.presence(halfway + ENTER_BLEND_MS / 4)).toBeCloseTo(0.75);
  });

  it('glides toward a hand that moved during a loss', () => {
    const { smoother, seen } = raised();
    smoother.observe(shifted(idle, 2), seen + 500);
    const x = smoother.sample(seen + 500, idle).offset.x;
    expect(x).toBeGreaterThan(1);
    expect(x).toBeLessThan(1.9);
  });

  it('starts over only after it is fully back at idle', () => {
    const { smoother, seen } = raised();
    const later = seen + LOSS_GRACE_MS + EXIT_BLEND_MS + 100;
    smoother.observe(shifted(idle, -2), later);
    expect(smoother.sample(later, idle)).toBe(idle);
    expect(smoother.sample(later + LOSS_GRACE_MS, idle).offset.x).toBeCloseTo(-2);
    smoother.reset();
    expect(smoother.sample(later, idle)).toBe(idle);
  });
});
