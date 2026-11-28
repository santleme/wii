import type { CalibrationProfile, Point3, PoseSnapshot } from '@wii/spatial-core';
import { type BodyBasis, bodyBasis } from './bodyFrame';
import { OneEuroFilter } from '@wii/spatial-core';
import { distance3, landmarkConfidence, midpoint } from './math';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const BODY_LANDMARK_COUNT = 33;

/**
 * Articulation cosines in this fixed order; each is the cosine between the two bones meeting at
 * the middle landmark (+1 means a straight segment). A joint reads 0 when any of its landmarks
 * was too uncertain to use.
 */
export const BODY_JOINTS = [
  ['leftElbow', 11, 13, 15],
  ['rightElbow', 12, 14, 16],
  ['leftKnee', 23, 25, 27],
  ['rightKnee', 24, 26, 28],
  ['leftShoulder', 23, 11, 13],
  ['rightShoulder', 24, 12, 14],
  ['leftHip', 11, 23, 25],
  ['rightHip', 12, 24, 26],
] as const;

const LEFT_WRIST = 15;
const RIGHT_WRIST = 16;
const LEFT_KNEE = 25;
const RIGHT_KNEE = 26;
const LEFT_ANKLE = 27;
const RIGHT_ANKLE = 28;
const CORE_MIN_CONFIDENCE = 0.55;
const LANDMARK_MIN_CONFIDENCE = 0.4;
const MIN_SCALE = 0.05;

export interface CanonicalBodyFeatures {
  timestampMs: number;
  /**
   * All 33 landmarks in a body-local frame: hip-centre origin, side/up/depth axes from the
   * shoulder and hip lines, shoulder-width scale. Landmarks below the confidence floor read as
   * zero vectors so the vector keeps a fixed dimension for downstream matchers.
   */
  landmarksLocal: readonly Vec3[];
  /** Cosines for {@link BODY_JOINTS}; 0 when the joint could not be measured this frame. */
  jointCosines: readonly number[];
  /**
   * Knee height along the body-local up axis (shoulder-width units); a raised knee reads higher.
   * NaN when the knee was not measurable this frame — consumers must skip non-finite values,
   * since no numeric sentinel can represent a missing measurement inside the valid range.
   */
  kneeLiftLeft: number;
  kneeLiftRight: number;
  /** Wrist velocity in the body-local frame, shoulder-widths/s, OneEuro-filtered. */
  wristVelocityLeft: Vec3;
  wristVelocityRight: Vec3;
  /** Wrist height above the shoulder line (shoulder widths); positive when the fist is raised. */
  wristHeightLeft: number;
  wristHeightRight: number;
  /** Horizontal ankle separation in shoulder widths. */
  stanceWidth: number;
}

interface PreviousBody {
  timestampMs: number;
  /** Filtered wrist world positions used as the base of the next velocity difference. */
  filteredWrists: { left: Vec3; right: Vec3 };
  /** Whether each wrist was usable in the previous frame (world and image confident). */
  wristValid: { left: boolean; right: boolean };
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

function isFinitePoint(point: Point3 | undefined): point is Point3 {
  return (
    point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
  );
}

function dot(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function subtract(a: Point3, b: Point3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function unit(a: Point3, b: Point3): Vec3 | undefined {
  const direction = subtract(a, b);
  const magnitude = Math.hypot(direction.x, direction.y, direction.z);
  if (magnitude <= 1e-8) return undefined;
  return { x: direction.x / magnitude, y: direction.y / magnitude, z: direction.z / magnitude };
}

function articulationCosine(previous: Point3, joint: Point3, next: Point3): number | undefined {
  const incoming = unit(joint, previous);
  const outgoing = unit(next, joint);
  if (!incoming || !outgoing) return undefined;
  const cosine = dot(incoming, outgoing);
  return Math.max(-1, Math.min(1, cosine));
}

/** A landmark counts as present only when both its image and world observations are confident. */
function usable(worldPoint: Point3 | undefined, imagePoint?: Point3): worldPoint is Point3 {
  return (
    isFinitePoint(worldPoint) &&
    landmarkConfidence(worldPoint) >= LANDMARK_MIN_CONFIDENCE &&
    imagePoint !== undefined &&
    isFinitePoint(imagePoint) &&
    landmarkConfidence(imagePoint) >= LANDMARK_MIN_CONFIDENCE
  );
}

/** Rotates a world-axis vector into the body frame so lateral/forward mean body-relative directions. */
function rotateIntoBody(vector: Vec3, basis: BodyBasis): Vec3 {
  return {
    x: vector.x * basis.side.x + vector.y * basis.side.y + vector.z * basis.side.z,
    y: vector.x * basis.up.x + vector.y * basis.up.y + vector.z * basis.up.z,
    z: vector.x * basis.depth.x + vector.y * basis.depth.y + vector.z * basis.depth.z,
  };
}

/**
 * Converts pose snapshots into a scale- and orientation-normalized feature stream, mirroring
 * HandFeatureExtractor for the full body. Works without a calibration profile: normalization
 * falls back to the frame's own shoulder width, so the stream stays valid while calibration is
 * absent or being replaced.
 */
export class BodyFeatureExtractor {
  private readonly maxVelocityGapMs: number;
  private previous?: PreviousBody;
  private lastTimestampMs?: number;
  /** One filtering chain per wrist axis; positions are smoothed before differentiation. */
  private readonly wristFilters = {
    left: { x: new OneEuroFilter(), y: new OneEuroFilter(), z: new OneEuroFilter() },
    right: { x: new OneEuroFilter(), y: new OneEuroFilter(), z: new OneEuroFilter() },
  };

  constructor(options: { maxVelocityGapMs?: number } = {}) {
    this.maxVelocityGapMs = options.maxVelocityGapMs ?? 250;
  }

  extract(snapshot: PoseSnapshot, calibration?: CalibrationProfile): CanonicalBodyFeatures | undefined {
    if (!Number.isFinite(snapshot.timestampMs) || snapshot.timestampMs < 0) {
      throw new RangeError('Body snapshot timestamp must be a finite, non-negative number.');
    }
    if (this.lastTimestampMs !== undefined && snapshot.timestampMs <= this.lastTimestampMs) {
      throw new RangeError(
        'Body snapshot timestamps must be strictly increasing; reset before replaying a new timeline.',
      );
    }
    this.lastTimestampMs = snapshot.timestampMs;

    const world = snapshot.worldLandmarks;
    const image = snapshot.landmarks;
    if (world.length < BODY_LANDMARK_COUNT) {
      this.invalidateVelocityChain();
      return undefined;
    }
    const leftShoulder = world[11]!;
    const rightShoulder = world[12]!;
    const leftHip = world[23];
    const rightHip = world[24];
    const shouldersWorld = [leftShoulder, rightShoulder];
    const shouldersImage = [image[11], image[12]];
    const shouldersBad =
      shouldersWorld.some((point) => !isFinitePoint(point)) ||
      !shouldersWorld.every((point) => landmarkConfidence(point) >= CORE_MIN_CONFIDENCE) ||
      shouldersImage.some((point) => !isFinitePoint(point)) ||
      !shouldersImage.every((point) => landmarkConfidence(point!) >= CORE_MIN_CONFIDENCE);
    if (shouldersBad) {
      this.invalidateVelocityChain();
      return undefined;
    }
    const hipsUsable =
      isFinitePoint(leftHip) &&
      isFinitePoint(rightHip) &&
      landmarkConfidence(leftHip, rightHip) >= LANDMARK_MIN_CONFIDENCE &&
      isFinitePoint(image[23]) &&
      isFinitePoint(image[24]) &&
      landmarkConfidence(image[23]!, image[24]!) >= LANDMARK_MIN_CONFIDENCE;

    // Degenerate geometry (shoulder line or torso direction collapsed) is rejected rather than
    // clamped: MIN_SCALE only guards the arithmetic, it must not manufacture plausible garbage.
    const basis = bodyBasis(leftShoulder, rightShoulder, hipsUsable ? leftHip : undefined, hipsUsable ? rightHip : undefined);
    if (!basis) {
      this.invalidateVelocityChain();
      return undefined;
    }

    const scale = Math.max(calibration?.world.shoulderWidth ?? distance3(leftShoulder, rightShoulder), MIN_SCALE);
    const shoulderMid = midpoint(leftShoulder, rightShoulder);
    const hipMid = hipsUsable && leftHip && rightHip
      ? midpoint(leftHip, rightHip)
      : {
          x: shoulderMid.x - basis.up.x * scale * 1.25,
          y: shoulderMid.y - basis.up.y * scale * 1.25,
          z: shoulderMid.z - basis.up.z * scale * 1.25,
        };

    const project = (point: Point3): Vec3 => {
      const relX = point.x - hipMid.x;
      const relY = point.y - hipMid.y;
      const relZ = point.z - hipMid.z;
      return {
        x: (relX * basis.side.x + relY * basis.side.y + relZ * basis.side.z) / scale,
        y: (relX * basis.up.x + relY * basis.up.y + relZ * basis.up.z) / scale,
        z: (relX * basis.depth.x + relY * basis.depth.y + relZ * basis.depth.z) / scale,
      };
    };

    const landmarksLocal = world.map((point, index) => {
      if (!usable(point, image[index])) return ZERO;
      return project(point);
    });

    const jointCosines = BODY_JOINTS.map(([, a, b, c]) => {
      if (!usable(world[a], image[a]) || !usable(world[b], image[b]) || !usable(world[c], image[c])) return 0;
      return articulationCosine(world[a]!, world[b]!, world[c]!) ?? 0;
    });

    const previous = this.previous;
    const gapValid =
      previous !== undefined && snapshot.timestampMs - previous.timestampMs <= this.maxVelocityGapMs;

    // Wrist velocities follow a stricter path than the generic array: positions are OneEuro-filtered
    // before differentiation (cm-level landmark jitter otherwise amplifies into phantom speed), the
    // difference requires both endpoints usable in world and image, and the result is rotated into
    // the body frame so x/z mean body-lateral/body-forward regardless of player yaw.
    const filterWrist = (index: number, side: 'left' | 'right'): Vec3 | undefined => {
      const point = world[index];
      if (!usable(point, image[index])) return undefined;
      const filters = this.wristFilters[side];
      return {
        x: filters.x.filter(point.x, snapshot.timestampMs),
        y: filters.y.filter(point.y, snapshot.timestampMs),
        z: filters.z.filter(point.z, snapshot.timestampMs),
      };
    };
    const filteredLeft = filterWrist(LEFT_WRIST, 'left');
    const filteredRight = filterWrist(RIGHT_WRIST, 'right');

    const wristVelocity = (filtered: Vec3 | undefined, base: Vec3 | undefined, validBefore: boolean | undefined): Vec3 => {
      const seconds = previous ? (snapshot.timestampMs - previous.timestampMs) / 1000 : 0;
      if (!filtered || !base || validBefore !== true || !gapValid || seconds <= 0) return ZERO;
      return rotateIntoBody(
        {
          x: (filtered.x - base.x) / seconds / scale,
          y: (filtered.y - base.y) / seconds / scale,
          z: (filtered.z - base.z) / seconds / scale,
        },
        basis,
      );
    };
    const wristVelocityLeft = wristVelocity(filteredLeft, previous?.filteredWrists.left, previous?.wristValid.left);
    const wristVelocityRight = wristVelocity(filteredRight, previous?.filteredWrists.right, previous?.wristValid.right);

    const height = (index: number) => {
      const point = world[index];
      return usable(point, image[index]) ? (shoulderMid.y - point.y) / scale : 0;
    };

    const features: CanonicalBodyFeatures = {
      timestampMs: snapshot.timestampMs,
      landmarksLocal,
      jointCosines,
      kneeLiftLeft: usable(world[LEFT_KNEE], image[LEFT_KNEE]) ? landmarksLocal[LEFT_KNEE]!.y : NaN,
      kneeLiftRight: usable(world[RIGHT_KNEE], image[RIGHT_KNEE]) ? landmarksLocal[RIGHT_KNEE]!.y : NaN,
      wristVelocityLeft,
      wristVelocityRight,
      wristHeightLeft: height(LEFT_WRIST),
      wristHeightRight: height(RIGHT_WRIST),
      stanceWidth:
        usable(world[LEFT_ANKLE], image[LEFT_ANKLE]) && usable(world[RIGHT_ANKLE], image[RIGHT_ANKLE])
          ? Math.hypot(world[LEFT_ANKLE]!.x - world[RIGHT_ANKLE]!.x, world[LEFT_ANKLE]!.z - world[RIGHT_ANKLE]!.z) /
            scale
          : 0,
    };

    this.previous = {
      timestampMs: snapshot.timestampMs,
      filteredWrists: {
        left: filteredLeft ?? { x: 0, y: 0, z: 0 },
        right: filteredRight ?? { x: 0, y: 0, z: 0 },
      },
      wristValid: { left: filteredLeft !== undefined, right: filteredRight !== undefined },
    };
    return features;
  }

  reset(): void {
    this.previous = undefined;
    this.lastTimestampMs = undefined;
    for (const side of ['left', 'right'] as const) {
      for (const axis of ['x', 'y', 'z'] as const) this.wristFilters[side][axis].reset();
    }
  }

  private invalidateVelocityChain(): void {
    this.previous = undefined;
    for (const side of ['left', 'right'] as const) {
      for (const axis of ['x', 'y', 'z'] as const) this.wristFilters[side][axis].reset();
    }
  }
}
