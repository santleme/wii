import * as THREE from 'three';
import type { SportActionEvent } from '../../cv/protocol';
import { GameLoop } from '../core/GameLoop';
import type { GameHudState as CoreGameHudState } from '../core/hud';
import { localDateIso, MISSION_XP } from '../engagement/missions';
import { getBrowserEngagementStores } from '../engagement/browserStores';
import { DailyMissionSession } from '../engagement/dailyMissionSession';
import { progressionFor, type SportProgress } from '../engagement/progression';
import { hash32, mulberry32 } from '../engagement/seededRandom';
import { type Feedback, awardText, SHAKE_DURATION_S, shakeOffset } from './feedback';
import { adjudicationDt, applySprint, applyStep, easeSpeed, type Gait, gaitFor, nextPace, type Pace, stumble } from './gait';
import { HurdleFlow, type ItemKind, RUNNER_Z } from './hurdleFlow';
import { ItemAssets } from './itemAssets';
import { JUMP_DURATION_S, jumpHeight } from './jump';
import { highestRankedScore, parseRanking, type RunResult, rankRun } from './ranking';
import { RunGate } from './runGate';
import { fovFor, scrollZ, timeBoost } from './scroll';
import { type Lane, nextKind, nextLane } from './spawn';
import { isTrackRecord, loadTrackProgress, trackMissionValue, trackRecordChase, trackRunXp } from './trackEngagement';
import { isPerfectJump, TrackScore } from './trackScore';

export interface TrackRunResult extends RunResult {
  xpEarned: number;
  bestCombo: number;
  /** Personal-progress achievement; kept separate from the per-run top-N ranking. */
  achievement?: string;
}

export type GameHudState = Omit<CoreGameHudState, 'feedback'> & {
  feedback?: Feedback;
  combo?: number;
  banner?: { title: string; detail?: string };
  result?: TrackRunResult;
}
type Item = { group: THREE.Group; kind: ItemKind; lane: number; z: number; passed: boolean };
// Scenery loops between the fog and a point behind the camera, so recycling is never visible.
const SCENERY_MIN_Z = -66;
const SCENERY_MAX_Z = 14;
const RANKING_KEY = 'wii-track-ranking';
const GAIT_STATUS: Record<Gait, string> = { idle: 'Parado', walk: 'Andando', run: 'Correndo' };

function readTrackRanking(): number[] {
  try { return parseRanking(localStorage.getItem(RANKING_KEY)); } catch { return []; }
}

function writeTrackRanking(ranking: number[]): void {
  try { localStorage.setItem(RANKING_KEY, JSON.stringify(ranking)); } catch {}
}

export class TrackGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(52, 1, 0.1, 120);
  private readonly runner = new THREE.Group();
  private readonly legs: THREE.Group[] = [];
  private readonly arms: THREE.Group[] = [];
  private readonly scenery: THREE.Mesh[] = [];
  private readonly shadow = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
  private readonly items: Item[] = [];
  private readonly itemAssets = new ItemAssets();
  private readonly loop: GameLoop;
  private readonly hudTimer: number;
  private readonly engagementStores = getBrowserEngagementStores();
  private readonly progressStore = this.engagementStores.progress;
  private readonly missionDate = localDateIso(new Date());
  private readonly missionSession = new DailyMissionSession(this.engagementStores.missions, 'track', this.missionDate);
  /** The day's obstacle sequence is repeatable; spawn timing still depends on the player's movement. */
  private readonly spawnRandom = mulberry32(hash32(`${this.missionDate}:track`));
  private progress: SportProgress;
  private legacyBestScore = 0;
  private lane = 0;
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
  private result?: TrackRunResult;
  private missionCompletion?: { missionId: string; promise: Promise<boolean> };
  private status = 'Ande ou corra no lugar com a câmera, ou use ↓';

  constructor(canvas: HTMLCanvasElement, private readonly onHud: (state: GameHudState) => void) {
    const trackProgress = loadTrackProgress(this.progressStore, highestRankedScore(readTrackRanking()));
    this.progress = trackProgress.progress;
    this.legacyBestScore = trackProgress.legacyBestScore;
    this.scene.background = new THREE.Color(0x223038);
    this.scene.fog = new THREE.Fog(0x223038, 25, 75);
    this.camera.position.set(0, 3.4, 11);
    this.camera.lookAt(0, 1.5, -8);
    this.setupScene();
    this.loop = new GameLoop(canvas, this.scene, this.camera, (dt, _simulationTimeMs, wallTimeMs) => this.update(dt, wallTimeMs));
    this.hudTimer = window.setInterval(() => this.publishHud(), 80);
  }

  private setupScene(): void {
    this.scene.add(new THREE.HemisphereLight(0xbad8e6, 0x253038, 2.1));
    const sun = new THREE.DirectionalLight(0xfff1d0, 3);
    sun.position.set(-5, 10, 6); this.scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 100), new THREE.MeshBasicMaterial({ color: 0x263235 }));
    ground.rotation.x = -Math.PI / 2; ground.position.z = -30; this.scene.add(ground);
    const track = new THREE.Mesh(new THREE.PlaneGeometry(9, 90), new THREE.MeshBasicMaterial({ color: 0x454e50 }));
    track.rotation.x = -Math.PI / 2; track.position.set(0, 0.02, -32); this.scene.add(track);
    const stripeGeo = new THREE.BoxGeometry(0.06, 0.01, 2.2);
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0xf4b544 });
    for (const x of [-3, 0, 3]) {
      for (let z = SCENERY_MIN_Z; z < SCENERY_MAX_Z; z += 4) this.addScenery(new THREE.Mesh(stripeGeo, stripeMat), x, 0.035, z);
    }
    for (let i = 0; i < (SCENERY_MAX_Z - SCENERY_MIN_Z) / 5; i += 1) {
      const h = 2 + (i % 3) * 1.2;
      const building = new THREE.Mesh(new THREE.BoxGeometry(2 + (i % 2), h, 2), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x27373b : 0x202c30, flatShading: true }));
      this.addScenery(building, i % 2 ? -7 : 7, h / 2, SCENERY_MIN_Z + i * 5);
    }
    this.shadow.rotation.x = -Math.PI / 2; this.shadow.position.set(0, 0.045, RUNNER_Z); this.scene.add(this.shadow);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.85, 4, 8), new THREE.MeshStandardMaterial({ color: 0xeff0e9, roughness: 0.72, flatShading: true }));
    torso.position.y = 1.22; this.runner.add(torso);
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 1), new THREE.MeshStandardMaterial({ color: 0xe8b896, flatShading: true }));
    head.position.y = 2.08; this.runner.add(head);
    const trousers = new THREE.MeshStandardMaterial({ color: 0x34434a, flatShading: true });
    const shoes = new THREE.MeshStandardMaterial({ color: 0xf7a942, flatShading: true });
    for (const side of [-1, 1]) {
      const leg = new THREE.Group(); leg.position.set(side * 0.16, 0.82, 0);
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.48, 3, 5), trousers); thigh.position.y = -0.25; leg.add(thigh);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.12, 0.38), shoes); foot.position.set(0, -0.58, -0.06); leg.add(foot);
      this.runner.add(leg); this.legs.push(leg);
      const arm = new THREE.Group(); arm.position.set(side * 0.4, 1.63, 0);
      const upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.4, 3, 5), trousers); upperArm.position.y = -0.23; arm.add(upperArm);
      arm.rotation.z = side * -0.12; this.runner.add(arm); this.arms.push(arm);
    }
    this.runner.position.set(0, 0, RUNNER_Z); this.scene.add(this.runner);
    this.addItem('hurdle', -1, -30);
    this.addItem('hurdle', 1, -48);
  }

  private addScenery(mesh: THREE.Mesh, x: number, y: number, z: number): void {
    mesh.position.set(x, y, z); this.scene.add(mesh); this.scenery.push(mesh);
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

  onAction(event: SportActionEvent): void {
    if (event.type === 'step') this.pace = applyStep(this.pace);
    if (event.type === 'sprint') {
      this.lastSprintInputAtMs = event.timestampMs;
      this.pace = applySprint(this.pace, event);
    }
    if (this.result || this.gate.phase !== 'running') return;
    if (event.type === 'jump') { this.jumpTime = JUMP_DURATION_S; this.jumpSource = 'camera'; this.status = 'Salto!'; }
    if (event.type === 'lane') { this.lane = Math.max(-1, Math.min(1, this.lane + (event.direction === 'left' ? -1 : 1))); }
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
    this.camera.position.set(shake.x, 3.4 + shake.y, 11);
    this.shownSpeed = easeSpeed(this.shownSpeed, this.pace.speed01, dt);
    const speed = this.shownSpeed;
    const gait = gaitFor(speed, this.gait);
    if (gait !== this.gait) this.status = GAIT_STATUS[gait];
    this.gait = gait;

    const cameraInputAgeMs = this.lastSprintInputAtMs !== undefined ? Math.max(0, wallTimeMs - this.lastSprintInputAtMs) : 0;
    const physicsDt = adjudicationDt(this.pace, dt, cameraInputAgeMs);
    this.score.advance(physicsDt, speed);
    this.runner.position.x += (this.lane * 1.5 - this.runner.position.x) * Math.min(1, dt * 10);
    // One leg swing per step: follow the player's cadence, or estimate it from speed for the keyboard.
    if (gait !== 'idle') this.stridePhase += dt * Math.PI * (this.pace.cadenceSpm || 70 + speed * 130) / 60;
    const swing = gait === 'idle' ? 0 : gait === 'walk' ? 0.4 : 0.95;
    const stride = Math.sin(this.stridePhase) * swing;
    this.legs[0]!.rotation.x = stride; this.legs[1]!.rotation.x = -stride;
    this.arms[0]!.rotation.x = -stride * (gait === 'run' ? 1.1 : 0.65); this.arms[1]!.rotation.x = -this.arms[0]!.rotation.x;
    this.runner.rotation.x = gait === 'run' ? -0.16 : 0;
    if (this.jumpTime > 0) {
      const jumpDt = this.jumpSource === 'keyboard' ? dt : physicsDt;
      this.jumpTime = Math.max(0, this.jumpTime - jumpDt);
      this.runner.position.y = jumpHeight(this.jumpTime);
      if (this.jumpTime === 0) this.status = GAIT_STATUS[gait];
    } else this.runner.position.y = gait === 'run' ? Math.abs(Math.sin(this.stridePhase)) * 0.14 : 0;
    if (speed > 0) this.movingTime += physicsDt;
    const boost = timeBoost(this.movingTime);
    const advance = physicsDt * speed * 22 * boost;
    const airborne = this.jumpTime > 0.15 || this.runner.position.y > 0.45;
    this.travelled += advance;
    for (const piece of this.scenery) piece.position.z = scrollZ(piece.position.z, advance, SCENERY_MIN_Z, SCENERY_MAX_Z);
    this.shadow.position.x = this.runner.position.x;
    // The shadow shrinks as the runner rises, which is what reads as height.
    this.shadow.scale.setScalar(1 / (1 + this.runner.position.y * 0.6));
    const fov = this.camera.fov + (fovFor(speed) - this.camera.fov) * Math.min(1, dt * 3);
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
    this.updateMission();
    if (this.score.over) this.endRun();
    for (const old of flow.despawned) {
      this.items.splice(this.items.indexOf(old), 1);
      this.scene.remove(old.group);
    }
    for (const item of this.items) item.group.position.z = item.z;
    if (flow.spawn) {
      const kind = nextKind(this.spawnRandom);
      this.addItem(kind, nextLane(this.laneHistory, this.spawnRandom), -48);
    }
  }

  private updateMission(): void {
    const missionId = this.missionSession.mission.id;
    if (this.missionCompletion?.missionId === missionId) return;
    const current = trackMissionValue(this.missionSession.mission.metric, {
      score: this.score.peak,
      bestCombo: this.score.bestComboCount,
    });
    const completion = this.missionSession.tracker.update(current);
    if (completion === false) return;
    const promise = completion.then((claimed) => {
      if (!claimed) return;
      const reward = this.progressStore.addXp('track', MISSION_XP);
      this.progress = reward.progress;
      const rankUp = reward.rankUp ? ` · RANK ${reward.after.rank}!` : '';
      if (!this.result?.achievement) this.showFeedback('milestone', `MISSÃO +${MISSION_XP} XP${rankUp}`);
      return true;
    });
    this.missionCompletion = { missionId, promise: promise.then((claimed) => claimed === true) };
  }

  /** The ranking lives in this browser only; blocked storage just means it is not remembered. */
  private endRun(): void {
    // A wipeout always ends the live score at zero; the peak is the run's recorded score.
    const finalScore = this.score.peak;
    const xpEarned = trackRunXp(finalScore);
    const progressResult = this.progressStore.record('track', finalScore, xpEarned);
    const isRecord = progressResult.isRecord && isTrackRecord(finalScore, this.legacyBestScore);
    this.progress = progressResult.progress;

    const previous = readTrackRanking();
    const achievement = progressResult.rankUp
      ? `RANK ${progressResult.after.rank}`
      : isRecord
        ? 'NOVO RECORDE'
        : undefined;
    this.result = {
      ...rankRun(previous, finalScore),
      xpEarned,
      bestCombo: this.score.bestComboCount,
      achievement,
    };
    writeTrackRanking(this.result.ranking);

    if (progressResult.rankUp) this.showFeedback('milestone', `RANK ${progressResult.after.rank}!`);
    else if (isRecord) this.showFeedback('milestone', 'NOVO RECORDE!');
    else this.publishHud();
  }

  private publishHud(): void {
    const score = this.score.display;
    const speed = Math.round(this.shownSpeed * 100) / 100;
    const { combo } = this.score;
    const rank = progressionFor(this.progress.xp);
    const missionLabel = this.missionSession.tracker.label();
    const missionProgress01 = this.missionSession.tracker.progress01();
    const banner = this.result
      ? undefined
      : this.gate.phase === 'countdown'
      ? { title: String(this.gate.count) }
      : this.gate.phase === 'paused'
        ? { title: 'PAUSADO', detail: 'Tracking perdido · volte ao quadro ou aperte uma tecla para seguir no teclado' }
        : undefined;
    const chase = this.result ? undefined : trackRecordChase(
      Math.max(this.progress.bestScore, this.legacyBestScore),
      this.score.peak,
    );
    const detail = this.result
      ? `FINAL ${this.result.points} · COMBO MÁX ×${this.result.bestCombo} · +${this.result.xpEarned} XP${this.result.achievement ? ` · ${this.result.achievement}` : ''}`
      : chase;
    const label = String(score).padStart(5, '0');
    const key = [
      label,
      speed,
      this.status,
      this.feedback?.id ?? 0,
      combo,
      banner?.title ?? '',
      this.result?.points ?? '',
      this.result?.xpEarned ?? '',
      rank.xp,
      missionLabel,
      detail ?? '',
    ].join('|');
    if (key === this.lastHud) return;
    this.lastHud = key;
    this.onHud({
      score,
      label,
      speed01: speed,
      status: this.status,
      metricLabel: 'RITMO',
      metricValue: `${Math.round(speed * 100)}%`,
      bestLabel: `RECORDE ${this.progress.bestScore}`,
      rankLabel: `RANK ${rank.rank} · ${rank.xp} XP`,
      rankProgress01: rank.progress01,
      missionLabel,
      missionProgress01,
      detail,
      feedback: this.feedback,
      combo,
      banner,
      result: this.result,
    });
  }

  dispose(): void {
    window.clearInterval(this.hudTimer);
    // Items leave the scene first so their shared resources are freed once, by their owner.
    for (const item of this.items) this.scene.remove(item.group);
    this.items.length = 0;
    this.loop.dispose();
    this.itemAssets.dispose();
  }
}
