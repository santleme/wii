import type { Point3, RotationalFlickSample } from '@wii/spatial-core';
import { syntheticHand } from './syntheticHand';

const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;

function rotateZ(point: Point3, angleRad: number): Point3 {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
    z: point.z,
  };
}

function rotateX(point: Point3, angleRad: number): Point3 {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: point.x,
    y: point.y * cos - point.z * sin,
    z: point.y * sin + point.z * cos,
  };
}

function rotateY(point: Point3, angleRad: number): Point3 {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: point.x * cos + point.z * sin,
    y: point.y,
    z: -point.x * sin + point.z * cos,
  };
}

export interface RotationalTilt {
  xDeg?: number;
  yDeg?: number;
}

/** Open/fist interpolation gives a deterministic shell shape; rotation is applied in world x/y. */
export function rotationalWorldLandmarks(
  angleDeg: number,
  curl = 0.65,
  mirrorX = false,
  tilt: RotationalTilt = {},
): Point3[] {
  const open = syntheticHand().worldLandmarks;
  const fist = syntheticHand({ pose: 'fist' }).worldLandmarks;
  const angleRad = (angleDeg * Math.PI) / 180;
  const tiltXRad = ((tilt.xDeg ?? 0) * Math.PI) / 180;
  const tiltYRad = ((tilt.yDeg ?? 0) * Math.PI) / 180;
  return open.map((openPoint, index) => {
    const fistPoint = fist[index]!;
    const point = {
      x: lerp(openPoint.x, fistPoint.x, curl),
      y: lerp(openPoint.y, fistPoint.y, curl),
      z: lerp(openPoint.z, fistPoint.z, curl),
    };
    if (mirrorX) point.x = -point.x;
    return rotateY(rotateX(rotateZ(point, angleRad), tiltXRad), tiltYRad);
  });
}

export function rotationalSample(
  timestampMs: number,
  angleDeg: number,
  options: { curl?: number; handedness?: 'left' | 'right'; mirrorX?: boolean; tilt?: RotationalTilt } = {},
): RotationalFlickSample {
  return {
    timestampMs,
    worldLandmarks: rotationalWorldLandmarks(angleDeg, options.curl ?? 0.65, options.mirrorX, options.tilt),
    handedness: options.handedness ?? 'right',
  };
}
