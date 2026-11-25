import type { Point3, PoseSnapshot } from '../cv/protocol';
import { landmarkConfidence, midpoint } from './math';

const EPSILON = 1e-6;
const KNEE_CONFIDENCE_MIN = 0.55;
const MIN_LEG_SPAN = 0.1;
const STRAIGHT_LEG_DOT = Math.cos(0.2);

function subtract(a: Point3, b: Point3): Point3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(vector: Point3): Point3 | undefined {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (magnitude < EPSILON) return undefined;
  return { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude };
}

function cross(a: Point3, b: Point3): Point3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export interface BodyBasis {
  side: Point3;
  up: Point3;
  depth: Point3;
}

/**
 * Orthonormal body frame: shoulder-line side, torso up orthogonalized against it, depth as
 * their cross product. Undefined when the shoulder line or the torso direction is degenerate.
 */
export function bodyBasis(
  leftShoulder: Point3,
  rightShoulder: Point3,
  leftHip: Point3,
  rightHip: Point3,
): BodyBasis | undefined {
  const side = normalize(subtract(rightShoulder, leftShoulder));
  if (!side) return undefined;

  const shoulders = midpoint(leftShoulder, rightShoulder);
  const hips = midpoint(leftHip, rightHip);
  const torso = subtract(shoulders, hips);
  const torsoProjection = dot(torso, side);
  const up = normalize({
    x: torso.x - side.x * torsoProjection,
    y: torso.y - side.y * torsoProjection,
    z: torso.z - side.z * torsoProjection,
  });
  if (!up) return undefined;
  const depth = normalize(cross(side, up));
  if (!depth) return undefined;
  return { side, up, depth };
}

export function bodyLocalPoint(
  point: Point3,
  shoulder: Point3,
  leftShoulder: Point3,
  rightShoulder: Point3,
  leftHip: Point3,
  rightHip: Point3,
  scale: number,
): Point3 | undefined {
  if (!Number.isFinite(scale) || scale <= EPSILON) return undefined;
  const basis = bodyBasis(leftShoulder, rightShoulder, leftHip, rightHip);
  if (!basis) return undefined;

  const relative = subtract(point, shoulder);
  return {
    x: dot(relative, basis.side) / scale,
    y: dot(relative, basis.up) / scale,
    z: dot(relative, basis.depth) / scale,
  };
}

/**
 * Standing vertical estimated from the legs: hip midpoint minus knee midpoint points up along
 * gravity regardless of trunk posture — but only while the knees are extended, so the shin
 * direction (knee midpoint minus ankle midpoint) must roughly agree, otherwise a bent-knee stance
 * would store a tilted thigh as the vertical. The calibrator uses it to capture the fixed lean
 * reference at neutral. Undefined when knees or ankles are hidden, tucked or bent.
 */
export function legsVertical(snapshot: PoseSnapshot): Point3 | undefined {
  const leftHip = snapshot.worldLandmarks[23];
  const rightHip = snapshot.worldLandmarks[24];
  const leftKnee = snapshot.worldLandmarks[25];
  const rightKnee = snapshot.worldLandmarks[26];
  const leftAnkle = snapshot.worldLandmarks[27];
  const rightAnkle = snapshot.worldLandmarks[28];
  if (!leftHip || !rightHip || !leftKnee || !rightKnee || !leftAnkle || !rightAnkle) return undefined;
  if (landmarkConfidence(leftHip, rightHip) < KNEE_CONFIDENCE_MIN) return undefined;
  if (landmarkConfidence(leftKnee, rightKnee) < KNEE_CONFIDENCE_MIN) return undefined;
  if (landmarkConfidence(leftAnkle, rightAnkle) < KNEE_CONFIDENCE_MIN) return undefined;
  const straight = (hip: Point3, knee: Point3, ankle: Point3) => {
    const thigh = subtract(hip, knee);
    const shin = subtract(knee, ankle);
    return Math.hypot(thigh.x, thigh.y, thigh.z) >= MIN_LEG_SPAN
      && Math.hypot(shin.x, shin.y, shin.z) >= MIN_LEG_SPAN
      && dot(normalize(thigh)!, normalize(shin)!) >= STRAIGHT_LEG_DOT;
  };
  // Checked per leg: one bent knee could hide inside the averaged midpoints.
  if (!straight(leftHip, leftKnee, leftAnkle) || !straight(rightHip, rightKnee, rightAnkle)) return undefined;
  return normalize(subtract(midpoint(leftHip, rightHip), midpoint(leftKnee, rightKnee)));
}

/**
 * Lateral trunk lean, positive toward the player's right, measured against `up` — the fixed
 * standing vertical captured at calibration — not the camera's horizontal plane or a per-frame
 * body direction, so camera tilt, habitual posture and whole-body leans all read correctly.
 * The shoulder axis is projected onto the plane perpendicular to `up` so that rolling it
 * together with the torso does not cancel the lean.
 */
export function torsoLeanRad(snapshot: PoseSnapshot, up: Point3): number | undefined {
  const leftShoulder = snapshot.worldLandmarks[11];
  const rightShoulder = snapshot.worldLandmarks[12];
  const leftHip = snapshot.worldLandmarks[23];
  const rightHip = snapshot.worldLandmarks[24];
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return undefined;
  const upDirection = normalize(up);
  if (!upDirection) return undefined;
  const across = subtract(rightShoulder, leftShoulder);
  const acrossUp = dot(across, upDirection);
  const side = normalize({
    x: across.x - upDirection.x * acrossUp,
    y: across.y - upDirection.y * acrossUp,
    z: across.z - upDirection.z * acrossUp,
  });
  if (!side) return undefined;

  const torso = subtract(midpoint(leftShoulder, rightShoulder), midpoint(leftHip, rightHip));
  return Math.atan2(dot(torso, side), dot(torso, upDirection));
}
