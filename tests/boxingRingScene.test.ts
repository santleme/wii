import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBoxingRing, type BoxingRing } from '../src/games/boxing/ringScene';

interface TestRig {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  ring: BoxingRing;
  environmentTexture: THREE.Texture;
  environmentDisposals: { count: number };
}

function rendererDouble(): THREE.WebGLRenderer {
  return {
    toneMapping: THREE.LinearToneMapping,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap },
  } as unknown as THREE.WebGLRenderer;
}

function createTestRing(prepareScene?: (scene: THREE.Scene) => void): TestRig {
  const scene = new THREE.Scene();
  prepareScene?.(scene);
  const renderer = rendererDouble();
  const environmentTexture = new THREE.Texture();
  const environmentDisposals = { count: 0 };
  environmentTexture.addEventListener('dispose', () => {
    environmentDisposals.count += 1;
  });
  const ring = buildBoxingRing(scene, renderer, {
    createEnvironment: () => ({ texture: environmentTexture, dispose: () => environmentTexture.dispose() }),
  });
  return { scene, renderer, ring, environmentTexture, environmentDisposals };
}

function named<T extends THREE.Object3D>(scene: THREE.Scene, name: string): T {
  const object = scene.getObjectByName(name);
  expect(object).toBeDefined();
  return object as T;
}

describe('buildBoxingRing', () => {
  it('adds the procedural arena and one instanced crowd to the scene', () => {
    const { scene, renderer, ring, environmentTexture } = createTestRing();

    const root = named<THREE.Group>(scene, 'boxing-ring-root');
    expect(root.parent).toBe(scene);
    expect(named<THREE.Mesh>(scene, 'boxing-ring-architecture').geometry.getAttribute('color')).toBeDefined();
    expect(named<THREE.Mesh>(scene, 'boxing-arena-floor').receiveShadow).toBe(true);
    expect(named<THREE.Mesh>(scene, 'boxing-light-beams').visible).toBe(true);

    const instanced: THREE.InstancedMesh[] = [];
    scene.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) instanced.push(object);
    });
    expect(instanced).toHaveLength(1);
    expect(instanced[0]!.name).toBe('boxing-crowd');
    expect(instanced[0]!.count).toBe(360);
    expect(instanced[0]!.instanceMatrix.count).toBe(360);

    const spotlights: THREE.SpotLight[] = [];
    scene.traverse((object) => {
      if (object instanceof THREE.SpotLight) spotlights.push(object);
    });
    expect(spotlights).toHaveLength(4);
    expect(scene.environment).toBe(environmentTexture);
    expect(renderer.shadowMap.enabled).toBe(true);
    ring.dispose();
  });

  it('bakes red, white, and blue ropes into the vertex-colored ring geometry', () => {
    const { scene, ring } = createTestRing();
    const architecture = named<THREE.Mesh>(scene, 'boxing-ring-architecture');
    const positions = architecture.geometry.getAttribute('position');
    const colors = architecture.geometry.getAttribute('color');
    const ropeColors = [
      { y: 2.36, color: new THREE.Color(0xf04d45) },
      { y: 1.98, color: new THREE.Color(0xf7f5f0) },
      { y: 1.6, color: new THREE.Color(0x2477d2) },
    ];

    for (const rope of ropeColors) {
      let found = false;
      for (let vertex = 0; vertex < positions.count; vertex += 1) {
        const x = positions.getX(vertex);
        const y = positions.getY(vertex);
        const z = positions.getZ(vertex);
        const onSideRope =
          (Math.abs(x) < 0.6 && Math.abs(Math.abs(z) - 3.18) < 0.12) ||
          (Math.abs(z) < 0.6 && Math.abs(Math.abs(x) - 3.18) < 0.12);
        const sameColor =
          Math.abs(colors.getX(vertex) - rope.color.r) < 1e-6 &&
          Math.abs(colors.getY(vertex) - rope.color.g) < 1e-6 &&
          Math.abs(colors.getZ(vertex) - rope.color.b) < 1e-6;
        if (onSideRope && Math.abs(y - rope.y) < 0.06 && sameColor) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    }
    ring.dispose();
  });

  it('reduces crowd, beams, and spotlight shadows across quality tiers', () => {
    const { scene, renderer, ring } = createTestRing();
    const crowd = named<THREE.InstancedMesh>(scene, 'boxing-crowd');
    const keyA = named<THREE.SpotLight>(scene, 'boxing-key-light-a');
    const keyB = named<THREE.SpotLight>(scene, 'boxing-key-light-b');
    const beams = named<THREE.Mesh>(scene, 'boxing-light-beams');
    const beamMaterial = beams.material as THREE.MeshBasicMaterial;

    expect(crowd.count).toBe(360);
    expect(keyA.castShadow).toBe(true);
    expect(keyB.castShadow).toBe(true);
    expect(keyA.shadow.mapSize.x).toBe(1024);
    expect(beams.visible).toBe(true);
    expect(beamMaterial.opacity).toBeCloseTo(0.025);

    ring.setQuality(1);
    expect(crowd.count).toBe(240);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(keyA.castShadow).toBe(true);
    expect(keyB.castShadow).toBe(false);
    expect(keyA.shadow.mapSize.x).toBe(512);
    expect(beams.visible).toBe(true);
    expect(beamMaterial.opacity).toBeCloseTo(0.018);

    ring.setQuality(2);
    expect(crowd.count).toBe(120);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(keyA.castShadow).toBe(false);
    expect(keyB.castShadow).toBe(false);
    expect(beams.visible).toBe(false);

    ring.setQuality(0);
    expect(crowd.count).toBe(360);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(keyA.castShadow).toBe(true);
    expect(keyB.castShadow).toBe(true);
    expect(keyA.shadow.mapSize.x).toBe(1024);
    expect(beams.visible).toBe(true);
    ring.dispose();
  });

  it('keeps the reduced crowd distributed across all four sides', () => {
    const { scene, ring } = createTestRing();
    const crowd = named<THREE.InstancedMesh>(scene, 'boxing-crowd');
    ring.setQuality(2);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    let positiveX = false;
    let negativeX = false;
    let positiveZ = false;
    let negativeZ = false;
    for (let index = 0; index < crowd.count; index += 1) {
      crowd.getMatrixAt(index, matrix);
      position.setFromMatrixPosition(matrix);
      positiveX ||= position.x > 1;
      negativeX ||= position.x < -1;
      positiveZ ||= position.z > 1;
      negativeZ ||= position.z < -1;
    }
    expect(positiveX).toBe(true);
    expect(negativeX).toBe(true);
    expect(positiveZ).toBe(true);
    expect(negativeZ).toBe(true);
    ring.dispose();
  });

  it('releases shadow render targets when a key light stops casting shadows', () => {
    const { scene, ring } = createTestRing();
    const keyB = named<THREE.SpotLight>(scene, 'boxing-key-light-b');
    const shadowTarget = new THREE.WebGLRenderTarget(1, 1);
    let disposals = 0;
    shadowTarget.addEventListener('dispose', () => {
      disposals += 1;
    });
    keyB.shadow.map = shadowTarget;

    ring.setQuality(1);

    expect(disposals).toBe(1);
    expect(keyB.shadow.map).toBeNull();
    ring.dispose();
    expect(disposals).toBe(1);
  });

  it('produces identical crowd transforms for identical builds', () => {
    const first = createTestRing();
    const second = createTestRing();
    try {
      const firstCrowd = named<THREE.InstancedMesh>(first.scene, 'boxing-crowd');
      const secondCrowd = named<THREE.InstancedMesh>(second.scene, 'boxing-crowd');
      const firstMatrix = new THREE.Matrix4();
      const secondMatrix = new THREE.Matrix4();
      for (const index of [0, 1, 19, 119, 359]) {
        firstCrowd.getMatrixAt(index, firstMatrix);
        secondCrowd.getMatrixAt(index, secondMatrix);
        expect(Array.from(firstMatrix.elements)).toEqual(Array.from(secondMatrix.elements));
      }
    } finally {
      first.ring.dispose();
      second.ring.dispose();
    }
  });

  it('restores scene and renderer state and disposes resources exactly once', () => {
    const previousFog = new THREE.Fog(0x123456, 3, 9);
    const previousEnvironment = new THREE.Texture();
    const { scene, renderer, ring, environmentTexture, environmentDisposals } = createTestRing((scene) => {
      scene.fog = previousFog;
      scene.environment = previousEnvironment;
      scene.environmentIntensity = 0.7;
    });
    const architecture = named<THREE.Mesh>(scene, 'boxing-ring-architecture');
    const crowd = named<THREE.InstancedMesh>(scene, 'boxing-crowd');
    const keyA = named<THREE.SpotLight>(scene, 'boxing-key-light-a');
    const material = architecture.material as THREE.Material;
    const disposals = { geometry: 0, material: 0, crowd: 0, keyLight: 0 };
    architecture.geometry.addEventListener('dispose', () => {
      disposals.geometry += 1;
    });
    material.addEventListener('dispose', () => {
      disposals.material += 1;
    });
    crowd.addEventListener('dispose', () => {
      disposals.crowd += 1;
    });
    keyA.addEventListener('dispose', () => {
      disposals.keyLight += 1;
    });

    expect(scene.environment).toBe(environmentTexture);
    expect(scene.fog).not.toBe(previousFog);
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(renderer.shadowMap.type).toBe(THREE.PCFShadowMap);

    ring.dispose();
    ring.dispose();

    expect(scene.getObjectByName('boxing-ring-root')).toBeUndefined();
    expect(scene.environment).toBe(previousEnvironment);
    expect(scene.environmentIntensity).toBe(0.7);
    expect(scene.fog).toBe(previousFog);
    expect(renderer.toneMapping).toBe(THREE.LinearToneMapping);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(renderer.shadowMap.type).toBe(THREE.PCFShadowMap);
    expect(environmentDisposals.count).toBe(1);
    expect(disposals).toEqual({ geometry: 1, material: 1, crowd: 1, keyLight: 1 });

    ring.setQuality(0);
    expect(renderer.shadowMap.enabled).toBe(false);
  });
});
