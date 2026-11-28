import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { addRoomEnvironment } from '../core/environment';
import { createSkyDome } from '../core/scenery';
import { merge, paint } from './geometry';
import { LANE_WIDTH, lapLength, R_KERB, R_RUN, STRAIGHT, sampleTrack } from './trackCurve';

const LANES = 8;
/** Track edges as outward offsets from the lane 1 running line. */
const INNER = R_KERB - R_RUN;
const OUTER = INNER + LANES * LANE_WIDTH;
const SUN_OFFSET = new THREE.Vector3(18, 32, 14);

/** Flat strip following the track between two outward offsets; u crosses it, v counts `tile` metres. */
function ribbon(from: number, to: number, inner: number, outer: number, y: number, steps: number, tile = 4) {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const distance = from + ((to - from) * i) / steps;
    // The end of a full lap must not wrap back to the start of the sample.
    const s = sampleTrack(distance, 0);
    for (const [offset, u] of [
      [inner, 0],
      [outer, 1],
    ] as const) {
      positions.push(s.x + s.normalX * offset, y, s.z + s.normalZ * offset);
      uvs.push(u, (distance - from) / tile);
    }
    const a = i * 2;
    if (i < steps) indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function canvasTexture(width: number, height: number, anisotropy: number, draw: (c: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D indisponível');
  draw(context);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/** Rubber surface: 9.76 m across by 4 m along, repeated down the lap. */
function trackTexture(anisotropy: number): THREE.CanvasTexture {
  const texture = canvasTexture(1024, 512, anisotropy, (context) => {
    context.fillStyle = '#C76553';
    context.fillRect(0, 0, 1024, 512);
    // Slightly darker wear down the middle of every lane.
    context.fillStyle = '#00000010';
    for (let lane = 0; lane < LANES; lane += 1) context.fillRect((lane + 0.3) * (1024 / LANES), 0, 51, 512);
    // Two grain sizes give micro-contrast that survives mipmapping.
    for (let i = 0; i < 9000; i += 1) {
      context.fillStyle = ['#ffffff1c', '#00000022', '#7a2f2540', '#f0a08c40'][i % 4]!;
      const size = i % 11 === 0 ? 5 : 2;
      context.fillRect(Math.random() * 1024, Math.random() * 512, size, size);
    }
    for (let lane = 0; lane <= LANES; lane += 1) {
      const width = lane === 0 || lane === LANES ? 11 : 6;
      const x = (lane / LANES) * (1024 - width);
      context.fillStyle = '#7a2f2566';
      context.fillRect(x - 2, 0, width + 4, 512);
      context.fillStyle = '#ffffff';
      context.fillRect(x, 0, width, 512);
    }
  });
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Lane numbers painted just before the finish line, upright for someone running towards it. */
function laneNumbers(anisotropy: number): THREE.Mesh {
  const map = canvasTexture(1024, 192, anisotropy, (context) => {
    context.fillStyle = '#ffffff';
    context.font = 'bold 130px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (let lane = 0; lane < LANES; lane += 1) context.fillText(String(lane + 1), (lane + 0.5) * (1024 / LANES), 100);
  });
  const material = new THREE.MeshStandardMaterial({ map, transparent: true, depthWrite: false, roughness: 0.9 });
  return new THREE.Mesh(ribbon(-2.6, -0.8, INNER, OUTER, 0.014, 1, 1.8), material);
}

const matte = (color: THREE.ColorRepresentation) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });
const vertexMatte = () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });

const WHITE = '#F7F5F0';
const WII_BLUE = '#00B4E5';
/** Distance from the centre line to the first grandstand row. */
const STAND_Z = R_RUN + OUTER + 4;
const TIERS = 4;

/** Grandstand along the +Z straight; the opposite one is the same turned half a circle. */
function grandstand(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (let tier = 0; tier < TIERS; tier += 1) {
    const height = 1.1 * (tier + 1);
    const step = new RoundedBoxGeometry(STRAIGHT, height, 2.1, 2, 0.22);
    parts.push(paint(step.translate(0, height / 2, STAND_Z + tier * 2), WHITE));
  }
  // Canopy: an arched cross-section (x is depth here) extruded along the straight.
  const near = STAND_Z - 2;
  const profile = new THREE.Shape();
  profile.moveTo(near, 9);
  profile.quadraticCurveTo(near + 5.5, 11.8, near + 11, 9.4);
  profile.lineTo(near + 11, 9.05);
  profile.quadraticCurveTo(near + 5.5, 11.2, near, 8.7);
  const length = STRAIGHT + 4;
  const canopy = new THREE.ExtrudeGeometry(profile, {
    depth: length,
    bevelEnabled: true,
    bevelThickness: 0.2,
    bevelSize: 0.12,
    bevelSegments: 2,
    curveSegments: 12,
  });
  parts.push(paint(canopy.rotateY(-Math.PI / 2).translate(length / 2, 0, 0), WHITE));
  const stripe = (radius: number, y: number, z: number) => {
    const rail = new THREE.CapsuleGeometry(radius, length, 3, 10).rotateZ(Math.PI / 2);
    parts.push(paint(rail.translate(0, y, z), WII_BLUE));
  };
  stripe(0.3, 8.85, near);
  stripe(0.14, 0.75, STAND_Z - 1.1);
  for (let x = -STRAIGHT / 2; x <= STRAIGHT / 2; x += STRAIGHT / 6) {
    parts.push(paint(new THREE.CylinderGeometry(0.2, 0.28, 9.6, 10).translate(x, 4.8, STAND_Z + 8), WHITE));
  }
  return parts;
}

/** Both grandstands and the finish arch, merged into a single draw call. */
function architecture(): THREE.Mesh {
  const far = grandstand().map((part) => part.rotateY(Math.PI));
  // Half torus over the finish line, turned to span the track.
  const arch = (radius: number, tube: number, x: number, color: string) =>
    paint(
      new THREE.TorusGeometry(radius, tube, 10, 40, Math.PI)
        .rotateY(Math.PI / 2)
        .translate(x, 0, R_RUN + (INNER + OUTER) / 2),
      color,
    );
  const finishX = STRAIGHT / 2;
  const parts = [...grandstand(), ...far, arch(6, 0.45, finishX, WHITE), arch(6, 0.16, finishX - 0.48, WII_BLUE)];
  const mesh = new THREE.Mesh(merge(parts), vertexMatte());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** One InstancedMesh of rounded spectators filling every row of both stands. */
function crowd(): THREE.InstancedMesh {
  const person = merge([
    new THREE.CapsuleGeometry(0.28, 0.4, 3, 8).translate(0, 0.48, 0),
    new THREE.SphereGeometry(0.22, 8, 6).translate(0, 1.18, 0),
  ]);
  const seats = Math.floor(STRAIGHT / 1.1) - 1;
  const mesh = new THREE.InstancedMesh(person, matte(0xffffff), seats * TIERS * 2);
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  const shirts = [0xe8604c, 0x00b4e5, 0xffc93c, 0x4fbf58, 0xa078d8, 0xff8a2a, 0xffffff];
  let index = 0;
  for (const side of [-1, 1]) {
    for (let tier = 0; tier < TIERS; tier += 1) {
      for (let seat = 0; seat < seats; seat += 1) {
        const x = (seat - (seats - 1) / 2) * 1.1 + Math.sin(index * 12.9) * 0.2;
        matrix.makeTranslation(x, 1.1 * (tier + 1), side * (STAND_Z + tier * 2));
        mesh.setMatrixAt(index, matrix);
        mesh.setColorAt(index, color.setHex(shirts[(index * 5 + tier) % shirts.length]!));
        index += 1;
      }
    }
  }
  mesh.frustumCulled = false;
  return mesh;
}

/** Trunk and three off-centre blobs of foliage, standing on y = 0. */
function treeGeometry(): THREE.BufferGeometry {
  const blob = (radius: number, x: number, y: number, z: number, color: number) =>
    paint(new THREE.SphereGeometry(radius, 10, 8).translate(x, y, z), color);
  return merge([
    paint(new THREE.CylinderGeometry(0.3, 0.48, 3, 8).translate(0, 1.5, 0), 0x9a6a43),
    blob(2.1, 0, 4.2, 0, 0x4fa85a),
    blob(1.5, 1.4, 3.6, 0.5, 0x65bd63),
    blob(1.3, -0.9, 5.3, -0.4, 0x7acb6c),
  ]);
}

/** Tapered mast with an arm curving over towards -Z and a rounded lamp. */
function lampGeometry(): THREE.BufferGeometry {
  const arm = new THREE.TorusGeometry(0.9, 0.08, 6, 12, Math.PI / 2).rotateY(-Math.PI / 2);
  return merge([
    paint(new THREE.CylinderGeometry(0.09, 0.16, 6.5, 8).translate(0, 3.25, 0), 0xdfe3e6),
    paint(arm.translate(0, 6.5, -0.9), 0xdfe3e6),
    paint(new THREE.SphereGeometry(0.34, 10, 8).scale(1, 0.7, 1.3).translate(0, 7.35, -1), 0xfff3c4),
  ]);
}

/**
 * `count` copies spread around the oval, `laneOffset` lanes out from lane 1, each turned so local
 * -Z faces the infield. `variation` adds per-instance scale and a random-looking spin.
 */
function ring(geometry: THREE.BufferGeometry, count: number, laneOffset: number, variation = 0) {
  const mesh = new THREE.InstancedMesh(geometry, vertexMatte(), count);
  const item = new THREE.Object3D();
  for (let i = 0; i < count; i += 1) {
    const s = sampleTrack((lapLength(laneOffset) * (i + 0.5)) / count, laneOffset);
    item.position.set(s.x, 0, s.z);
    item.rotation.y = Math.atan2(s.normalX, s.normalZ) + (variation ? i * 2.4 : 0);
    item.scale.setScalar(1 + Math.sin(i * 7.3) * variation);
    item.updateMatrix();
    mesh.setMatrixAt(i, item.matrix);
  }
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  return mesh;
}

export interface Stadium {
  /** Moves the shadow frustum with the runner and keeps the sky centred on the camera. */
  follow(runner: THREE.Vector3, camera: THREE.Vector3): void;
  setShadows(enabled: boolean): void;
  dispose(): void;
}

export function buildStadium(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Stadium {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;

  const removeEnvironment = addRoomEnvironment(scene, renderer);

  const sky = createSkyDome();
  scene.fog = new THREE.Fog(sky.bottomColor, 80, 220);

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.normalBias = 0.03;
  Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, near: 1, far: 100 });
  sun.shadow.camera.updateProjectionMatrix();

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), matte('#82B66B'));
  ground.position.y = -0.03;
  ground.receiveShadow = true;

  const lap = lapLength(0);
  const surface = new THREE.MeshStandardMaterial({
    map: trackTexture(renderer.capabilities.getMaxAnisotropy()),
    roughness: 0.9,
    metalness: 0,
  });
  const track = new THREE.Mesh(ribbon(0, lap - 1e-6, INNER, OUTER, 0, 400), surface);
  const kerb = new THREE.Mesh(ribbon(0, lap - 1e-6, INNER - 0.12, INNER, 0.03, 400), matte('#F7F5F0'));
  const finish = new THREE.Mesh(ribbon(-0.25, 0.25, INNER, OUTER, 0.012, 1), matte(0xffffff));
  for (const mesh of [track, kerb, finish]) mesh.receiveShadow = true;

  // Soft far ring that the fog fades into the sky.
  const hill = new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(24, 11, 24);
  const hills = ring(paint(hill, 0x74a96a), 30, 82, 0.35);
  hills.castShadow = false;

  scene.add(
    sky.mesh,
    new THREE.HemisphereLight(0xdff3ff, 0x6f9460, 1.1),
    sun,
    sun.target,
    ground,
    track,
    kerb,
    finish,
    architecture(),
    laneNumbers(renderer.capabilities.getMaxAnisotropy()),
    crowd(),
    ring(treeGeometry(), 56, 24, 0.28),
    ring(lampGeometry(), 24, 9),
    hills,
  );

  return {
    follow(runner, camera) {
      sun.target.position.copy(runner);
      sun.position.copy(runner).add(SUN_OFFSET);
      sky.mesh.position.copy(camera);
    },
    setShadows(enabled) {
      sun.castShadow = enabled;
    },
    // Meshes are freed by the loop's disposeObjectTree; these live outside what it walks.
    dispose() {
      removeEnvironment();
      sun.dispose();
    },
  };
}
