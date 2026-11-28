import type { Point3 } from '@wii/spatial-core';
import { midpoint } from './math';

const EPSILON = 1e-6;

function subtract(a: Point3, b: Point3): Point3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(vector: Point3): Point3 | undefined {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(magnitude) || magnitude < EPSILON) return undefined;
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
 * their cross product. When hips are cropped by a close webcam frame or occluded by arm swing,
 * falls back to the gravity/camera vertical axis ({ x: 0, y: -1, z: 0 }) orthogonalized against
 * the shoulder line so upper-body tracking remains continuous.
 */
export function bodyBasis(
  leftShoulder: Point3,
  rightShoulder: Point3,
  leftHip?: Point3,
  rightHip?: Point3,
): BodyBasis | undefined {
  const side = normalize(subtract(rightShoulder, leftShoulder));
  if (!side) return undefined;

  const shoulders = midpoint(leftShoulder, rightShoulder);
  const hipsVisible = Boolean(
    leftHip
    && rightHip
    && Number.isFinite(leftHip.x) && Number.isFinite(leftHip.y) && Number.isFinite(leftHip.z)
    && Number.isFinite(rightHip.x) && Number.isFinite(rightHip.y) && Number.isFinite(rightHip.z)
    && (leftHip.visibility ?? leftHip.presence ?? 1) >= 0.35
    && (rightHip.visibility ?? rightHip.presence ?? 1) >= 0.35,
  );
  const torso = hipsVisible && leftHip && rightHip
    ? subtract(shoulders, midpoint(leftHip, rightHip))
    : { x: 0, y: -1, z: 0 };
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
  leftHip: Point3 | undefined,
  rightHip: Point3 | undefined,
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
