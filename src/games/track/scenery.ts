import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { PropKind } from './biomes';
import { scrollZ } from './scroll';

export const SCENERY_MIN_Z = -66;
export const SCENERY_MAX_Z = 14;

type Shape = 'box' | 'cylinder' | 'cone' | 'roof' | 'ball';
/** Shape, color, size (x, y, z), center (x, y, z). Local +x faces the track; keep it within 1.2. */
type Part = readonly [Shape, number, number, number, number, number, number, number];

const PROPS: Record<PropKind, readonly Part[]> = {
  house: [
    ['box', 0xfff1d6, 2, 1.6, 2.4, 0, 0.8, 0], ['roof', 0xe8604c, 2.4, 1, 2.8, 0, 2.1, 0],
    ['box', 0x8a5a3b, 0.08, 0.9, 0.5, 1.02, 0.45, 0], ['box', 0x7fd0f5, 0.08, 0.45, 0.5, 1.02, 1, 0.75],
    ['box', 0x7fd0f5, 0.08, 0.45, 0.5, 1.02, 1, -0.75],
  ],
  tree: [
    ['cylinder', 0x9a6a43, 0.36, 1.3, 0.36, 0, 0.65, 0], ['ball', 0x4fbf58, 2.1, 1.9, 2.1, 0, 2, 0],
    ['ball', 0x6fd46a, 1.4, 1.3, 1.4, 0.2, 2.9, 0.1],
  ],
  fence: [
    ['box', 0xffffff, 0.1, 0.12, 4, 0, 0.35, 0], ['box', 0xffffff, 0.1, 0.12, 4, 0, 0.7, 0],
    ['box', 0xffffff, 0.16, 0.9, 0.16, 0, 0.45, -1.8], ['box', 0xffffff, 0.16, 0.9, 0.16, 0, 0.45, 0],
    ['box', 0xffffff, 0.16, 0.9, 0.16, 0, 0.45, 1.8],
  ],
  lamp: [
    ['cylinder', 0x52606d, 0.14, 3.2, 0.14, 0, 1.6, 0], ['box', 0x52606d, 0.8, 0.1, 0.1, 0.35, 3.15, 0],
    ['ball', 0xfff3a6, 0.38, 0.32, 0.38, 0.75, 3, 0],
  ],
  bench: [
    ['box', 0xc98a4b, 0.6, 0.12, 1.8, 0, 0.5, 0], ['box', 0xc98a4b, 0.12, 0.55, 1.8, -0.32, 0.82, 0],
    ['box', 0x52606d, 0.5, 0.45, 0.12, 0, 0.22, -0.7], ['box', 0x52606d, 0.5, 0.45, 0.12, 0, 0.22, 0.7],
  ],
  palm: [
    ['cylinder', 0xb98552, 0.32, 3, 0.32, 0, 1.5, 0], ['ball', 0x3fbd63, 2.3, 0.3, 0.6, 0, 3.05, 0],
    ['ball', 0x55cf6c, 0.6, 0.3, 2.3, 0, 3.12, 0], ['ball', 0x8a5a3b, 0.45, 0.4, 0.45, 0.1, 2.85, 0.1],
  ],
  umbrella: [
    ['cylinder', 0xf4f7f2, 0.1, 1.9, 0.1, 0, 0.95, 0], ['cone', 0xff6b5e, 2.2, 0.6, 2.2, 0, 2.05, 0],
    ['ball', 0xffde59, 0.2, 0.2, 0.2, 0, 2.4, 0], ['box', 0x4fc3ff, 0.9, 0.05, 1.6, 0.4, 0.025, 0.6],
  ],
  pillar: [
    ['box', 0xaeb8c2, 1.2, 0.4, 1.2, 0, 0.2, 0], ['box', 0xe8604c, 0.6, 4.6, 0.6, 0, 2.7, 0],
    ['box', 0xf4f7f2, 0.85, 0.3, 0.85, 0, 5.15, 0],
  ],
  building: [
    ['box', 0xc9dcea, 2.2, 4.8, 2.6, 0, 2.4, 0], ['box', 0xf4f7f2, 2.4, 0.25, 2.8, 0, 4.9, 0],
    ['box', 0x5fa8de, 0.08, 0.55, 2, 1.12, 1.2, 0], ['box', 0x5fa8de, 0.08, 0.55, 2, 1.12, 2.4, 0],
    ['box', 0x5fa8de, 0.08, 0.55, 2, 1.12, 3.6, 0],
  ],
};

const SLOT_COUNT = 16;
type Slot = { group: THREE.Group; variants: Record<PropKind, THREE.Group>; shown: THREE.Group };

export class SceneryPool {
  readonly group = new THREE.Group();
  private readonly geometries: Record<Shape, THREE.BufferGeometry> = {
    box: new RoundedBoxGeometry(1, 1, 1, 2, 0.08),
    cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 16),
    cone: new THREE.ConeGeometry(0.5, 1, 16),
    // Four-sided cone turned so its base is a unit square aligned with the walls.
    roof: new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4),
    ball: new THREE.SphereGeometry(0.5, 16, 12),
  };
  private readonly materials = new Map<number, THREE.MeshStandardMaterial>();
  private readonly slots: Slot[] = [];

  constructor(props: readonly PropKind[]) {
    for (let i = 0; i < SLOT_COUNT; i += 1) {
      const side = i % 2 ? 1 : -1;
      const group = new THREE.Group();
      group.position.set(side * (6.3 + (i % 3) * 0.4), 0, SCENERY_MIN_Z + i * ((SCENERY_MAX_Z - SCENERY_MIN_Z) / SLOT_COUNT));
      group.rotation.y = side > 0 ? Math.PI : 0;
      const variants = {} as Record<PropKind, THREE.Group>;
      for (const kind of Object.keys(PROPS) as PropKind[]) {
        variants[kind] = this.build(PROPS[kind]);
        group.add(variants[kind]);
      }
      const shown = variants[pick(props)];
      shown.visible = true;
      this.slots.push({ group, variants, shown });
      this.group.add(group);
    }
  }

  update(advance: number, props: readonly PropKind[]): void {
    if (advance === 0) return;
    for (const slot of this.slots) {
      const { position } = slot.group;
      const z = scrollZ(position.z, advance, SCENERY_MIN_Z, SCENERY_MAX_Z);
      // A wrap jumps back almost the whole span; the margin ignores float noise from tiny advances.
      if (z < position.z - 1) {
        slot.shown.visible = false;
        slot.shown = slot.variants[pick(props)];
        slot.shown.visible = true;
      }
      position.z = z;
    }
  }

  dispose(): void {
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
  }

  private build(parts: readonly Part[]): THREE.Group {
    const variant = new THREE.Group();
    variant.visible = false;
    for (const [shape, color, sx, sy, sz, x, y, z] of parts) {
      let material = this.materials.get(color);
      if (!material) {
        material = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });
        this.materials.set(color, material);
      }
      const mesh = new THREE.Mesh(this.geometries[shape], material);
      mesh.scale.set(sx, sy, sz);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      // Parts never move inside their variant.
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      variant.add(mesh);
    }
    return variant;
  }
}

function pick(props: readonly PropKind[]): PropKind {
  return props[Math.floor(Math.random() * props.length)]!;
}

const DUST_COUNT = 16;
const DUST_LIFE_S = 0.45;
const _dummy = new THREE.Object3D();

export class DustPool {
  readonly mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.14, 0), new THREE.MeshBasicMaterial({ color: 0xf3ead2 }), DUST_COUNT);
  private readonly x = new Float32Array(DUST_COUNT);
  private readonly z = new Float32Array(DUST_COUNT);
  private readonly drift = new Float32Array(DUST_COUNT);
  private readonly life = new Float32Array(DUST_COUNT);
  private cursor = 0;

  constructor() {
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _dummy.position.set(0, 0, 0);
    _dummy.scale.setScalar(0);
    _dummy.updateMatrix();
    for (let i = 0; i < DUST_COUNT; i += 1) this.mesh.setMatrixAt(i, _dummy.matrix);
  }

  emit(x: number, z: number, count: number): void {
    for (let n = 0; n < count; n += 1) {
      const i = this.cursor;
      this.cursor = (i + 1) % DUST_COUNT;
      this.x[i] = x + (Math.random() - 0.5) * 0.6;
      this.z[i] = z + (Math.random() - 0.5) * 0.3;
      this.drift[i] = 1.5 + Math.random() * 2;
      this.life[i] = DUST_LIFE_S;
    }
  }

  /** `advance` is how far the ground moved; puffs trail at part of it so they stay visible. */
  update(dt: number, advance: number): void {
    let changed = false;
    for (let i = 0; i < DUST_COUNT; i += 1) {
      if (this.life[i]! <= 0) continue;
      changed = true;
      this.life[i] = Math.max(0, this.life[i]! - dt);
      const left = this.life[i]! / DUST_LIFE_S;
      this.z[i] = this.z[i]! + this.drift[i]! * dt + advance * 0.4;
      _dummy.position.set(this.x[i]!, 0.08 + (1 - left) * 0.35, this.z[i]!);
      _dummy.scale.setScalar(left);
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(i, _dummy.matrix);
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
