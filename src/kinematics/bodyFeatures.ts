import type { CalibrationProfile, Point3, PoseSnapshot } from '../cv/protocol';
import { bodyLocalPoint } from './bodyFrame';
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
  /** Per-landmark velocity in world axes, shoulder-widths/s; zero without a valid previous frame. */
  landmarkVelocities: readonly Vec3[];
  /** Knee height along the body-local up axis (shoulder-width units); a raised knee reads higher. */
  kneeLiftLeft: number;
  kneeLiftRight: number;
  /** Mid-hip height in world units of shoulder widths; only deltas across frames are meaningful. */
  midHipY: number;
  /** Wrist velocity in world axes, shoulder-widths/s. */
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
  world: readonly Point3[];
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
    (!imagePoint || (isFinitePoint(imagePoint) && landmarkConfidence(imagePoint) >= LANDMARK_MIN_CONFIDENCE))
  );
}

function velocities(
  world: readonly Point3[],
  image: readonly Point3[],
  previous: PreviousBody | undefined,
  timestampMs: number,
  scale: number,
): Vec3[] {
  const seconds = previous ? (timestampMs - previous.timestampMs) / 1000 : 0;
  return world.map((point, index) => {
    const before = previous?.world[index];
    if (!usable(point, image[index]) || !before || !usable(before) || seconds <= 0) return ZERO;
    return {
      x: (point.x - before.x) / seconds / scale,
      y: (point.y - before.y) / seconds / scale,
      z: (point.z - before.z) / seconds / scale,
    };
  });
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
    const leftShoulder = world[11];
    const rightShoulder = world[12];
    const leftHip = world[23];
    const rightHip = world[24];
    const image = snapshot.landmarks;
    const core = [leftShoulder, rightShoulder, leftHip, rightHip];
    if (core.some((point) => !isFinitePoint(point)) || landmarkConfidence(...core) < CORE_MIN_CONFIDENCE
      || landmarkConfidence(image[11]!, image[12]!, image[23]!, image[24]!) < CORE_MIN_CONFIDENCE) {
      this.previous = undefined;
      return undefined;
    }

    const scale = Math.max(calibration?.world.shoulderWidth ?? distance3(leftShoulder, rightShoulder), MIN_SCALE);
    const hipMid = midpoint(leftHip, rightHip);
    const shoulderMid = midpoint(leftShoulder, rightShoulder);

    const landmarksLocal = world.map((point, index) => {
      if (!usable(point, image[index])) return ZERO;
      return (
        bodyLocalPoint(point, hipMid, leftShoulder, rightShoulder, leftHip, rightHip, scale) ?? ZERO
      );
    });

    const jointCosines = BODY_JOINTS.map(([, a, b, c]) => {
      if (!usable(world[a], image[a]) || !usable(world[b], image[b]) || !usable(world[c], image[c])) return 0;
      return articulationCosine(world[a]!, world[b]!, world[c]!) ?? 0;
    });

    const previous = this.previous;
    const gapValid =
      previous !== undefined && snapshot.timestampMs - previous.timestampMs <= this.maxVelocityGapMs;
    const landmarkVelocities = velocities(world, image, gapValid ? previous : undefined, snapshot.timestampMs, scale);

    const height = (index: number) => {
      const point = world[index];
      return usable(point, image[index]) ? (shoulderMid.y - point.y) / scale : 0;
    };

    const features: CanonicalBodyFeatures = {
      timestampMs: snapshot.timestampMs,
      landmarksLocal,
      jointCosines,
      landmarkVelocities,
      kneeLiftLeft: landmarksLocal[LEFT_KNEE]!.y,
      kneeLiftRight: landmarksLocal[RIGHT_KNEE]!.y,
      midHipY: hipMid.y / scale,
      wristVelocityLeft: landmarkVelocities[LEFT_WRIST]!,
      wristVelocityRight: landmarkVelocities[RIGHT_WRIST]!,
      wristHeightLeft: height(LEFT_WRIST),
      wristHeightRight: height(RIGHT_WRIST),
      stanceWidth:
        usable(world[LEFT_ANKLE], image[LEFT_ANKLE]) && usable(world[RIGHT_ANKLE], image[RIGHT_ANKLE])
          ? Math.hypot(world[LEFT_ANKLE]!.x - world[RIGHT_ANKLE]!.x, world[LEFT_ANKLE]!.z - world[RIGHT_ANKLE]!.z) /
            scale
          : 0,
    };

    this.previous = { timestampMs: snapshot.timestampMs, world };
    return features;
  }

  reset(): void {
    this.previous = undefined;
    this.lastTimestampMs = undefined;
  }
}
