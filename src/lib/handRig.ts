// Pure 3D hand rig math for the /product stage: no DOM, no Three.js.
// Space: +x right on screen (mirrored, selfie view), +y up, +z toward the viewer. Palm length = 1.
import { type HandObservation, OneEuroFilter, type PalmBasis, palmBasis } from '@wii/spatial-core';

export type Vec3 = { x: number; y: number; z: number };

export type HandRigPose = {
  /** 21 MediaPipe-ordered joints, wrist at the origin. */
  joints: Vec3[];
  /** Wrist position on the stage. */
  offset: Vec3;
  palmBasis: Pick<PalmBasis, 'xAxis' | 'yAxis' | 'zAxis'>;
  /** The palm faces `palmBasis.zAxis * palmSide`; the sign depends on which hand it is. */
  palmSide: 1 | -1;
};

export const FINGER_CHAINS = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [0, 9, 10, 11, 12],
  [0, 13, 14, 15, 16],
  [0, 17, 18, 19, 20],
] as const;

export const PALM_BRIDGES = [
  [1, 5],
  [5, 9],
  [9, 13],
  [13, 17],
] as const;

/** Segment lengths per finger, wrist outward, in palm lengths. */
export const CANONICAL_BONE_LENGTHS: readonly (readonly number[])[] = [
  [0.42, 0.38, 0.32, 0.27],
  [0.98, 0.45, 0.28, 0.23],
  [1, 0.5, 0.32, 0.25],
  [0.94, 0.46, 0.31, 0.24],
  [0.88, 0.36, 0.23, 0.22],
];

type Directions = readonly (readonly (readonly [number, number, number])[])[];

/**
 * Rest pose, after Adam in "The Creation of Adam": a left hand reaching toward +x, palm down. The index
 * stays extended while the other fingers fall away down and back, so each one keeps its own silhouette.
 */
const REST_DIRECTIONS: Directions = [
  [[0.72, -0.45, 0.52], [0.76, -0.5, 0.4], [0.86, -0.45, 0.22], [0.92, -0.38, 0.1]],
  [[0.93, 0.31, 0.2], [0.95, 0.29, 0.08], [0.99, 0.12, 0.04], [0.99, -0.1, 0]],
  [[0.99, 0.12, 0.02], [0.94, -0.3, -0.05], [0.78, -0.62, -0.08], [0.6, -0.8, -0.08]],
  [[0.98, -0.02, -0.18], [0.86, -0.48, -0.14], [0.6, -0.79, -0.12], [0.35, -0.93, -0.1]],
  [[0.93, -0.14, -0.34], [0.74, -0.65, -0.18], [0.45, -0.88, -0.15], [0.2, -0.97, -0.12]],
];

/** The Creator's right hand, entering from the upper right toward -x with the index extended. */
const CREATOR_DIRECTIONS: Directions = [
  [[-0.7, -0.5, 0.51], [-0.76, -0.52, 0.39], [-0.86, -0.46, 0.22], [-0.92, -0.38, 0.1]],
  [[-0.97, -0.23, 0.2], [-0.98, -0.18, 0.08], [-0.99, -0.13, 0.04], [-0.99, -0.12, 0]],
  [[-0.97, -0.22, 0.02], [-0.84, -0.54, -0.05], [-0.6, -0.8, -0.08], [-0.3, -0.95, -0.08]],
  [[-0.92, -0.35, -0.18], [-0.7, -0.7, -0.14], [-0.4, -0.91, -0.12], [-0.05, -0.99, -0.1]],
  [[-0.84, -0.43, -0.34], [-0.57, -0.8, -0.18], [-0.25, -0.96, -0.15], [0.1, -0.99, -0.12]],
];

const REST_OFFSET: Vec3 = { x: -2.25, y: -0.35, z: 0 };
const REST_PALM_SIDE = -1;
const CREATOR_OFFSET: Vec3 = { x: 2.35, y: 0.68, z: -0.1 };
const CREATOR_PALM_SIDE = 1;
const SPAN_X = 4;
const SPAN_Y = 2.4;
/** Image palm size (in image widths) that maps to depth zero. */
const NEUTRAL_PALM_SIZE = 0.18;
export const ENTER_BLEND_MS = 500;
export const LOSS_GRACE_MS = 900;
export const EXIT_BLEND_MS = 600;
const MAX_FILTER_STEP_MS = 50;

function direction(from: Vec3, to: Vec3): Vec3 | undefined {
  const x = to.x - from.x;
  const y = to.y - from.y;
  const z = to.z - from.z;
  const length = Math.hypot(x, y, z);
  return length > 1e-6 ? { x: x / length, y: y / length, z: z / length } : undefined;
}

/** Walks each chain from the wrist, keeping the direction of `next(chain, segment)` and the canonical length. */
function buildChains(next: (finger: number, segment: number) => Vec3): Vec3[] {
  const joints: Vec3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  FINGER_CHAINS.forEach((chain, finger) => {
    for (let segment = 0; segment < chain.length - 1; segment += 1) {
      const from = joints[chain[segment]!]!;
      const dir = next(finger, segment);
      const length = CANONICAL_BONE_LENGTHS[finger]![segment]!;
      joints[chain[segment + 1]!] = {
        x: from.x + dir.x * length,
        y: from.y + dir.y * length,
        z: from.z + dir.z * length,
      };
    }
  });
  return joints;
}

/** Unit direction of one segment; positive curl bends it downward in the screen plane. */
function poseDirection(table: Directions, finger: number, segment: number, curl = 0): Vec3 {
  const [x, y, z] = table[finger]![segment]!;
  const length = Math.hypot(x, y, z);
  const cos = Math.cos(curl);
  const sin = Math.sin(curl);
  return { x: (x * cos + y * sin) / length, y: (y * cos - x * sin) / length, z: z / length };
}

export const DEFAULT_HAND_JOINTS: readonly Vec3[] = buildChains((finger, segment) =>
  poseDirection(REST_DIRECTIONS, finger, segment),
);

/** Re-imposes the canonical bone lengths on a set of points, keeping every segment direction. */
function withCanonicalLengths(points: readonly Vec3[]): Vec3[] {
  return buildChains((finger, segment) => {
    const chain = FINGER_CHAINS[finger]!;
    return direction(points[chain[segment]!]!, points[chain[segment + 1]!]!) ?? poseDirection(REST_DIRECTIONS, finger, segment);
  });
}

function rigPose(joints: Vec3[], offset: Vec3, palmSide: 1 | -1): HandRigPose | undefined {
  const basis = palmBasis(joints);
  if (!basis) return undefined;
  const { xAxis, yAxis, zAxis } = basis;
  return { joints, offset, palmBasis: { xAxis, yAxis, zAxis }, palmSide };
}

export function sampleIdleHand(timeSec: number): HandRigPose {
  const joints = buildChains((finger, segment) =>
    poseDirection(REST_DIRECTIONS, finger, segment, segment * 0.05 * Math.sin(timeSec * 1.4 - finger * 0.6)),
  );
  const offset = {
    x: REST_OFFSET.x + 0.03 * Math.sin(timeSec * 0.7),
    y: REST_OFFSET.y + 0.05 * Math.sin(timeSec * 1.2),
    z: REST_OFFSET.z,
  };
  return rigPose(joints, offset, REST_PALM_SIDE)!;
}

/** The Creator's hand never moves: it anchors the composition. */
export const CREATOR_HAND_POSE: HandRigPose = rigPose(
  buildChains((finger, segment) => poseDirection(CREATOR_DIRECTIONS, finger, segment)),
  CREATOR_OFFSET,
  CREATOR_PALM_SIDE,
)!;

function allFinite(points: readonly Vec3[] | undefined): boolean {
  return points?.length === 21 && points.every((p) => [p.x, p.y, p.z].every(Number.isFinite));
}

/** `aspectY` is video height / width. Returns undefined for an unusable observation. */
export function mapObservationToRig(observation: HandObservation, aspectY = 0.75): HandRigPose | undefined {
  const { landmarks, worldLandmarks } = observation;
  if (!allFinite(landmarks) || !allFinite(worldLandmarks)) return undefined;

  // MediaPipe is +x right, +y down, +z away. Negating all three mirrors the hand like a selfie view.
  const joints = withCanonicalLengths(worldLandmarks.map((p) => ({ x: -p.x, y: -p.y, z: -p.z })));
  const wrist = landmarks[0]!;
  const middle = landmarks[9]!;
  const palmSize = Math.hypot(middle.x - wrist.x, (middle.y - wrist.y) * aspectY);
  const offset = {
    x: (0.5 - wrist.x) * SPAN_X,
    y: (0.5 - wrist.y) * SPAN_Y,
    z: Math.max(-0.8, Math.min(0.8, (palmSize - NEUTRAL_PALM_SIZE) * 4)),
  };
  // The worker receives the unmirrored video (which MediaPipe treats as mirrored), so handedness is inverted:
  // real left hand -> 'right' (thumb at -x, zAxis points dorsally -> -1); real right hand -> 'left' (+1).
  return rigPose(joints, offset, observation.handedness === 'right' ? -1 : 1);
}

const mix = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

/**
 * 1-Euro smoothing of tracked poses, blended with the idle pose by a presence weight: it ramps up while the
 * hand is seen, holds through short losses (anti-flicker) and ramps back down after LOSS_GRACE_MS.
 */
export class HandRigSmoother {
  // 21 joints plus the offset, three axes each.
  private readonly filters = Array.from({ length: 66 }, () => new OneEuroFilter({ minCutoff: 1.5, beta: 0.8 }));
  private tracked?: HandRigPose;
  private lastSeenMs = 0;
  /** Linear presence at the last observation; with `lastSeenMs` it determines presence at any later time. */
  private seenPresence = 0;
  /** Filter time advances by bounded steps, so a hand that moved during a loss glides instead of jumping. */
  private filterMs = 0;

  /** Linear weight in [0, 1] of the tracked hand over the idle pose. */
  presence(nowMs: number): number {
    if (!this.tracked) return 0;
    const elapsed = Math.max(0, nowMs - this.lastSeenMs);
    const risen = Math.min(1, this.seenPresence + Math.min(elapsed, LOSS_GRACE_MS) / ENTER_BLEND_MS);
    return Math.max(0, risen - Math.max(0, elapsed - LOSS_GRACE_MS) / EXIT_BLEND_MS);
  }

  observe(pose: HandRigPose, timestampMs: number): void {
    const presence = this.presence(timestampMs);
    // Only a hand that has fully returned to idle starts over.
    if (presence === 0 && timestampMs - this.lastSeenMs > LOSS_GRACE_MS) this.reset();
    this.filterMs += Math.min(MAX_FILTER_STEP_MS, Math.max(0, timestampMs - this.lastSeenMs));
    const [offset, ...joints] = [pose.offset, ...pose.joints].map((point, index) => ({
      x: this.filters[index * 3]!.filter(point.x, this.filterMs),
      y: this.filters[index * 3 + 1]!.filter(point.y, this.filterMs),
      z: this.filters[index * 3 + 2]!.filter(point.z, this.filterMs),
    }));
    this.tracked = rigPose(withCanonicalLengths(joints), offset!, pose.palmSide) ?? pose;
    this.seenPresence = presence;
    this.lastSeenMs = timestampMs;
  }

  /** Returns `idle` itself while no hand is present. */
  sample(nowMs: number, idle: HandRigPose): HandRigPose {
    const tracked = this.tracked;
    const presence = this.presence(nowMs);
    if (!tracked || presence === 0) return idle;
    if (presence === 1) return tracked;
    const t = presence * presence * (3 - 2 * presence);
    const joints = withCanonicalLengths(idle.joints.map((joint, index) => mix(joint, tracked.joints[index]!, t)));
    const side = t < 0.5 ? idle.palmSide : tracked.palmSide;
    return rigPose(joints, mix(idle.offset, tracked.offset, t), side) ?? idle;
  }

  reset(): void {
    for (const filter of this.filters) filter.reset();
    this.tracked = undefined;
    this.lastSeenMs = 0;
    this.seenPresence = 0;
    this.filterMs = 0;
  }
}
