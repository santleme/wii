import { OneEuroFilter, type OneEuroOptions } from '../filters/oneEuroFilter';
import { palmBasis, type PalmBasis, type Vector3 } from '../geometry/handFeatures';
import type { Hand, Point3 } from '../types';

export type RotationalFlickPhase =
  | 'IDLE'
  | 'ROTATION_CANDIDATE'
  | 'ROTATING'
  | 'RECOVERY'
  | 'BRAKING'
  | 'SNAP_TO_CARD'
  | 'CANCELLED';

export type RotationalHandShape = 'unknown' | 'open' | 'cupped' | 'neutral' | 'closed';

export type RotationalFlickRejection =
  | 'disabled'
  | 'missing-hand'
  | 'invalid-landmarks'
  | 'invalid-timestamp'
  | 'nonmonotonic-timestamp'
  | 'frame-gap'
  | 'handedness-change'
  | 'hand-shape'
  | 'candidate-timeout'
  | 'direction-reversed';

export interface RotationalFlickConfig {
  /** Strong rotational motion must accumulate for this long before rotation is confirmed. */
  candidateMs: number;
  /** A candidate is abandoned when confirmation does not arrive inside this window. */
  candidateTimeoutMs: number;
  /** Gaps longer than this make the previous orientation unusable for frame-to-frame rotation. */
  maxFrameGapMs: number;
  /** Per-frame rotations smaller than this are treated as tracker noise. */
  frameAngularDeadZoneDeg: number;
  /** Filtered speeds below this have no direction. */
  velocityDeadZoneDegPerSec: number;
  /** Speed needed to enter the rotation candidate state. */
  candidateMinSpeedDegPerSec: number;
  /** Speed needed to leave recovery with the originally committed direction. */
  resumeSpeedDegPerSec: number;
  /** Below this speed an active rotation is considered to be in recovery. */
  recoveryEnterSpeedDegPerSec: number;
  /** Low-speed or returned motion must persist this long before ROTATING becomes RECOVERY. */
  recoveryEnterMs: number;
  /** Recovery ends in a controlled brake after this much time without a new impulse. */
  recoveryTimeoutMs: number;
  /** Opposite motion above this speed can be a deliberate reversal rather than hand return. */
  reversalSpeedDegPerSec: number;
  /** Opposite motion must stay above the reversal speed for this long. Hysteresis: it is higher than resume speed. */
  reversalHoldMs: number;
  /** An open palm must persist this long before ROTATING/RECOVERY becomes BRAKING. */
  openBrakeConfirmMs: number;
  /** Open/closed fingers must persist this long in a candidate before cancelling it as a shape change. */
  candidateShapeCancelMs: number;
  /** The snap request is published after this short confirmation delay once braking starts. */
  brakeSnapDelayMs: number;
  /** SNAP_TO_CARD remains visible long enough for slower camera pipelines and UI frames to observe it. */
  snapSignalMs: number;
  /** Signed multiplier applied to filtered physical velocity. A negative value intentionally reverses direction. */
  sensitivity: number;
  /** Hard clamp for both raw and filtered rotational velocity. */
  maxAngularVelocityDegPerSec: number;
  /** Mean articulation curvature at or below this is an open palm brake. */
  openPalmMaxCurvature: number;
  /** Mean articulation curvature at or above this is cupped enough to rotate. */
  cuppedMinCurvature: number;
  /** Mean articulation curvature above this is a fist/closed hand, not a rotating shell. */
  cuppedMaxCurvature: number;
  smoothing: OneEuroOptions;
}

export type RotationalFlickOptions = Partial<RotationalFlickConfig>;

export const DEFAULT_ROTATIONAL_FLICK_CONFIG: RotationalFlickConfig = {
  candidateMs: 110,
  candidateTimeoutMs: 240,
  maxFrameGapMs: 250,
  frameAngularDeadZoneDeg: 0.05,
  velocityDeadZoneDegPerSec: 12,
  candidateMinSpeedDegPerSec: 70,
  resumeSpeedDegPerSec: 40,
  recoveryEnterSpeedDegPerSec: 24,
  recoveryEnterMs: 40,
  recoveryTimeoutMs: 260,
  reversalSpeedDegPerSec: 95,
  reversalHoldMs: 60,
  openBrakeConfirmMs: 70,
  candidateShapeCancelMs: 70,
  brakeSnapDelayMs: 65,
  snapSignalMs: 300,
  sensitivity: 1,
  maxAngularVelocityDegPerSec: 360,
  openPalmMaxCurvature: 0.06,
  cuppedMinCurvature: 0.13,
  cuppedMaxCurvature: 0.55,
  smoothing: { minCutoff: 1.8, beta: 7, derivativeCutoff: 1 },
};

export interface RotationalFlickSample {
  timestampMs: number;
  worldLandmarks?: readonly Point3[];
  handedness?: Hand | 'Left' | 'Right';
  /** Disabled input is a clean idle reset, not a cancellation. */
  enabled?: boolean;
}

export interface RotationalFlickState {
  timestampMs: number;
  phase: RotationalFlickPhase;
  /** +1/-1 is the committed rotational direction in the detector's camera-aligned z convention. */
  direction: -1 | 0 | 1;
  /** One-Euro-filtered signed velocity after sensitivity, in deg/s. */
  angularVelocityDegPerSec: number;
  /** Velocity the carousel may consume; zero outside an active same-direction impulse. */
  controlAngularVelocityDegPerSec: number;
  /** Unfiltered signed z-axis angular velocity before sensitivity, in deg/s. */
  rawAngularVelocityDegPerSec: number;
  /** 0 means perfectly straight fingers; larger values mean progressively more articulation curl. */
  curvature: number;
  handShape: RotationalHandShape;
  /** Camera-space palm orientation used for this frame. Undefined when the landmarks were unusable. */
  orientation?: PalmBasis;
  /** Real timestamp delta used for the velocity estimate. */
  dtMs?: number;
  rejectionReason?: RotationalFlickRejection;
  active: boolean;
}

const WRIST = 0;
const FINGER_CHAINS = [
  [WRIST, 5, 6, 7, 8],
  [WRIST, 9, 10, 11, 12],
  [WRIST, 13, 14, 15, 16],
  [WRIST, 17, 18, 19, 20],
] as const;
const MIN_LENGTH = 1e-8;
/** Roll around the palm normal is trusted when it dominates the frame-to-frame rotation vector. */
const PALM_ROLL_MIN_ALIGNMENT = 0.6;
/** Camera z must corroborate palm-normal roll, so pure yaw/pitch wobble is not amplified as twist. */
const CAMERA_ROLL_MIN_SHARE = 0.25;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite3(point: Point3 | undefined): point is Point3 {
  return (
    point !== undefined &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Number.isFinite(point.z)
  );
}

function subtract(a: Point3, b: Point3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(point: Point3): number {
  return Math.sqrt(dot(point, point));
}

function unit(point: Point3): Vector3 | undefined {
  const magnitude = length(point);
  return magnitude <= MIN_LENGTH
    ? undefined
    : { x: point.x / magnitude, y: point.y / magnitude, z: point.z / magnitude };
}

function articulationCosine(previous: Point3, current: Point3, next: Point3): number | undefined {
  const incoming = unit(subtract(current, previous));
  const outgoing = unit(subtract(next, current));
  if (!incoming || !outgoing) return undefined;
  return clamp(dot(incoming, outgoing), -1, 1);
}

/** Mean curl of the four long fingers from articulation cosines: open ≈ 0, tightly closed ≈ 1+. */
function fingerCurvature(points: readonly Point3[]): number | undefined {
  if (points.length !== 21 || points.some((point) => !finite3(point))) return undefined;
  const cosines: number[] = [];
  for (const chain of FINGER_CHAINS) {
    for (let joint = 1; joint < chain.length - 1; joint += 1) {
      const cosine = articulationCosine(points[chain[joint - 1]]!, points[chain[joint]]!, points[chain[joint + 1]]!);
      if (cosine === undefined) return undefined;
      cosines.push(cosine);
    }
  }
  return 1 - cosines.reduce((sum, cosine) => sum + cosine, 0) / cosines.length;
}

function normalizeHandedness(value: RotationalFlickSample['handedness']): Hand | undefined {
  const normalized = value?.toLowerCase();
  return normalized === 'left' || normalized === 'right' ? normalized : undefined;
}

type Matrix3 = [number, number, number][];

function basisMatrix(basis: PalmBasis): Matrix3 {
  // Row-major matrix whose columns are the palm basis vectors in camera space.
  return [
    [basis.xAxis.x, basis.yAxis.x, basis.zAxis.x],
    [basis.xAxis.y, basis.yAxis.y, basis.zAxis.y],
    [basis.xAxis.z, basis.yAxis.z, basis.zAxis.z],
  ];
}

function multiplyByTranspose(current: Matrix3, previous: Matrix3): Matrix3 {
  const result: Matrix3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      result[row]![column] =
        current[row]![0]! * previous[column]![0]! +
        current[row]![1]! * previous[column]![1]! +
        current[row]![2]! * previous[column]![2]!;
    }
  }
  return result;
}

/** Axis-angle vector of the relative rotation, in radians. Its z component is continuous across ±180° labels. */
function relativeRotationVector(current: PalmBasis, previous: PalmBasis): Vector3 {
  const rotation = multiplyByTranspose(basisMatrix(current), basisMatrix(previous));
  const skew = {
    x: rotation[2]![1]! - rotation[1]![2]!,
    y: rotation[0]![2]! - rotation[2]![0]!,
    z: rotation[1]![0]! - rotation[0]![1]!,
  };
  const sineLength = length(skew) / 2;
  const cosine = clamp((rotation[0]![0]! + rotation[1]![1]! + rotation[2]![2]! - 1) / 2, -1, 1);
  const angle = Math.atan2(sineLength, cosine);
  if (angle <= 1e-8) return { x: 0, y: 0, z: 0 };

  if (sineLength > 1e-8) {
    const scale = angle / (2 * sineLength);
    return { x: skew.x * scale, y: skew.y * scale, z: skew.z * scale };
  }

  // Exact π rotations have no skew-symmetric part. Recover the axis from the symmetric diagonal;
  // this path is rare for adjacent camera frames but keeps malformed large jumps finite.
  const diagonal = [
    Math.max(0, (rotation[0]![0]! + 1) / 2),
    Math.max(0, (rotation[1]![1]! + 1) / 2),
    Math.max(0, (rotation[2]![2]! + 1) / 2),
  ];
  const largest = diagonal[0]! >= diagonal[1]! && diagonal[0]! >= diagonal[2]! ? 0 : diagonal[1]! >= diagonal[2]! ? 1 : 2;
  const axis = [Math.sqrt(diagonal[0]!), Math.sqrt(diagonal[1]!), Math.sqrt(diagonal[2]!)] as const;
  const mutableAxis = [...axis];
  if (largest === 0) {
    mutableAxis[1] = rotation[0]![1]! / (2 * Math.max(axis[0], MIN_LENGTH));
    mutableAxis[2] = rotation[0]![2]! / (2 * Math.max(axis[0], MIN_LENGTH));
  } else if (largest === 1) {
    mutableAxis[0] = rotation[0]![1]! / (2 * Math.max(axis[1], MIN_LENGTH));
    mutableAxis[2] = rotation[1]![2]! / (2 * Math.max(axis[1], MIN_LENGTH));
  } else {
    mutableAxis[0] = rotation[0]![2]! / (2 * Math.max(axis[2], MIN_LENGTH));
    mutableAxis[1] = rotation[1]![2]! / (2 * Math.max(axis[2], MIN_LENGTH));
  }
  const normalized = unit({ x: mutableAxis[0]!, y: mutableAxis[1]!, z: mutableAxis[2]! }) ?? { x: 0, y: 0, z: 1 };
  return { x: normalized.x * angle, y: normalized.y * angle, z: normalized.z * angle };
}

function mergeConfig(options: RotationalFlickOptions): RotationalFlickConfig {
  return {
    ...DEFAULT_ROTATIONAL_FLICK_CONFIG,
    ...options,
    smoothing: { ...DEFAULT_ROTATIONAL_FLICK_CONFIG.smoothing, ...options.smoothing },
  };
}

function validateConfig(config: RotationalFlickConfig): void {
  const positive = [
    config.candidateMs,
    config.candidateTimeoutMs,
    config.maxFrameGapMs,
    config.candidateMinSpeedDegPerSec,
    config.resumeSpeedDegPerSec,
    config.recoveryEnterSpeedDegPerSec,
    config.recoveryEnterMs,
    config.recoveryTimeoutMs,
    config.reversalSpeedDegPerSec,
    config.reversalHoldMs,
    config.openBrakeConfirmMs,
    config.candidateShapeCancelMs,
    config.brakeSnapDelayMs,
    config.snapSignalMs,
    config.maxAngularVelocityDegPerSec,
  ];
  if (positive.some((value) => !Number.isFinite(value) || value <= 0))
    throw new Error('Rotational flick timing, speed, and gap parameters must be positive finite numbers');
  if (config.cuppedMinCurvature >= config.cuppedMaxCurvature)
    throw new Error('Cupped minimum curvature must be below the maximum curvature');
  if (config.openPalmMaxCurvature >= config.cuppedMinCurvature)
    throw new Error('Open-palm curvature must remain below the cupped rotation threshold');
  if (!Number.isFinite(config.sensitivity) || config.sensitivity === 0)
    throw new Error('Rotational flick sensitivity must be a finite non-zero number');
}

function isActivePhase(phase: RotationalFlickPhase): boolean {
  return (
    phase === 'ROTATION_CANDIDATE' ||
    phase === 'ROTATING' ||
    phase === 'RECOVERY' ||
    phase === 'BRAKING' ||
    phase === 'SNAP_TO_CARD'
  );
}

/**
 * Pure rotational impulse detector over camera-space MediaPipe world landmarks. It consumes only
 * orientation bases and timestamps; it never reads DOM state, angles with wrap-around labels, or wall time.
 */
export class RotationalFlickDetector {
  private readonly config: RotationalFlickConfig;
  private readonly velocityFilter: OneEuroFilter;
  private phase: RotationalFlickPhase = 'IDLE';
  private phaseSinceMs?: number;
  private previousBasis?: PalmBasis;
  private previousTimestampMs?: number;
  private previousHandedness?: Hand;
  private candidateDirection: -1 | 0 | 1 = 0;
  private committedDirection: -1 | 0 | 1 = 0;
  private strongCandidateMs = 0;
  private lowSpeedSinceMs?: number;
  private reversalSinceMs?: number;
  private openShapeSinceMs?: number;
  private invalidCandidateShapeSinceMs?: number;
  private frameRejection?: RotationalFlickRejection;

  constructor(options: RotationalFlickOptions = {}) {
    this.config = mergeConfig(options);
    validateConfig(this.config);
    this.velocityFilter = new OneEuroFilter(this.config.smoothing);
  }

  update(sample: RotationalFlickSample): RotationalFlickState {
    this.frameRejection = undefined;
    if (sample.enabled === false) {
      this.reset();
      return this.state(sample.timestampMs, {
        rejectionReason: 'disabled',
      });
    }

    const handedness = normalizeHandedness(sample.handedness);
    const points = sample.worldLandmarks;
    const basis = points ? palmBasis(points) : undefined;
    if (!Number.isFinite(sample.timestampMs) || sample.timestampMs < 0) {
      return this.invalidate(sample.timestampMs, 'invalid-timestamp');
    }
    if (!points) return this.invalidate(sample.timestampMs, 'missing-hand');
    if (!basis) return this.invalidate(sample.timestampMs, 'invalid-landmarks');

    if (this.previousTimestampMs !== undefined) {
      const dtMs = sample.timestampMs - this.previousTimestampMs;
      if (dtMs <= 0) return this.invalidate(sample.timestampMs, 'nonmonotonic-timestamp', basis, handedness);
      if (dtMs > this.config.maxFrameGapMs)
        return this.invalidate(sample.timestampMs, 'frame-gap', basis, handedness);
    }
    if (
      handedness !== undefined &&
      this.previousHandedness !== undefined &&
      handedness !== this.previousHandedness
    ) {
      return this.invalidate(sample.timestampMs, 'handedness-change', basis, handedness);
    }

    if (this.phase === 'CANCELLED') this.phase = 'IDLE';

    const curvature = fingerCurvature(points);
    const handShape = this.shape(curvature);
    const dtMs = this.previousTimestampMs === undefined ? undefined : sample.timestampMs - this.previousTimestampMs;
    const rawAngularVelocityDegPerSec = this.angularVelocity(basis, dtMs);
    const filteredPhysical = this.velocityFilter.filter(rawAngularVelocityDegPerSec, sample.timestampMs);
    const angularVelocityDegPerSec = clamp(
      filteredPhysical * this.config.sensitivity,
      -this.config.maxAngularVelocityDegPerSec,
      this.config.maxAngularVelocityDegPerSec,
    );

    const controlAngularVelocityDegPerSec = this.advance(sample.timestampMs, dtMs, angularVelocityDegPerSec, handShape);
    const direction = this.phase === 'ROTATION_CANDIDATE' ? this.candidateDirection : this.committedDirection;
    const state = this.state(sample.timestampMs, {
      direction: isActivePhase(this.phase) ? direction : 0,
      angularVelocityDegPerSec,
      controlAngularVelocityDegPerSec,
      rawAngularVelocityDegPerSec,
      curvature: curvature ?? 0,
      handShape,
      orientation: basis,
      dtMs,
      rejectionReason: this.frameRejection,
    });

    this.previousBasis = basis;
    this.previousTimestampMs = sample.timestampMs;
    this.previousHandedness = handedness ?? this.previousHandedness;
    return state;
  }

  reset(): void {
    this.phase = 'IDLE';
    this.phaseSinceMs = undefined;
    this.previousBasis = undefined;
    this.previousTimestampMs = undefined;
    this.previousHandedness = undefined;
    this.candidateDirection = 0;
    this.committedDirection = 0;
    this.strongCandidateMs = 0;
    this.lowSpeedSinceMs = undefined;
    this.reversalSinceMs = undefined;
    this.openShapeSinceMs = undefined;
    this.invalidCandidateShapeSinceMs = undefined;
    this.frameRejection = undefined;
    this.velocityFilter.reset();
  }

  private angularVelocity(current: PalmBasis, dtMs: number | undefined): number {
    if (!this.previousBasis || dtMs === undefined || dtMs <= 0) return 0;
    const rotation = relativeRotationVector(current, this.previousBasis);
    const angleDeg = (length(rotation) * 180) / Math.PI;
    if (angleDeg < this.config.frameAngularDeadZoneDeg) return 0;
    const radians = this.rollRadians(rotation, this.previousBasis);
    const radiansPerSecond = radians / (dtMs / 1000);
    return clamp(
      (radiansPerSecond * 180) / Math.PI,
      -this.config.maxAngularVelocityDegPerSec,
      this.config.maxAngularVelocityDegPerSec,
    );
  }

  /**
   * Camera z is the conservative roll measurement. When the same rotation is dominantly about
   * the palm normal and camera z corroborates its direction, use the palm-normal projection so a
   * naturally tilted hand is not under-measured; pure yaw/pitch stays on the camera-z channel.
   */
  private rollRadians(rotation: Vector3, previousBasis: PalmBasis): number {
    const cameraRoll = rotation.z;
    const palmRoll = dot(rotation, previousBasis.zAxis);
    const magnitude = length(rotation);
    if (magnitude <= MIN_LENGTH) return cameraRoll;
    const palmAlignment = Math.abs(palmRoll) / magnitude;
    const cameraShare = Math.abs(cameraRoll) / Math.max(Math.abs(palmRoll), MIN_LENGTH);
    const consistent = Math.sign(cameraRoll) === Math.sign(palmRoll) && cameraShare >= CAMERA_ROLL_MIN_SHARE;
    if (palmAlignment >= PALM_ROLL_MIN_ALIGNMENT && consistent && Math.abs(palmRoll) > Math.abs(cameraRoll)) {
      return palmRoll;
    }
    return cameraRoll;
  }

  private shape(curvature: number | undefined): RotationalHandShape {
    if (curvature === undefined) return 'unknown';
    if (curvature <= this.config.openPalmMaxCurvature) return 'open';
    if (curvature >= this.config.cuppedMinCurvature && curvature <= this.config.cuppedMaxCurvature) return 'cupped';
    if (curvature > this.config.cuppedMaxCurvature) return 'closed';
    return 'neutral';
  }

  private advance(
    timestampMs: number,
    dtMs: number | undefined,
    velocityDegPerSec: number,
    handShape: RotationalHandShape,
  ): number {
    const speed = Math.abs(velocityDegPerSec);
    const moveDirection = speed >= this.config.velocityDeadZoneDegPerSec ? (Math.sign(velocityDegPerSec) as -1 | 1) : 0;

    if (this.phase === 'BRAKING') {
      if (timestampMs - (this.phaseSinceMs ?? timestampMs) >= this.config.brakeSnapDelayMs) {
        this.enter('SNAP_TO_CARD', timestampMs);
      }
      return 0;
    }

    if (this.phase === 'SNAP_TO_CARD') {
      if (timestampMs - (this.phaseSinceMs ?? timestampMs) >= this.config.snapSignalMs) {
        this.enter('IDLE', timestampMs);
        this.committedDirection = 0;
      }
      return 0;
    }

    if (this.phase === 'ROTATING' || this.phase === 'RECOVERY') {
      if (handShape === 'open') {
        this.openShapeSinceMs ??= timestampMs;
        if (timestampMs - this.openShapeSinceMs >= this.config.openBrakeConfirmMs) {
          this.enter('BRAKING', timestampMs);
          return 0;
        }
      } else {
        this.openShapeSinceMs = undefined;
      }
    }

    if (this.phase === 'ROTATION_CANDIDATE') {
      const invalidShape = handShape === 'open' || handShape === 'closed';
      if (invalidShape) {
        this.invalidCandidateShapeSinceMs ??= timestampMs;
        if (timestampMs - this.invalidCandidateShapeSinceMs >= this.config.candidateShapeCancelMs) {
          return this.cancel('hand-shape', timestampMs);
        }
      } else {
        this.invalidCandidateShapeSinceMs = undefined;
        const oppositeImpulse =
          this.candidateDirection !== 0 && moveDirection === -this.candidateDirection && speed >= this.config.reversalSpeedDegPerSec;
        if (oppositeImpulse) return this.cancel('direction-reversed', timestampMs);
        if (moveDirection === this.candidateDirection && speed >= this.config.candidateMinSpeedDegPerSec) {
          this.strongCandidateMs += dtMs ?? 0;
        }
        if (this.strongCandidateMs >= this.config.candidateMs) {
          this.committedDirection = this.candidateDirection;
          this.enter('ROTATING', timestampMs);
          return velocityDegPerSec;
        }
      }
      if (timestampMs - (this.phaseSinceMs ?? timestampMs) > this.config.candidateTimeoutMs) {
        return this.cancel('candidate-timeout', timestampMs);
      }
      return 0;
    }

    if (this.phase === 'ROTATING') {
      if (handShape === 'closed') return this.cancel('hand-shape', timestampMs);
      if (moveDirection !== 0 && moveDirection !== this.committedDirection) {
        this.enter('RECOVERY', timestampMs);
        this.reversalSinceMs = undefined;
        return 0;
      }
      if (moveDirection === this.committedDirection && speed >= this.config.recoveryEnterSpeedDegPerSec) {
        this.lowSpeedSinceMs = undefined;
        return velocityDegPerSec;
      }
      this.lowSpeedSinceMs ??= timestampMs;
      if (timestampMs - this.lowSpeedSinceMs >= this.config.recoveryEnterMs) {
        this.enter('RECOVERY', timestampMs);
      }
      return 0;
    }

    if (this.phase === 'RECOVERY') {
      if (handShape === 'closed') return this.cancel('hand-shape', timestampMs);
      if (moveDirection === this.committedDirection && speed >= this.config.resumeSpeedDegPerSec) {
        this.enter('ROTATING', timestampMs);
        this.reversalSinceMs = undefined;
        return velocityDegPerSec;
      }
      const reversalImpulse =
        this.committedDirection !== 0 && moveDirection === -this.committedDirection && speed >= this.config.reversalSpeedDegPerSec;
      if (reversalImpulse) {
        this.reversalSinceMs ??= timestampMs;
        if (timestampMs - this.reversalSinceMs >= this.config.reversalHoldMs) {
          this.committedDirection = moveDirection;
          this.enter('ROTATING', timestampMs);
          this.reversalSinceMs = undefined;
          return velocityDegPerSec;
        }
      } else {
        this.reversalSinceMs = undefined;
      }
      if (timestampMs - (this.phaseSinceMs ?? timestampMs) >= this.config.recoveryTimeoutMs) {
        this.enter('BRAKING', timestampMs);
      }
      return 0;
    }

    if (
      this.phase === 'IDLE' &&
      handShape === 'cupped' &&
      moveDirection !== 0 &&
      speed >= this.config.candidateMinSpeedDegPerSec &&
      dtMs !== undefined
    ) {
      this.phase = 'ROTATION_CANDIDATE';
      this.phaseSinceMs = timestampMs;
      this.candidateDirection = moveDirection;
      // A slow frame must not fill the window by itself: a second strong sample is always needed.
      this.strongCandidateMs = Math.min(dtMs, this.config.candidateMs / 2);
      this.lowSpeedSinceMs = undefined;
      this.reversalSinceMs = undefined;
      this.invalidCandidateShapeSinceMs = undefined;
    }
    return 0;
  }

  private enter(phase: RotationalFlickPhase, timestampMs: number): void {
    this.phase = phase;
    this.phaseSinceMs = timestampMs;
    if (phase !== 'ROTATION_CANDIDATE') {
      this.strongCandidateMs = 0;
      this.invalidCandidateShapeSinceMs = undefined;
    }
    if (phase !== 'ROTATING' && phase !== 'RECOVERY') this.openShapeSinceMs = undefined;
    if (phase !== 'ROTATING') this.lowSpeedSinceMs = undefined;
  }

  private cancel(reason: RotationalFlickRejection, timestampMs: number): number {
    this.frameRejection = reason;
    this.enter('CANCELLED', timestampMs);
    this.candidateDirection = 0;
    this.committedDirection = 0;
    this.strongCandidateMs = 0;
    this.reversalSinceMs = undefined;
    return 0;
  }

  private invalidate(
    timestampMs: number,
    reason: RotationalFlickRejection,
    basis?: PalmBasis,
    handedness?: Hand,
  ): RotationalFlickState {
    const wasActive = isActivePhase(this.phase);
    this.phase = wasActive ? 'CANCELLED' : 'IDLE';
    this.phaseSinceMs = Number.isFinite(timestampMs) ? timestampMs : undefined;
    this.candidateDirection = 0;
    this.committedDirection = 0;
    this.strongCandidateMs = 0;
    this.lowSpeedSinceMs = undefined;
    this.reversalSinceMs = undefined;
    this.openShapeSinceMs = undefined;
    this.invalidCandidateShapeSinceMs = undefined;
    this.velocityFilter.reset();
    this.previousBasis = basis;
    this.previousTimestampMs = Number.isFinite(timestampMs) && timestampMs >= 0 ? timestampMs : undefined;
    this.previousHandedness = handedness;
    return this.state(timestampMs, {
      phase: this.phase,
      rejectionReason: reason,
    });
  }

  private state(
    timestampMs: number,
    overrides: Partial<RotationalFlickState> & Pick<RotationalFlickState, never> = {},
  ): RotationalFlickState {
    const phase = overrides.phase ?? this.phase;
    return {
      timestampMs,
      phase,
      direction: 0,
      angularVelocityDegPerSec: 0,
      controlAngularVelocityDegPerSec: 0,
      rawAngularVelocityDegPerSec: 0,
      curvature: 0,
      handShape: 'unknown',
      rejectionReason: undefined,
      ...overrides,
      active: isActivePhase(phase),
    };
  }
}
