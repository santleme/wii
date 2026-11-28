import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { disposeObjectTree } from '../core/GameLoop';

/** 0 = full quality; higher tiers are cheaper to render. */
export type QualityTier = 0 | 1 | 2;

/** Environment texture plus cleanup for resources owned outside the scene object tree. */
export interface BoxingRingEnvironment {
  readonly texture: THREE.Texture;
  dispose(): void;
}

export interface BoxingRingOptions {
  /** Test seam for headless environments; production uses a PMREM RoomEnvironment. */
  createEnvironment?: (renderer: THREE.WebGLRenderer) => BoxingRingEnvironment;
}

export interface BoxingRing {
  setQuality(tier: QualityTier): void;
  dispose(): void;
}

const CANVAS_Y = 1.05;
const CORNER = 3.22;
const ROPE_SPAN = 6.18;
const RED = 0xf04d45;
const WHITE = 0xf7f5f0;
const WII_BLUE = 0x00b4e5;
const ROPE_BLUE = 0x2477d2;
const NAVY = 0x173250;
const NAVY_MID = 0x214565;
const NAVY_DARK = 0x102439;
const CANVAS = 0xbfe7f2;
const STEEL = 0xc9d4dc;
const LENS = 0xffe6a3;

const CROWD_ROWS = 5;
const CROWD_SEATS = 18;
const CROWD_SIDES = 4;
const CROWD_COLUMNS: Record<QualityTier, number> = { 0: 18, 1: 12, 2: 6 };
const SHADOW_MAP_SIZE: Record<QualityTier, number> = { 0: 1024, 1: 512, 2: 512 };
/** A stride coprime with 18 spreads every quality prefix across the whole stand. */
const SEAT_ORDER = Array.from({ length: CROWD_SEATS }, (_, index) => (index * 7) % CROWD_SEATS);

const LIGHT_SOURCE_Y = 5.76;
const LIGHT_FIXTURES = [
  { name: 'boxing-key-light-a', x: 3.45, z: -3.45, color: 0xfff1d0, intensity: 34 },
  { name: 'boxing-key-light-b', x: -3.45, z: 3.45, color: 0xfff1d0, intensity: 30 },
  { name: 'boxing-fill-light-a', x: -3.45, z: -3.45, color: 0xd8edff, intensity: 20 },
  { name: 'boxing-fill-light-b', x: 3.45, z: 3.45, color: 0xd8edff, intensity: 20 },
] as const;

/** Bakes a color into the vertices, so differently colored parts can share one draw call. Consumes `source`. */
function paint(source: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();
  const { r, g, b } = new THREE.Color(color);
  const colors = new Float32Array(geometry.attributes.position!.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([r, g, b], i);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Merges and frees the parts. They must agree on attributes and on being indexed or not. */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('Geometrias incompatíveis no ringue de boxe');
  return merged;
}

function roundedBox(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
  color: THREE.ColorRepresentation,
  radius = 0.08,
): THREE.BufferGeometry {
  return paint(new RoundedBoxGeometry(width, height, depth, 2, radius).translate(x, y, z), color);
}

function ringParts(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [
    roundedBox(7.8, 0.82, 7.8, 0, 0.41, 0, NAVY_DARK, 0.16),
    roundedBox(7.25, 0.14, 7.25, 0, 0.89, 0, WII_BLUE, 0.07),
    roundedBox(6.62, 0.12, 6.62, 0, 0.99, 0, CANVAS, 0.06),
  ];

  for (let side = 0; side < 4; side += 1) {
    const stripe = new RoundedBoxGeometry(5.8, 0.16, 0.08, 2, 0.03)
      .translate(0, 0.62, 3.93)
      .rotateY((side * Math.PI) / 2);
    parts.push(paint(stripe, side % 2 === 0 ? WII_BLUE : WHITE));
  }

  parts.push(
    paint(new THREE.RingGeometry(0.78, 0.9, 48).rotateX(-Math.PI / 2).translate(0, 1.056, 0), WHITE),
    paint(new THREE.RingGeometry(0.15, 0.23, 32).rotateX(-Math.PI / 2).translate(0, 1.057, 0), WII_BLUE),
  );

  const corners = [
    { x: 1, z: 1, color: RED },
    { x: -1, z: -1, color: ROPE_BLUE },
    { x: 1, z: -1, color: WHITE },
    { x: -1, z: 1, color: WHITE },
  ];
  for (const corner of corners) {
    parts.push(
      paint(
        new THREE.CapsuleGeometry(0.16, 1.58, 4, 12).translate(corner.x * CORNER, CANVAS_Y + 0.95, corner.z * CORNER),
        corner.color,
      ),
    );
    const pad = new RoundedBoxGeometry(0.48, 1.02, 0.16, 2, 0.06);
    pad.rotateY(Math.atan2(corner.x, corner.z));
    pad.translate(corner.x * 3.04, CANVAS_Y + 0.9, corner.z * 3.04);
    parts.push(paint(pad, corner.color));
  }

  const ropes = [
    { y: 2.36, color: RED },
    { y: 1.98, color: WHITE },
    { y: 1.6, color: ROPE_BLUE },
  ];
  for (const rope of ropes) {
    for (const sign of [-1, 1]) {
      parts.push(
        paint(
          new THREE.CylinderGeometry(0.045, 0.045, ROPE_SPAN, 10, 6)
            .rotateZ(Math.PI / 2)
            .translate(0, rope.y, sign * 3.18),
          rope.color,
        ),
        paint(
          new THREE.CylinderGeometry(0.045, 0.045, ROPE_SPAN, 10, 6)
            .rotateX(Math.PI / 2)
            .translate(sign * 3.18, rope.y, 0),
          rope.color,
        ),
      );
    }
  }
  return parts;
}

function standParts(): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  for (let side = 0; side < 4; side += 1) {
    const angle = (side * Math.PI) / 2;
    for (let row = 0; row < CROWD_ROWS; row += 1) {
      const width = 14 + row * 1.1;
      const height = 0.42;
      const distance = 7.15 + row * 1.12;
      const step = new RoundedBoxGeometry(width, height, 1.16, 2, 0.08)
        .translate(0, row * height + height / 2, distance)
        .rotateY(angle);
      parts.push(paint(step, row % 2 === 0 ? NAVY : NAVY_MID));
    }

    const rail = new THREE.CylinderGeometry(0.055, 0.055, 14.8, 8)
      .rotateZ(Math.PI / 2)
      .translate(0, 0.92, 6.48)
      .rotateY(angle);
    parts.push(paint(rail, WII_BLUE));
    for (const x of [-6.8, 0, 6.8]) {
      const support = new THREE.CylinderGeometry(0.045, 0.045, 0.9, 8).translate(x, 0.45, 6.48).rotateY(angle);
      parts.push(paint(support, STEEL));
    }
  }
  return parts;
}

interface RigParts {
  structure: THREE.BufferGeometry[];
  lenses: THREE.BufferGeometry[];
  beams: THREE.BufferGeometry[];
}

function negativeYRotation(from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  const direction = to.clone().sub(from).normalize();
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), direction);
}

function lightRigParts(): RigParts {
  const structure: THREE.BufferGeometry[] = [];
  const lenses: THREE.BufferGeometry[] = [];
  const beams: THREE.BufferGeometry[] = [];
  const target = new THREE.Vector3(0, CANVAS_Y, 0);
  const trussY = 6.16;
  const trussHalf = 4.25;

  for (const sign of [-1, 1]) {
    structure.push(
      paint(
        new THREE.CylinderGeometry(0.09, 0.09, trussHalf * 2, 10)
          .rotateZ(Math.PI / 2)
          .translate(0, trussY, sign * trussHalf),
        STEEL,
      ),
      paint(
        new THREE.CylinderGeometry(0.09, 0.09, trussHalf * 2, 10)
          .rotateX(Math.PI / 2)
          .translate(sign * trussHalf, trussY, 0),
        STEEL,
      ),
    );
  }

  for (const fixture of LIGHT_FIXTURES) {
    const position = new THREE.Vector3(fixture.x, LIGHT_SOURCE_Y, fixture.z);
    const rotation = negativeYRotation(position, target);
    const direction = target.clone().sub(position).normalize();

    structure.push(
      paint(new THREE.CylinderGeometry(0.045, 0.045, 0.44, 8).translate(fixture.x, 5.97, fixture.z), STEEL),
    );
    const body = new THREE.CylinderGeometry(0.2, 0.34, 0.55, 16);
    body.applyQuaternion(rotation);
    body.translate(position.x, position.y, position.z);
    structure.push(paint(body, NAVY_DARK));

    const lensPosition = position.clone().addScaledVector(direction, 0.31);
    const lens = new THREE.CylinderGeometry(0.27, 0.27, 0.045, 16);
    lens.applyQuaternion(rotation);
    lens.translate(lensPosition.x, lensPosition.y, lensPosition.z);
    lenses.push(lens);

    const beamLength = position.distanceTo(target) * 1.02;
    const beamCenter = position.clone().addScaledVector(direction, beamLength / 2);
    const beam = new THREE.CylinderGeometry(0.18, 1.55, beamLength, 18, 1, true);
    beam.applyQuaternion(rotation);
    beam.translate(beamCenter.x, beamCenter.y, beamCenter.z);
    beams.push(beam);
  }
  return { structure, lenses, beams };
}

function crowdCountFor(tier: QualityTier): number {
  return CROWD_ROWS * CROWD_SIDES * CROWD_COLUMNS[tier];
}

function createCrowd(): THREE.InstancedMesh {
  const person = merge([
    new THREE.CapsuleGeometry(0.22, 0.42, 3, 7).translate(0, 0.43, 0),
    new THREE.SphereGeometry(0.18, 7, 5).translate(0, 0.88, 0),
  ]);
  const capacity = CROWD_ROWS * CROWD_SEATS * CROWD_SIDES;
  const mesh = new THREE.InstancedMesh(
    person,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0 }),
    capacity,
  );
  mesh.name = 'boxing-crowd';
  mesh.frustumCulled = false;

  const item = new THREE.Object3D();
  const color = new THREE.Color();
  const shirts = [0xe8604c, 0x00b4e5, 0xffc93c, 0x4fbf58, 0xa078d8, 0xff8a2a, 0xffffff];
  let index = 0;
  for (let orderIndex = 0; orderIndex < CROWD_SEATS; orderIndex += 1) {
    const seat = SEAT_ORDER[orderIndex]!;
    for (let side = 0; side < CROWD_SIDES; side += 1) {
      const angle = (side * Math.PI) / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let row = 0; row < CROWD_ROWS; row += 1) {
        const lateral = (seat - (CROWD_SEATS - 1) / 2) * 0.78 + Math.sin(index * 1.91) * 0.08;
        const distance = 7.15 + row * 1.12 + Math.cos(index * 2.17) * 0.07;
        const x = lateral * cos + distance * sin;
        const z = -lateral * sin + distance * cos;
        item.position.set(x, (row + 1) * 0.42, z);
        item.rotation.y = angle + Math.PI + Math.sin(index * 3.1) * 0.12;
        item.scale.setScalar(0.94 + 0.08 * (0.5 + 0.5 * Math.sin(index * 7.3)));
        item.updateMatrix();
        mesh.setMatrixAt(index, item.matrix);
        mesh.setColorAt(index, color.setHex(shirts[(index * 5 + row * 2 + side) % shirts.length]!));
        index += 1;
      }
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function createSpotlights(target: THREE.Object3D): THREE.SpotLight[] {
  return LIGHT_FIXTURES.map((fixture) => {
    const light = new THREE.SpotLight(fixture.color, fixture.intensity, 18, 0.52, 0.55, 1.4);
    light.name = fixture.name;
    const source = new THREE.Vector3(fixture.x, LIGHT_SOURCE_Y, fixture.z);
    const direction = target.position.clone().sub(source).normalize();
    light.position.copy(source).addScaledVector(direction, 0.31);
    light.target = target;
    light.castShadow = false;
    light.shadow.mapSize.set(SHADOW_MAP_SIZE[0], SHADOW_MAP_SIZE[0]);
    light.shadow.bias = -0.00015;
    light.shadow.normalBias = 0.025;
    light.shadow.camera.near = 2;
    light.shadow.camera.far = 14;
    light.shadow.camera.updateProjectionMatrix();
    return light;
  });
}

function createRoomEnvironment(renderer: THREE.WebGLRenderer): BoxingRingEnvironment {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  try {
    const target = pmrem.fromScene(room, 0.04);
    return { texture: target.texture, dispose: () => target.dispose() };
  } finally {
    room.dispose();
    pmrem.dispose();
  }
}

function releaseShadowMap(light: THREE.SpotLight): void {
  if (light.shadow.map || light.shadow.mapPass) light.shadow.dispose();
  light.shadow.map = null;
  light.shadow.mapPass = null;
}

/**
 * Builds the procedural boxing arena. The returned object owns everything it adds to `scene`;
 * renderer/scene state changed here is restored by `dispose()`.
 */
export function buildBoxingRing(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  options: BoxingRingOptions = {},
): BoxingRing {
  const environment = (options.createEnvironment ?? createRoomEnvironment)(renderer);

  const previousEnvironment = scene.environment;
  const previousEnvironmentIntensity = scene.environmentIntensity;
  const previousFog = scene.fog;
  const previousToneMapping = renderer.toneMapping;
  const previousShadowEnabled = renderer.shadowMap.enabled;
  const previousShadowType = renderer.shadowMap.type;

  scene.environment = environment.texture;
  scene.environmentIntensity = 0.45;
  scene.fog = new THREE.Fog(0x07111f, 24, 58);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.enabled = true;

  const root = new THREE.Group();
  root.name = 'boxing-ring-root';

  const rig = lightRigParts();
  const architecture = new THREE.Mesh(
    merge([...ringParts(), ...standParts(), ...rig.structure]),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.02 }),
  );
  architecture.name = 'boxing-ring-architecture';
  architecture.castShadow = true;
  architecture.receiveShadow = true;

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(23, 72).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x142334, roughness: 0.92, metalness: 0 }),
  );
  floor.name = 'boxing-arena-floor';
  floor.position.y = -0.02;
  floor.receiveShadow = true;

  const lensMaterial = new THREE.MeshStandardMaterial({
    color: LENS,
    emissive: 0xffc766,
    emissiveIntensity: 1.35,
    roughness: 0.35,
    metalness: 0,
  });
  const lenses = new THREE.Mesh(merge(rig.lenses), lensMaterial);
  lenses.name = 'boxing-light-lenses';

  const beamMaterial = new THREE.MeshBasicMaterial({
    color: 0x9fdcff,
    transparent: true,
    opacity: 0.025,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const beams = new THREE.Mesh(merge(rig.beams), beamMaterial);
  beams.name = 'boxing-light-beams';
  beams.renderOrder = 1;

  const crowd = createCrowd();
  const target = new THREE.Object3D();
  target.name = 'boxing-spot-target';
  target.position.set(0, CANVAS_Y, 0);
  const spotlights = createSpotlights(target);
  const hemisphere = new THREE.HemisphereLight(0xdff3ff, 0x172334, 0.75);
  hemisphere.name = 'boxing-hemisphere-light';

  root.add(floor, architecture, lenses, beams, crowd, target, hemisphere, ...spotlights);
  scene.add(root);

  const keyLights = [spotlights[0]!, spotlights[1]!];
  let disposed = false;

  function applyQuality(tier: QualityTier): void {
    if (disposed) return;
    crowd.count = crowdCountFor(tier);
    renderer.shadowMap.enabled = tier !== 2;
    beams.visible = tier !== 2;
    beamMaterial.opacity = tier === 0 ? 0.025 : 0.018;
    lensMaterial.emissiveIntensity = tier === 2 ? 0.7 : 1.35;

    for (const [index, light] of keyLights.entries()) {
      const enabled = tier === 0 || (tier === 1 && index === 0);
      light.castShadow = enabled;
      if (enabled) {
        const size = SHADOW_MAP_SIZE[tier];
        if (light.shadow.mapSize.x !== size) {
          releaseShadowMap(light);
          light.shadow.mapSize.set(size, size);
        }
        light.shadow.needsUpdate = true;
      } else {
        releaseShadowMap(light);
      }
    }
  }

  applyQuality(0);

  return {
    setQuality: applyQuality,
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(root);
      disposeObjectTree(root);
      for (const light of spotlights) light.dispose();
      hemisphere.dispose();

      scene.environment = previousEnvironment;
      scene.environmentIntensity = previousEnvironmentIntensity;
      scene.fog = previousFog;
      renderer.toneMapping = previousToneMapping;
      renderer.shadowMap.enabled = previousShadowEnabled;
      renderer.shadowMap.type = previousShadowType;
      environment.dispose();
    },
  };
}
