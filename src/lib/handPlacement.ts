// Screen <-> world math that puts the site-wide 3D hand exactly on the pointer. Pure: no DOM, no Three.js.

export const HAND_FOV = 30;
/** The /product stage camera, looking down -z. */
export const STAGE_VIEW = { y: 0.35, z: 8.2 };
const HALF_TAN = Math.tan((HAND_FOV / 2) * (Math.PI / 180));

type Point = { x: number; y: number };
type Box = { left: number; top: number; width: number; height: number };

/** Where the stage canvas at `box` shows its z = 0 plane, in viewport pixels. */
export function stageProjection(box: Box) {
  const pxPerUnit = box.height / (2 * STAGE_VIEW.z * HALF_TAN);
  const toScreen = ({ x, y }: Point): Point => ({
    x: box.left + box.width / 2 + x * pxPerUnit,
    y: box.top + box.height / 2 - (y - STAGE_VIEW.y) * pxPerUnit,
  });
  return { pxPerUnit, toScreen };
}

/** Camera distance at which one world unit on z = 0 covers `pxPerUnit` pixels. */
export function cameraDistance(viewportHeight: number, pxPerUnit: number): number {
  return viewportHeight / (2 * HALF_TAN * pxPerUnit);
}

/** Viewport pixels to the z = 0 plane of a camera on the z axis at `camZ`. */
export function screenToPlane({ x, y }: Point, width: number, height: number, camZ: number): Point {
  const halfH = camZ * HALF_TAN;
  const halfW = halfH * (width / height);
  return { x: ((x / width) * 2 - 1) * halfW, y: (1 - (y / height) * 2) * halfH };
}
