import * as THREE from 'three';
import { collectFixedStepTimestamps, MAX_FRAME_DELTA_SECONDS } from './fixedStepTiming';
import { QualityGovernor, type QualityTier, TIER_PIXEL_RATIO } from './qualityGovernor';

export function disposeObjectTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (object instanceof THREE.InstancedMesh || object instanceof THREE.BatchedMesh) object.dispose();
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of meshMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      if (material instanceof THREE.ShaderMaterial && material.uniforms) {
        for (const uniform of Object.values(material.uniforms)) {
          if (uniform.value instanceof THREE.Texture) textures.add(uniform.value);
        }
      }
    }
  });
  geometries.forEach((geometry) => { geometry.dispose(); });
  textures.forEach((texture) => { texture.dispose(); });
  materials.forEach((material) => { material.dispose(); });
}

export class GameLoop {
  readonly renderer: THREE.WebGLRenderer;
  private accumulator = 0;
  private previousTime = 0;
  private simulationTimeMs = 0;
  private readonly observer: ResizeObserver;
  private disposed = false;
  private readonly governor = new QualityGovernor();
  /** Opt-in: only a game that sets this gets adaptive resolution. */
  onQualityChange?: (tier: QualityTier) => void;
  /** Preventing the default is what lets the browser hand the context back. */
  private readonly onContextLost = (event: Event) => event.preventDefault();

  constructor(
    canvas: HTMLCanvasElement,
    readonly scene: THREE.Scene,
    readonly camera: THREE.PerspectiveCamera,
    private readonly update: (dt: number, simulationTimeMs: number, wallTimeMs: number, finalStep?: boolean) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(0x10161b);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.renderer.setAnimationLoop((time) => this.tick(time));
  }

  private tick(time: number): void {
    if (this.disposed) return;
    if (!this.previousTime) {
      this.previousTime = time;
      this.simulationTimeMs = time;
    }
    if (this.onQualityChange && this.governor.sample(time - this.previousTime)) this.applyQuality(this.onQualityChange);
    this.accumulator += Math.min((time - this.previousTime) / 1000, MAX_FRAME_DELTA_SECONDS);
    this.previousTime = time;
    const fixed = 1 / 60;
    const schedule = collectFixedStepTimestamps(this.simulationTimeMs, this.accumulator, fixed, 5);
    this.accumulator = schedule.remainderSeconds;
    for (const [index, simulationTimeMs] of schedule.timestampsMs.entries()) {
      this.simulationTimeMs = simulationTimeMs;
      // Only the last step is ever rendered: intermediate steps in a catch-up frame exist for
      // simulation alone, and games can skip per-step presentation work when this is false.
      this.update(fixed, simulationTimeMs, time, index === schedule.timestampsMs.length - 1);
    }
    this.renderer.render(this.scene, this.camera);
  }

  private applyQuality(notify: (tier: QualityTier) => void): void {
    const { tier } = this.governor;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TIER_PIXEL_RATIO[tier]));
    this.resize();
    notify(tier);
  }

  private resize(): void {
    const host = this.renderer.domElement.parentElement ?? this.renderer.domElement;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.observer.disconnect();
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    disposeObjectTree(this.scene);
    this.renderer.dispose();
  }
}
