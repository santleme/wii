import * as THREE from 'three';

const SHAKE_S = 0.18;
const FLASH_S = 0.22;
const TRAIL = 9;

/** What makes a stroke felt and timed: the "hit now" ring, the impact flash, camera shake and ball trail. */
export function createTennisEffects(scene: THREE.Scene) {
  const flat = (color: number, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.64, 36), flat(0xffffff, 0.85));
  ring.rotation.x = -Math.PI / 2;
  const target = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.52, 36), flat(0xfff27a, 0.9));
  target.rotation.x = -Math.PI / 2;
  const flash = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.55, 12), flat(0xfff6b0, 1));
  const trail = Array.from({ length: TRAIL }, (_, i) => {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.17 * (1 - i / (TRAIL + 2)), 8, 6), flat(0xffffff, 0.7 * (1 - i / TRAIL)));
    dot.visible = false;
    scene.add(dot);
    return dot;
  });
  ring.visible = target.visible = flash.visible = false;
  scene.add(ring, target, flash);

  const history: THREE.Vector3[] = [];
  let flashAge = FLASH_S;
  let shake = 0;
  let strength = 0;

  return {
    impact(position: { x: number; y: number; z: number }, power01: number): void {
      flash.position.set(position.x, Math.max(0.3, position.y), position.z);
      flashAge = 0;
      shake = SHAKE_S;
      strength = 0.05 + 0.1 * power01;
    },
    /** `secondsToContact` undefined hides the ring; it closes onto the target as the ball arrives. */
    timing(x: number, z: number, secondsToContact: number | undefined, windowS: number): void {
      const show = secondsToContact !== undefined && secondsToContact < 1.6 && secondsToContact > -windowS;
      ring.visible = target.visible = show;
      if (!show) return;
      ring.position.set(x, 0.04, z);
      target.position.set(x, 0.035, z);
      ring.scale.setScalar(1 + Math.max(0, secondsToContact) * 2.4);
      ring.material.color.setHex(Math.abs(secondsToContact) <= windowS * 0.7 ? 0x5dff6a : 0xffffff);
    },
    /** Call once per rendered frame, after the camera is placed. */
    step(dt: number, ball: THREE.Vector3 | undefined, camera: THREE.Camera): void {
      if (ball) history.unshift(ball.clone());
      else history.length = 0;
      history.length = Math.min(history.length, TRAIL * 2);
      trail.forEach((dot, i) => {
        const point = history[(i + 1) * 2 - 1];
        dot.visible = point !== undefined;
        if (point) dot.position.copy(point);
      });
      flashAge += dt;
      flash.visible = flashAge < FLASH_S;
      flash.scale.setScalar(1 + flashAge * 9);
      flash.material.opacity = Math.max(0, 1 - flashAge / FLASH_S);
      flash.quaternion.copy(camera.quaternion);
      shake = Math.max(0, shake - dt);
      const amount = strength * (shake / SHAKE_S);
      camera.position.x += Math.sin(shake * 190) * amount;
      camera.position.y += Math.cos(shake * 150) * amount * 0.7;
    },
  };
}
