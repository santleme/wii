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

/** Open/fist interpolation gives a deterministic shell shape; rotation is applied in world x/y. */
export function rotationalWorldLandmarks(angleDeg: number, curl = 0.65, mirrorX = false): Point3[] {
  const open = syntheticHand().worldLandmarks;
  const fist = syntheticHand({ pose: 'fist' }).worldLandmarks;
  const angleRad = (angleDeg * Math.PI) / 180;
  return open.map((openPoint, index) => {
    const fistPoint = fist[index]!;
    const point = {
      x: lerp(openPoint.x, fistPoint.x, curl),
      y: lerp(openPoint.y, fistPoint.y, curl),
      z: lerp(openPoint.z, fistPoint.z, curl),
    };
    if (mirrorX) point.x = -point.x;
    return rotateZ(point, angleRad);
  });
}

export function rotationalSample(
  timestampMs: number,
  angleDeg: number,
  options: { curl?: number; handedness?: 'left' | 'right'; mirrorX?: boolean } = {},
): RotationalFlickSample {
  return {
    timestampMs,
    worldLandmarks: rotationalWorldLandmarks(angleDeg, options.curl ?? 0.65, options.mirrorX),
    handedness: options.handedness ?? 'right',
  };
}
