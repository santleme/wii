import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createSkyDome } from '../core/scenery';
import { BASELINE_Z, COURT_HALF_WIDTH, LINE_WIDTH, NET_HALF_WIDTH, NET_HEIGHT, SERVICE_LINE_Z } from './court';

/** Everything here is static scenery; the game's disposeObjectTree frees it with the scene. */

const WALL_GREEN = 0x1f6b45;
const WALL_DARK = 0x14492f;
const SKIN = [0xf2c29a, 0xd99f73, 0x9c6a45, 0xf7d5b5];
const SHIRTS = [0xe8483f, 0x2f9be8, 0xffd23f, 0x7ac74f, 0xf79432, 0xb96ad9, 0xffffff];

/** A texture drawn on a 2D canvas; undefined where there is no canvas (tests). */
function drawn(width: number, height: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  draw(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Mown grass: light and dark bands across the court, with grain. */
function grass(width: number, depth: number, y: number, light: string, dark: string): THREE.Mesh {
  const map = drawn(512, 512, (context) => {
    for (let band = 0; band < 8; band += 1) {
      context.fillStyle = band % 2 ? dark : light;
      context.fillRect(0, band * 64, 512, 64);
    }
    for (let i = 0; i < 7000; i += 1) {
      context.fillStyle = i % 2 ? '#ffffff14' : '#00000018';
      context.fillRect(Math.random() * 512, Math.random() * 512, 2, 4);
    }
  });
  const material = new THREE.MeshStandardMaterial(map ? { map, roughness: 1 } : { color: light, roughness: 1 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

function box(scene: THREE.Scene, material: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  scene.add(mesh);
  return mesh;
}

function addCourt(scene: THREE.Scene): void {
  scene.add(grass(40, 60, -0.02, '#4f8f35', '#478230'));
  scene.add(grass(9.4, 22, 0, '#79b84a', '#67a63d'));
  const white = new THREE.MeshBasicMaterial({ color: 0xf6f7ea });
  const line = (w: number, d: number, x: number, z: number) => box(scene, white, w, 0.02, d, x, 0.015, z);
  const singles = 2 * COURT_HALF_WIDTH + LINE_WIDTH;
  for (const z of [-BASELINE_Z, BASELINE_Z]) line(9.2, LINE_WIDTH, 0, z);
  for (const z of [-SERVICE_LINE_Z, SERVICE_LINE_Z]) line(singles, LINE_WIDTH, 0, z);
  for (const x of [-4.55, 4.55, -COURT_HALF_WIDTH, COURT_HALF_WIDTH]) line(LINE_WIDTH, 2 * BASELINE_Z, x, 0);
  line(LINE_WIDTH, 2 * SERVICE_LINE_Z, 0, 0);
  for (const z of [-BASELINE_Z + 0.12, BASELINE_Z - 0.12]) line(LINE_WIDTH, 0.24, 0, z);

  const strands: number[] = [];
  for (let x = -NET_HALF_WIDTH; x <= NET_HALF_WIDTH; x += 0.13) strands.push(x, 0.04, 0, x, NET_HEIGHT, 0);
  for (let y = 0.04; y <= NET_HEIGHT; y += 0.1) strands.push(-NET_HALF_WIDTH, y, 0, NET_HALF_WIDTH, y, 0);
  const net = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(strands, 3));
  scene.add(new THREE.LineSegments(net, new THREE.LineBasicMaterial({ color: 0xdfe8e2, transparent: true, opacity: 0.55 })));
  box(scene, white, NET_HALF_WIDTH * 2, 0.07, 0.06, 0, NET_HEIGHT, 0);
  const post = new THREE.MeshStandardMaterial({ color: WALL_DARK });
  for (const x of [-NET_HALF_WIDTH, NET_HALF_WIDTH]) box(scene, post, 0.16, 1.05, 0.16, x, 0.52, 0);
}

function addWalls(scene: THREE.Scene): void {
  const wall = new THREE.MeshStandardMaterial({ color: WALL_GREEN, roughness: 0.9 });
  const trim = new THREE.MeshStandardMaterial({ color: WALL_DARK });
  box(scene, wall, 22, 1.8, 0.2, 0, 0.9, -13.5);
  box(scene, trim, 22, 0.16, 0.3, 0, 1.86, -13.5);
  for (const x of [-9, 9]) {
    box(scene, wall, 0.2, 1.4, 32, x, 0.7, 2);
    box(scene, trim, 0.3, 0.14, 32, x, 1.45, 2);
  }
  const sign = drawn(512, 128, (context) => {
    context.font = '800 74px system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#ffffff';
    context.fillText('ARENA OPEN', 256, 66);
  });
  if (sign) {
    // Off to both sides, so neither hides the opponent.
    for (const x of [-5, 5]) {
      const board = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), new THREE.MeshBasicMaterial({ map: sign, transparent: true }));
      board.position.set(x, 0.95, -13.38);
      scene.add(board);
    }
  }
}

/** Raked side stands with a roof and a crowd of Mii heads, one draw call per part. */
function addStands(scene: THREE.Scene): THREE.Object3D[] {
  const concrete = new THREE.MeshStandardMaterial({ color: 0x2c6a4c });
  const roof = new THREE.MeshStandardMaterial({ color: WALL_DARK });
  const seats: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    for (let row = 0; row < 3; row += 1) {
      const x = side * (9.8 + row * 1.1);
      const top = 1.3 + row * 0.75;
      box(scene, concrete, 1.1, top, 24, x, top / 2, -2);
      for (let z = -13; z <= 9; z += 0.85) {
        if ((Math.round(z * 3) + row * 5) % 7 !== 0) seats.push(new THREE.Vector3(x, top, z + (row % 2) * 0.4));
      }
    }
    box(scene, roof, 4.2, 0.22, 25, side * 11.2, 5.9, -2);
    for (let z = -13; z <= 9; z += 5.5) box(scene, roof, 0.14, 3.2, 0.14, side * 12.8, 4.3, z);
  }
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.27, 10, 8), new THREE.MeshStandardMaterial(), seats.length);
  const bodies = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.26, 0.45, 8), new THREE.MeshStandardMaterial(), seats.length);
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  seats.forEach((seat, i) => {
    bodies.setMatrixAt(i, matrix.makeTranslation(seat.x, seat.y + 0.22, seat.z));
    bodies.setColorAt(i, color.setHex(SHIRTS[(i * 3) % SHIRTS.length]!));
    heads.setMatrixAt(i, matrix.makeTranslation(seat.x, seat.y + 0.66, seat.z));
    heads.setColorAt(i, color.setHex(SKIN[(i * 7) % SKIN.length]!));
  });
  scene.add(heads, bodies);
  return [heads, bodies];
}

/** A dense row of round, two-tone trees behind the back wall. */
function addTrees(scene: THREE.Scene): void {
  const greens = [0x3f7f35, 0x569a3e, 0x6fb24a].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true }));
  const crown = new THREE.IcosahedronGeometry(1, 1);
  for (let i = 0; i < 54; i += 1) {
    const clump = new THREE.Mesh(crown, greens[i % 3]!);
    const column = i % 18;
    const layer = Math.floor(i / 18);
    clump.position.set(-18 + column * 2.1 + layer * 0.7, 2.2 + layer * 1.25 + (column % 4) * 0.35, -16.5 - layer * 1.2);
    clump.scale.setScalar(1.5 + ((column + layer) % 3) * 0.28);
    scene.add(clump);
  }
}

/** The scenery never moves: one mesh per material keeps draw calls from competing with the camera. */
function mergeStatic(scene: THREE.Scene): void {
  const byMaterial = new Map<THREE.Material, THREE.Mesh[]>();
  for (const child of scene.children) {
    if (!(child instanceof THREE.Mesh) || child instanceof THREE.InstancedMesh || Array.isArray(child.material)) continue;
    byMaterial.set(child.material, [...(byMaterial.get(child.material) ?? []), child]);
  }
  for (const [material, meshes] of byMaterial) {
    if (meshes.length < 2) continue;
    const parts = meshes.map((mesh) => {
      mesh.updateMatrix();
      return mesh.geometry.clone().applyMatrix4(mesh.matrix);
    });
    const merged = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    if (!merged) continue;
    for (const mesh of meshes) {
      scene.remove(mesh);
      mesh.geometry.dispose();
    }
    scene.add(new THREE.Mesh(merged, material));
  }
}

export function buildTennisStadium(scene: THREE.Scene): { crowd: THREE.Object3D[] } {
  const sky = createSkyDome();
  scene.add(sky.mesh);
  scene.fog = new THREE.Fog(sky.bottomColor, 34, 85);
  scene.add(new THREE.HemisphereLight(0xfffaf0, 0x4d7a3a, 2.1));
  const sun = new THREE.DirectionalLight(0xfff1cf, 2.4);
  sun.position.set(-6, 11, 7);
  scene.add(sun);
  addCourt(scene);
  addWalls(scene);
  const crowd = addStands(scene);
  addTrees(scene);
  mergeStatic(scene);
  return { crowd };
}
