import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { cameraDistance, HAND_FOV, STAGE_VIEW, screenToPlane, stageProjection } from '../src/lib/handPlacement';

/** Viewport pixels where a Three.js camera actually draws a world point. */
function project(point: THREE.Vector3, width: number, height: number, position: [number, number, number]) {
  const view = new THREE.PerspectiveCamera(HAND_FOV, width / height, 0.1, 100);
  view.position.set(...position);
  view.updateMatrixWorld();
  const ndc = point.clone().project(view);
  return { x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height };
}

describe('hand placement', () => {
  it('draws a point placed from screen pixels on those same pixels', () => {
    for (const [width, height] of [
      [1100, 900],
      [390, 844],
    ] as const) {
      const camZ = cameraDistance(height, 70);
      for (const pointer of [
        { x: 0, y: 0 },
        { x: 84, y: 33 },
        { x: width - 5, y: height - 5 },
      ]) {
        const world = screenToPlane(pointer, width, height, camZ);
        const drawn = project(new THREE.Vector3(world.x, world.y, 0), width, height, [0, 0, camZ]);
        expect(drawn.x).toBeCloseTo(pointer.x, 4);
        expect(drawn.y).toBeCloseTo(pointer.y, 4);
      }
    }
  });

  it('matches the pixels per unit it was asked for', () => {
    const camZ = cameraDistance(900, 70);
    const a = screenToPlane({ x: 100, y: 100 }, 1100, 900, camZ);
    const b = screenToPlane({ x: 170, y: 100 }, 1100, 900, camZ);
    expect(b.x - a.x).toBeCloseTo(1);
  });

  it('maps stage coordinates to where the stage camera draws them', () => {
    const box = { left: 160, top: 140, width: 780, height: 520 };
    const point = new THREE.Vector3(-2.25, -0.35, 0);
    const drawn = project(point, box.width, box.height, [0, STAGE_VIEW.y, STAGE_VIEW.z]);
    const mapped = stageProjection(box).toScreen(point);
    expect(mapped.x).toBeCloseTo(box.left + drawn.x, 4);
    expect(mapped.y).toBeCloseTo(box.top + drawn.y, 4);
  });
});
