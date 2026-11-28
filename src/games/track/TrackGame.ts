import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { SportActionEvent } from '../../cv/protocol';
import { createMiiRunner } from '../athletics/miiRunner';
import { addRoomEnvironment } from '../core/environment';
import { GameLoop } from '../core/GameLoop';
import { createSkyDome } from '../core/scenery';
import { type BiomeSpec, biomeAt } from './biomes';
import { type Feedback, awardText, SHAKE_DURATION_S, shakeOffset } from './feedback';
import { applySprint, applyStep, easeSpeed, type Gait, gaitFor, inputFreshness, nextPace, type Pace, stumble } from './gait';
import { HurdleFlow, type ItemKind, RUNNER_Z } from './hurdleFlow';
import { ItemAssets } from './itemAssets';
import { JUMP_DURATION_S, jumpHeight } from './jump';
import { parseRanking, type RunResult, rankRun } from './ranking';
import { RunGate } from './runGate';
import { DustPool, SCENERY_MAX_Z, SCENERY_MIN_Z, SceneryPool } from './scenery';
import { scrollZ, timeBoost } from './scroll';
import { type Lane, nextKind, nextLane } from './spawn';
import { isPerfectJump, TrackScore } from './trackScore';

export interface GameHudState { score: number; label: string; speed01: number; status: string; feedback?: Feedback; combo?: number; banner?: { title: string; detail?: string }; result?: RunResult }
type Item = { group: THREE.Group; kind: ItemKind; lane: number; z: number; passed: boolean };
type BiomeColor = Exclude<keyof BiomeSpec, 'id' | 'endDistance' | 'props'>;
const RANKING_KEY = 'wii-track-ranking';
const GAIT_STATUS: Record<Gait, string> = { idle: 'Parado', walk: 'Andando', run: 'Correndo' };
/** Metres of track one repeat of the surface texture covers. */
const SURFACE_TILE = 4;
/** Shadows are cast in a box around the runner and the hurdles coming up. */
const SHADOW_CENTER = new THREE.Vector3(0, 0, RUNNER_Z - 10);
const SUN_OFFSET = new THREE.Vector3(-6, 14, 8);

/** Neutral rubber grain: the biome color tints it through the material color. */
function surfaceTexture(anisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D indisponível');
  context.fillStyle = '#e6e6e6';
  context.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i += 1) {
    context.fillStyle = ['#ffffff55', '#00000022', '#00000012', '#ffffff30'][i % 4]!;
    const size = i % 9 === 0 ? 3 : 1.5;
    context.fillRect(Math.random() * 256, Math.random() * 256, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  return texture;
}

export class TrackGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(54, 1, 0.1, 120);
  private readonly runner = new THREE.Group();
  private readonly mii = createMiiRunner();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private readonly trackMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  private removeEnvironment?: () => void;
  private readonly stripes: THREE.Mesh[] = [];
  private readonly skyDome = createSkyDome();
  private readonly sceneryPool = new SceneryPool(biomeAt(0).current.props);
  private readonly dustPool = new DustPool();
  /** Colors that follow the biome, each paired with the BiomeSpec field it reads. */
  private readonly tints: [THREE.Color, BiomeColor][] = [];
  private readonly tintTarget = new THREE.Color();
  private camX = 0;
  private landingDip = 0;
  private readonly shadow = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false }));
  private readonly items: Item[] = [];
  private readonly itemAssets = new ItemAssets();
  private readonly loop: GameLoop;
  private readonly hudTimer: number;
  private lane = 0;
  private cameraLaneZone: -1 | 0 | 1 | undefined;
  /** Speed asked for by the player and who set it; `shownSpeed` eases toward it. */
  private pace: Pace = { owner: 'camera', speed01: 0, cadenceSpm: 0 };
  private shownSpeed = 0;
  private gait: Gait = 'idle';
  private stridePhase = 0;
  private readonly score = new TrackScore();
  private readonly hurdleFlow = new HurdleFlow();
  private jumpTime = 0;
  private jumpSource: 'camera' | 'keyboard' = 'camera';
  private travelled = 0;
  /** Seconds actually spent moving: standing still, pauses and countdowns do not speed the run up. */
  private movingTime = 0;
  private lastSprintInputAtMs?: number;
  private readonly laneHistory: Lane[] = [];
  private lastHud = '';
  private feedback?: Feedback;
  private shakeTime = 0;
  private readonly gate = new RunGate();
  private result?: RunResult;
  private status = 'Ande ou corra no lugar com a câmera, ou use ↓';

  constructor(canvas: HTMLCanvasElement, private readonly onHud: (state: GameHudState) => void) {
    this.scene.background = null;
    this.camera.position.set(0, 3.1, 9.4);
    this.camera.lookAt(0, 1.4, -8);
    this.setupScene();
    this.applyBiome();
    this.loop = new GameLoop(canvas, this.scene, this.camera, (dt, _simulationTimeMs, wallTimeMs) => this.update(dt, wallTimeMs));
    const { renderer } = this.loop;
    // Tests swap the loop for one without a renderer; the scene itself does not need it.
    if (renderer) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.shadowMap.enabled = true;
      this.removeEnvironment = addRoomEnvironment(this.scene, renderer);
      this.trackMaterial.map = surfaceTexture(renderer.capabilities.getMaxAnisotropy());
      this.trackMaterial.map.repeat.set(1, 90 / SURFACE_TILE);
      this.loop.onQualityChange = (tier) => { this.sun.castShadow = tier === 0; };
    }
    this.hudTimer = window.setInterval(() => this.publishHud(), 80);
  }

  private setupScene(): void {
    const fog = new THREE.Fog(0xd0eafc, 22, 64);
    this.scene.fog = fog;
    const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.3);
    const { sun } = this;
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.normalBias = 0.03;
    Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 18, bottom: -18, near: 1, far: 60 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.target.position.copy(SHADOW_CENTER);
    sun.position.copy(SHADOW_CENTER).add(SUN_OFFSET);
    this.scene.add(hemi, sun, sun.target, this.skyDome.mesh, this.sceneryPool.group, this.dustPool.mesh);
    const surface = (roughness = 0.85) => new THREE.MeshStandardMaterial({ roughness, metalness: 0 });
    const ground = surface(), curb = surface(0.6), stripe = surface(0.6), track = this.trackMaterial;
    const flat = (width: number, length: number, material: THREE.Material, y: number, z: number) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, length), material);
      mesh.rotation.x = -Math.PI / 2; mesh.position.set(0, y, z); mesh.receiveShadow = true; this.scene.add(mesh);
    };
    flat(120, 100, ground, 0, -30);
    flat(4.8, 90, track, 0.02, -30);
    const curbGeo = new RoundedBoxGeometry(0.24, 0.16, 90, 2, 0.06);
    for (const x of [-2.5, 2.5]) {
      const curbs = new THREE.Mesh(curbGeo, curb);
      curbs.position.set(x, 0.07, -30); curbs.receiveShadow = true; this.scene.add(curbs);
    }
    const stripeGeo = new RoundedBoxGeometry(0.09, 0.012, 2.2, 1, 0.005);
    for (const x of [-0.75, 0.75]) {
      for (let z = SCENERY_MIN_Z; z < SCENERY_MAX_Z; z += 4) {
        const mesh = new THREE.Mesh(stripeGeo, stripe);
        mesh.position.set(x, 0.035, z); mesh.receiveShadow = true; this.scene.add(mesh); this.stripes.push(mesh);
      }
    }
    this.tints.push(
      [this.skyDome.topColor, 'skyTop'], [this.skyDome.bottomColor, 'skyBottom'], [fog.color, 'skyBottom'],
      [ground.color, 'ground'], [track.color, 'track'], [curb.color, 'curb'], [stripe.color, 'stripe'],
      [hemi.color, 'hemiSky'], [hemi.groundColor, 'hemiGround'], [sun.color, 'sun'],
    );
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.set(0, 0.045, RUNNER_Z); this.scene.add(this.shadow);
    // The same Mii as Atletismo HD, scaled to the hurdle height this mode was tuned for.
    this.mii.root.scale.setScalar(1.3);
    this.runner.add(this.mii.root);
    this.runner.position.set(0, 0, RUNNER_Z); this.scene.add(this.runner);
    this.addItem('hurdle', -1, -30);
    this.addItem('hurdle', 1, -48);
  }

  /** Blends every tinted color toward the next biome; returns the current one. */
  private applyBiome(): BiomeSpec {
    const { current, next, blend01 } = biomeAt(this.travelled);
    for (const [color, key] of this.tints) color.setHex(current[key]).lerp(this.tintTarget.setHex(next[key]), blend01);
    return current;
  }

  private addItem(kind: ItemKind, lane: Lane, z: number): void {
    if (kind === 'hurdle') {
      this.laneHistory.push(lane);
      if (this.laneHistory.length > 2) this.laneHistory.shift();
    }
    const group = this.itemAssets.create(kind);
    group.position.set(lane * 1.5, 0, z); this.scene.add(group); this.items.push({ group, kind, lane, z, passed: false });
  }

  setTracking(tracking: string): void {
    this.gate.setTracking(tracking);
    this.publishHud();
  }

  /**
   * Camera lane authority: the zone is the position the player's body actually occupies, so it
   * applies absolutely — never as a step — whenever it changes, in any game phase. Keyboard
   * steps still write the lane directly and hold until the body zone changes again; while the
   * zone is undefined the camera has no opinion and the keyboard owns the lane outright.
   * The comparison rests on the last DEFINED zone, not current availability: reacquiring the
   * same zone after a blurry frame is not a body movement and must not steamroll a keyboard
   * pick made during the drop.
   */
  setLaneZone(zone: -1 | 0 | 1 | undefined): void {
    if (zone === undefined) return;
    if (zone !== this.cameraLaneZone) this.lane = zone;
    this.cameraLaneZone = zone;
  }

  /** Ends the camera session's lane authority: the next session reasserts from a clean comparison. */
  resetLaneZone(): void {
    this.cameraLaneZone = undefined;
  }

  onAction(event: SportActionEvent): void {
    if (event.type === 'step') this.pace = applyStep(this.pace);
    if (event.type === 'sprint') {
      this.lastSprintInputAtMs = event.timestampMs;
      this.pace = applySprint(this.pace, event);
    }
    if (this.result || this.gate.phase !== 'running') return;
    if (event.type === 'jump') { this.jumpTime = JUMP_DURATION_S; this.jumpSource = 'camera'; this.status = 'Salto!'; }
  }

  onKey(key: string): void {
    const pressed = key.toLowerCase();
    if (!['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' ', 'a', 'd', 'w', 's'].includes(pressed)) return;
    if (this.result || this.gate.resumeByKey()) return;
    if (this.gate.phase !== 'running' && pressed !== 'arrowdown' && pressed !== 's') return;
    if (key === 'ArrowLeft' || key.toLowerCase() === 'a') this.lane = Math.max(-1, this.lane - 1);
    if (key === 'ArrowRight' || key.toLowerCase() === 'd') this.lane = Math.min(1, this.lane + 1);
    if (key === ' ' || key === 'ArrowUp' || key.toLowerCase() === 'w') { this.jumpTime = JUMP_DURATION_S; this.jumpSource = 'keyboard'; }
    if (key === 'ArrowDown' || key.toLowerCase() === 's') {
      // Keyboard cycles stopped → walking → running and keeps the pick until the player steps on camera.
      this.pace = { owner: 'keyboard', speed01: nextPace(this.pace.speed01), cadenceSpm: 0 };
    }
  }

  private showFeedback(kind: Feedback['kind'], text: string): void {
    this.feedback = { id: (this.feedback?.id ?? 0) + 1, kind, text };
    this.publishHud();
  }

  private update(dt: number, wallTimeMs: number): void {
    // Everything below is frozen until the gate opens: no travel, score, jump or judging.
    if (this.result) return;
    this.gate.advance(dt);
    if (this.gate.phase !== 'running') return;
    this.shakeTime = Math.max(0, this.shakeTime - dt);
    const shake = shakeOffset(this.shakeTime);
    this.shownSpeed = easeSpeed(this.shownSpeed, this.pace.speed01, dt);
    const speed = this.shownSpeed;
    const gait = gaitFor(speed, this.gait);
    if (gait !== this.gait) this.status = GAIT_STATUS[gait];
    this.gait = gait;

    const cameraInputAgeMs = this.lastSprintInputAtMs !== undefined ? Math.max(0, wallTimeMs - this.lastSprintInputAtMs) : 0;
    // One freshness verdict drives both clocks: physics (score, hurdles, jump) runs only on
    // fresh input, while the visual scroll also survives coasting — a transient single-frame
    // occlusion burst never freezes the track on screen, but nothing is judged on stale input.
    const freshness = inputFreshness(this.pace, cameraInputAgeMs);
    const physicsDt = freshness === 'fresh' ? dt : 0;
    const visualDt = freshness === 'stale' ? 0 : dt;
    this.score.advance(physicsDt, speed);
    this.runner.position.x += (this.lane * 1.5 - this.runner.position.x) * Math.min(1, dt * 10);
    // Lean into the lane change, upright again on arrival.
    this.runner.rotation.z = THREE.MathUtils.damp(this.runner.rotation.z, (this.runner.position.x - this.lane * 1.5) * 0.14, 14, dt);
    // One leg swing per step: follow the player's cadence, or estimate it from speed for the keyboard.
    const lastStep = Math.floor(this.stridePhase / Math.PI);
    if (gait !== 'idle') this.stridePhase += dt * Math.PI * (this.pace.cadenceSpm || 70 + speed * 130) / 60;
    this.mii.animate(this.stridePhase, gait === 'idle' ? 0 : speed, 0);
    if (this.jumpTime > 0) {
      const jumpDt = this.jumpSource === 'keyboard' ? dt : physicsDt;
      this.jumpTime = Math.max(0, this.jumpTime - jumpDt);
      this.runner.position.y = jumpHeight(this.jumpTime);
      if (this.jumpTime === 0) {
        this.status = GAIT_STATUS[gait];
        this.landingDip = 0.22;
        this.dustPool.emit(this.runner.position.x, RUNNER_Z + 0.2, 8);
      }
    } else {
      // The Mii bobs on its own stride.
      this.runner.position.y = 0;
      if (gait === 'run' && Math.floor(this.stridePhase / Math.PI) !== lastStep) this.dustPool.emit(this.runner.position.x, RUNNER_Z + 0.2, 2);
    }
    if (speed > 0) this.movingTime += physicsDt;
    const boost = timeBoost(this.movingTime);
    const advance = physicsDt * speed * 22 * boost;
    const visualAdvance = visualDt * speed * 22 * boost;
    const airborne = this.jumpTime > 0.15 || this.runner.position.y > 0.45;
    // `travelled` (spawn distance and biome) advances on the visual clock, so it keeps moving
    // while the input coasts even though hurdle adjudication is frozen. Preserved as-is:
    // whether spawn/biome should freeze together with physics during a blackout is an open
    // decision, deliberately not made here.
    this.travelled += visualAdvance;
    const { map } = this.trackMaterial;
    if (map) map.offset.y = (map.offset.y + visualAdvance / SURFACE_TILE) % 1;
    for (const stripe of this.stripes) stripe.position.z = scrollZ(stripe.position.z, visualAdvance, SCENERY_MIN_Z, SCENERY_MAX_Z);
    this.sceneryPool.update(visualAdvance, this.applyBiome().props);
    this.dustPool.update(dt, visualAdvance);
    this.shadow.position.x = this.runner.position.x;
    // The shadow shrinks as the runner rises, which is what reads as height.
    this.shadow.scale.setScalar(1 / (1 + this.runner.position.y * 0.6));
    this.camX = THREE.MathUtils.damp(this.camX, this.runner.position.x * 0.35, 6, dt);
    this.landingDip = THREE.MathUtils.damp(this.landingDip, 0, 9, dt);
    const bob = gait === 'run' && this.jumpTime === 0 ? Math.abs(Math.sin(this.stridePhase)) * 0.04 : 0;
    this.camera.position.set(this.camX + shake.x, 3.1 + bob - this.landingDip + shake.y, 9.4);
    this.camera.lookAt(this.camX * 0.5, 1.4, -8);
    const fov = THREE.MathUtils.damp(this.camera.fov, 54 + 8 * THREE.MathUtils.clamp(speed, 0, 1), 3, dt);
    if (Math.abs(fov - this.camera.fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    const flow = this.hurdleFlow.advance(this.items, advance, this.lane, airborne, this.travelled, boost);
    for (const { hurdle: item, outcome } of flow.judged) {
      // A dodge scores nothing and leaves the combo as it is.
      if (outcome === 'cleared') this.showFeedback('clear', awardText(this.score.hurdleCleared(isPerfectJump(this.jumpTime))));
      if (outcome === 'hit') {
        const penalty = this.score.hurdleHit();
        this.shownSpeed = stumble(this.shownSpeed);
        this.shakeTime = SHAKE_DURATION_S;
        this.showFeedback('hit', `TROPEÇOU! −${penalty}`);
      }
      if (outcome === 'collected') {
        this.showFeedback('coin', `+${this.score.coinCollected()}`);
        item.group.visible = false;
      }
    }
    if (this.score.over) this.endRun();
    for (const old of flow.despawned) {
      this.items.splice(this.items.indexOf(old), 1);
      this.scene.remove(old.group);
    }
    for (const item of this.items) {
      item.group.position.z = item.z;
      if (item.kind === 'coin') item.group.rotation.y += dt * 3;
    }
    if (flow.spawn) {
      const kind = nextKind(Math.random);
      this.addItem(kind, nextLane(this.laneHistory, Math.random), -48);
    }
  }

  /** The ranking lives in this browser only; blocked storage just means it is not remembered. */
  private endRun(): void {
    let previous: number[] = [];
    try { previous = parseRanking(localStorage.getItem(RANKING_KEY)); } catch {}
    this.result = rankRun(previous, this.score.peak);
    try { localStorage.setItem(RANKING_KEY, JSON.stringify(this.result.ranking)); } catch {}
    this.publishHud();
  }

  private publishHud(): void {
    const score = this.score.display;
    const speed = Math.round(this.shownSpeed * 100) / 100;
    const { combo } = this.score;
    const banner = this.result
      ? undefined
      : this.gate.phase === 'countdown'
      ? { title: String(this.gate.count) }
      : this.gate.phase === 'paused'
        ? { title: 'PAUSADO', detail: 'Tracking perdido · volte ao quadro ou aperte uma tecla para seguir no teclado' }
        : undefined;
    const label = String(score).padStart(5, '0');
    const key = `${label}-${speed}-${this.status}-${this.feedback?.id}-${combo}-${banner?.title}-${this.result?.points}`;
    if (key === this.lastHud) return;
    this.lastHud = key;
    this.onHud({ score, label, speed01: speed, status: this.status, feedback: this.feedback, combo, banner, result: this.result });
  }

  dispose(): void {
    window.clearInterval(this.hudTimer);
    // Pooled objects leave the scene first so their resources are freed once, by their owner.
    for (const item of this.items) this.scene.remove(item.group);
    this.items.length = 0;
    this.scene.remove(this.sceneryPool.group, this.dustPool.mesh, this.skyDome.mesh);
    this.removeEnvironment?.();
    // Lights are not meshes, so the scene-wide disposal leaves the shadow map to us.
    this.sun.dispose();
    this.loop.dispose();
    this.itemAssets.dispose();
    this.sceneryPool.dispose();
    this.dustPool.dispose();
    this.skyDome.dispose();
  }
}
