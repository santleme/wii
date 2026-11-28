// The procedural 3D hand and its lighting, shared by the /product stage and the site-wide overlay.
import * as THREE from 'three';
import { cssColor, luminance, parseRgb } from '../lib/ascii';
import { FINGER_CHAINS, type HandRigPose, PALM_BRIDGES } from '../lib/handRig';

const JOINT_RADII = [
  [0.2, 0.17, 0.135, 0.115, 0.095],
  [0.2, 0.14, 0.115, 0.1, 0.085],
  [0.2, 0.145, 0.12, 0.102, 0.087],
  [0.2, 0.138, 0.114, 0.098, 0.083],
  [0.2, 0.122, 0.1, 0.087, 0.075],
];
const UP = new THREE.Vector3(0, 1, 0);

/** Builds the procedural hand once; `update` only moves and orients its parts. */
export function createHand() {
  const skin = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
  const dorsal = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.15 });
  const accent = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.05 });
  const group = new THREE.Group();
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);
    return mesh;
  };

  const radius = new Array<number>(21).fill(0.2);
  FINGER_CHAINS.forEach((chain, finger) => {
    chain.forEach((joint, index) => {
      radius[joint] = JOINT_RADII[finger]![index]!;
    });
  });

  const bones: { from: number; to: number; mesh: THREE.Mesh }[] = [];
  const bone = (from: number, to: number) => {
    const geometry = new THREE.CylinderGeometry(radius[to]! * 0.92, radius[from]! * 0.92, 1, 14, 1, true);
    bones.push({ from, to, mesh: add(geometry, skin) });
  };
  // 5 metacarpals, 15 phalanges and the knuckle bridges.
  for (const chain of FINGER_CHAINS) for (let i = 1; i < chain.length; i += 1) bone(chain[i - 1]!, chain[i]!);
  for (const [from, to] of PALM_BRIDGES) bone(from, to);

  const tips = new Set<number>(FINGER_CHAINS.map((chain) => chain[4]));
  const joints = radius.map((value, index) =>
    add(new THREE.SphereGeometry(value, 18, 14), tips.has(index) ? accent : skin),
  );

  const pad = add(new THREE.SphereGeometry(1, 28, 20), skin);
  const palmPatch = add(new THREE.SphereGeometry(1, 24, 16), accent);
  const backPlate = add(new THREE.SphereGeometry(1, 24, 16), dorsal);
  const cuff = add(new THREE.CylinderGeometry(0.27, 0.31, 0.34, 24), dorsal);

  const points = Array.from({ length: 21 }, () => new THREE.Vector3());
  const xAxis = new THREE.Vector3();
  const yAxis = new THREE.Vector3();
  const zAxis = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const center = new THREE.Vector3();
  const span = new THREE.Vector3();

  const update = (pose: HandRigPose) => {
    pose.joints.forEach((joint, index) => {
      points[index]!.set(joint.x, joint.y, joint.z);
      joints[index]!.position.copy(points[index]!);
    });
    for (const { from, to, mesh } of bones) {
      span.subVectors(points[to]!, points[from]!);
      const length = span.length();
      mesh.position.addVectors(points[from]!, points[to]!).multiplyScalar(0.5);
      mesh.scale.set(1, length, 1);
      mesh.quaternion.setFromUnitVectors(UP, span.normalize());
    }

    xAxis.copy(pose.palmBasis.xAxis);
    yAxis.copy(pose.palmBasis.yAxis);
    zAxis.copy(pose.palmBasis.zAxis);
    basis.makeBasis(xAxis, yAxis, zAxis);
    center.copy(points[0]!).lerp(points[9]!, 0.52);
    const halfWidth = Math.max(0.22, points[5]!.distanceTo(points[17]!) * 0.52);
    for (const [mesh, sx, sy, sz, side] of [
      [pad, halfWidth, 0.56, 0.17, 0],
      [palmPatch, halfWidth * 0.68, 0.38, 0.07, 1],
      [backPlate, halfWidth * 0.74, 0.44, 0.07, -1],
    ] as const) {
      mesh.quaternion.setFromRotationMatrix(basis);
      mesh.scale.set(sx, sy, sz);
      mesh.position.copy(center).addScaledVector(zAxis, side * pose.palmSide * 0.13);
    }
    cuff.quaternion.setFromRotationMatrix(basis);
    cuff.position.copy(points[0]!).addScaledVector(yAxis, -0.16);
    cuff.scale.set(1, 1, 0.7);
    return center;
  };

  return { group, update, skin, dorsal, accent };
}

export type HandMesh = ReturnType<typeof createHand>;

/** Hard key and rim light, little fill: ASCII reads shape from contrast. */
export function addHandLights(scene: THREE.Scene) {
  const ambient = new THREE.HemisphereLight(0xffffff, 0x30343a, 0.9);
  const key = new THREE.DirectionalLight(0xffffff, 2.8);
  key.position.set(2, 3, 4);
  const rim = new THREE.DirectionalLight(0xffffff, 4);
  rim.position.set(-3, 1, -3);
  scene.add(ambient, key, rim);
  return rim;
}

/** Colors hands and rim from the page's theme tokens. Returns whether the theme is light. */
export function paintHands(element: Element, hands: readonly HandMesh[], rim: THREE.DirectionalLight): boolean {
  const paper = cssColor(element, '--paper', '#f4f8fa');
  const ink = new THREE.Color(cssColor(element, '--ink', '#05090c'));
  const accent = new THREE.Color(cssColor(element, '--accent', '#ade4f8'));
  const light = luminance(parseRgb(paper)) > 0.5;
  for (const { skin, dorsal, accent: highlight } of hands) {
    skin.color.set(paper).lerp(ink, light ? 0.22 : 0.5);
    dorsal.color.set(paper).lerp(ink, light ? 0.62 : 0.25);
    highlight.color.copy(accent);
  }
  rim.color.copy(accent);
  return light;
}
