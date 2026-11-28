import type { HandObservation, HandSnapshot } from '../providers/handProtocol';
import type { Point3 } from '../types';

export interface Vector2 {
  x: number;
  y: number;
}

export interface Vector3 extends Point3 {}

export interface CanonicalHandFeatures {
  timestampMs: number;
  handedness?: HandObservation['handedness'];
  /** Hand-local coordinates, translated to the wrist and normalized by wrist-to-middle-MCP length. */
  landmarks: readonly Vector3[];
  /** Cosines of the 15 adjacent-bone articulation angles; +1 means a straight finger segment. */
  jointCosines: readonly number[];
  /** First derivative of hand-local landmarks, in palm lengths per second. */
  landmarkVelocities: readonly Vector3[];
  /** Wrist location in normalized image coordinates, for cursor-like consumers. */
  imagePosition?: Vector2;
  /** Wrist velocity normalized by image-space palm size, in palm lengths per second. */
  imageVelocity: Vector2;
}

export interface PalmBasis {
  /** Pinky-to-index palm direction, orthogonalized against the palm length axis. */
  xAxis: Vector3;
  /** Wrist-to-middle-MCP direction. */
  yAxis: Vector3;
  /** Palm normal in a right-handed x × y basis. */
  zAxis: Vector3;
  /** Wrist-to-middle-MCP length in the input coordinate units. */
  palmLength: number;
}

interface PreviousHand {
  timestampMs: number;
  landmarks: readonly Vector3[];
  imagePosition?: Vector2;
  imagePalmLength?: number;
}

const LANDMARK_COUNT = 21;
const MIN_LENGTH = 1e-8;
const FINGER_CHAINS = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [0, 9, 10, 11, 12],
  [0, 13, 14, 15, 16],
  [0, 17, 18, 19, 20],
] as const;

function isFinitePoint(point: Point3 | undefined): point is Point3 {
  return Boolean(point) && Number.isFinite(point!.x) && Number.isFinite(point!.y) && Number.isFinite(point!.z);
}

function subtract(a: Point3, b: Point3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Point3, b: Point3): Vector3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function scale(point: Point3, amount: number): Vector3 {
  return { x: point.x * amount, y: point.y * amount, z: point.z * amount };
}

function length(point: Point3): number {
  return Math.sqrt(dot(point, point));
}

function unit(point: Point3): Vector3 | undefined {
  const magnitude = length(point);
  return magnitude > MIN_LENGTH ? scale(point, 1 / magnitude) : undefined;
}

function articulationCosine(previous: Point3, current: Point3, next: Point3): number | undefined {
  const incoming = unit(subtract(current, previous));
  const outgoing = unit(subtract(next, current));
  if (!incoming || !outgoing) return undefined;
  return Math.max(-1, Math.min(1, dot(incoming, outgoing)));
}

function makeJointCosines(landmarks: readonly Vector3[]): number[] | undefined {
  const cosines: number[] = [];
  for (const chain of FINGER_CHAINS) {
    for (let joint = 1; joint < chain.length - 1; joint += 1) {
      const cosine = articulationCosine(
        landmarks[chain[joint - 1]]!,
        landmarks[chain[joint]]!,
        landmarks[chain[joint + 1]]!,
      );
      if (cosine === undefined) return undefined;
      cosines.push(cosine);
    }
  }
  return cosines;
}

/**
 * Builds the palm orientation in the same 3D camera/world space as the input points. Unlike the
 * canonical hand-local coordinates, this basis deliberately preserves global rotation.
 */
export function palmBasis(points: readonly Point3[]): PalmBasis | undefined {
  if (points.length !== LANDMARK_COUNT || points.some((point) => !isFinitePoint(point))) return undefined;

  const wrist = points[0]!;
  const middleDirection = subtract(points[9]!, wrist);
  const palmLength = length(middleDirection);
  const yAxis = unit(middleDirection);
  if (palmLength <= MIN_LENGTH || !yAxis) return undefined;

  const acrossPalm = subtract(points[5]!, points[17]!);
  const orthogonalAcross = subtract(acrossPalm, scale(yAxis, dot(acrossPalm, yAxis)));
  const xAxis = unit(orthogonalAcross);
  if (!xAxis) return undefined;
  const zAxis = unit(cross(xAxis, yAxis));
  if (!zAxis) return undefined;
  return { xAxis, yAxis, zAxis, palmLength };
}

function canonicalLandmarks(points: readonly Point3[]): { landmarks: Vector3[]; palmLength: number } | undefined {
  const basis = palmBasis(points);
  if (!basis) return undefined;
  const wrist = points[0]!;
  const landmarks = points.map((point) => {
    const relative = scale(subtract(point, wrist), 1 / basis.palmLength);
    return { x: dot(relative, basis.xAxis), y: dot(relative, basis.yAxis), z: dot(relative, basis.zAxis) };
  });
  return { landmarks, palmLength: basis.palmLength };
}

function imagePositionAndScale(points: readonly Point3[]): { position: Vector2; palmLength: number } | undefined {
  if (points.length !== LANDMARK_COUNT || points.some((point) => !isFinitePoint(point))) return undefined;
  const wrist = points[0]!;
  const middleMcp = points[9]!;
  const palmLength = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y);
  if (palmLength <= MIN_LENGTH) return undefined;
  return { position: { x: wrist.x, y: wrist.y }, palmLength };
}

function zeroVelocities(landmarks: readonly Vector3[]): Vector3[] {
  return landmarks.map(() => ({ x: 0, y: 0, z: 0 }));
}

function deriveLandmarkVelocities(
  current: readonly Vector3[],
  previous: readonly Vector3[],
  elapsedSeconds: number,
): Vector3[] {
  return current.map((point, index) => ({
    x: (point.x - previous[index]!.x) / elapsedSeconds,
    y: (point.y - previous[index]!.y) / elapsedSeconds,
    z: (point.z - previous[index]!.z) / elapsedSeconds,
  }));
}

export interface HandFeatureOptions {
  /** Gaps longer than this start a new velocity segment. Defaults to 250 ms. */
  maxVelocityGapMs?: number;
}

/** Converts MediaPipe hand observations to a hand-local, scale-normalized feature stream. */
export class HandFeatureExtractor {
  private readonly maxVelocityGapMs: number;
  private readonly previousHands = new Map<string, PreviousHand>();
  private lastTimestampMs?: number;

  constructor(options: HandFeatureOptions = {}) {
    this.maxVelocityGapMs = options.maxVelocityGapMs ?? 250;
  }

  extract(snapshot: HandSnapshot): CanonicalHandFeatures[] {
    if (!Number.isFinite(snapshot.timestampMs) || snapshot.timestampMs < 0) {
      throw new RangeError('Hand snapshot timestamp must be a finite, non-negative number.');
    }
    if (this.lastTimestampMs !== undefined && snapshot.timestampMs <= this.lastTimestampMs) {
      throw new RangeError(
        'Hand snapshot timestamps must be strictly increasing; reset before replaying a new timeline.',
      );
    }
    this.lastTimestampMs = snapshot.timestampMs;
    if (snapshot.hands.length === 0) {
      this.reset();
      return [];
    }

    const stableIdentities = this.hasStableIdentities(snapshot.hands);
    if (!stableIdentities) this.previousHands.clear();

    const seenHands = new Set<string>();
    const result: CanonicalHandFeatures[] = [];
    snapshot.hands.forEach((hand, index) => {
      const key = hand.handedness ?? `unknown-${index}`;
      const canonical = canonicalLandmarks(hand.worldLandmarks);
      const jointCosines = canonical && makeJointCosines(canonical.landmarks);
      if (!canonical || !jointCosines) {
        this.previousHands.delete(key);
        return;
      }

      const image = imagePositionAndScale(hand.landmarks);
      const previous = stableIdentities ? this.previousHands.get(key) : undefined;
      const elapsedMs = previous ? snapshot.timestampMs - previous.timestampMs : undefined;
      const hasVelocityWindow = elapsedMs !== undefined && elapsedMs > 0 && elapsedMs <= this.maxVelocityGapMs;
      const elapsedSeconds = hasVelocityWindow ? elapsedMs / 1000 : 0;
      const landmarkVelocities =
        hasVelocityWindow && previous
          ? deriveLandmarkVelocities(canonical.landmarks, previous.landmarks, elapsedSeconds)
          : zeroVelocities(canonical.landmarks);
      const imageVelocity = this.imageVelocity(image, previous, elapsedSeconds);

      result.push({
        timestampMs: snapshot.timestampMs,
        handedness: hand.handedness,
        landmarks: canonical.landmarks,
        jointCosines,
        landmarkVelocities,
        imagePosition: image?.position,
        imageVelocity,
      });
      if (stableIdentities) {
        seenHands.add(key);
        this.previousHands.set(key, {
          timestampMs: snapshot.timestampMs,
          landmarks: canonical.landmarks,
          imagePosition: image?.position,
          imagePalmLength: image?.palmLength,
        });
      }
    });

    for (const key of this.previousHands.keys()) {
      if (!seenHands.has(key)) this.previousHands.delete(key);
    }
    return result;
  }

  reset(): void {
    this.previousHands.clear();
    this.lastTimestampMs = undefined;
  }

  private hasStableIdentities(hands: readonly HandObservation[]): boolean {
    const confidentLabels = hands.every((hand) =>
      hand.handednessScore === undefined ||
      (Number.isFinite(hand.handednessScore) && hand.handednessScore >= 0.5),
    );
    if (!confidentLabels) return false;
    if (hands.length <= 1) return true;

    const labels = hands.map((hand) => hand.handedness);
    return labels.every((label) => label !== undefined) && new Set(labels).size === hands.length;
  }

  private imageVelocity(
    current: { position: Vector2; palmLength: number } | undefined,
    previous: PreviousHand | undefined,
    elapsedSeconds: number,
  ): Vector2 {
    if (!current || !previous?.imagePosition || !previous.imagePalmLength || elapsedSeconds === 0)
      return { x: 0, y: 0 };
    const averagePalmLength = (current.palmLength + previous.imagePalmLength) / 2;
    if (averagePalmLength <= MIN_LENGTH) return { x: 0, y: 0 };
    return {
      x: (current.position.x - previous.imagePosition.x) / averagePalmLength / elapsedSeconds,
      y: (current.position.y - previous.imagePosition.y) / averagePalmLength / elapsedSeconds,
    };
  }
}
