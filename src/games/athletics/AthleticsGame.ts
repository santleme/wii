import * as THREE from 'three';
import type { ProceduralAudio } from '../audio';
import { GameLoop } from '../core/GameLoop';
import type { Feedback } from '../track/feedback';
import { createMiiRunner, type MiiRunner } from './miiRunner';
import { formatTime, type Goal, NO_BODY_ADVICE, parseRecords, Race, recordTime, type Split, TOP_SPEED } from './race';
import { buildStadium, type Stadium } from './stadiumScene';
import { LANE_WIDTH, R_RUN, sampleTrack, type TrackSample } from './trackCurve';

export interface AthleticsHudState {
  score: number;
  label: string;
  speed01: number;
  status: string;
  banner?: { title: string; detail?: string };
  feedback?: Feedback;
  finished?: { title: string; detail: string; standings: { name: string; time: string; you: boolean; status: 'confirmed' | 'estimated'; place: number }[]; standingsFinal: boolean; restart01: number };
  energy?: { value01: number; label: string; coaching?: string };
  /** Where everyone is in the race, 0–1. */
  runners?: { name: string; progress01: number; you: boolean }[];
  /** The camera picture should be shown large. */
  framing?: boolean;
}

const INTRO_S = 2.2;
const CHASE_RATE = 6;
const RECORDS_KEY = 'wii-athletics-records';
/** The player runs in lane 1; the rivals, in this order, in lanes 2 to 4. */
const RIVAL_SHIRTS = [0xe8604c, 0x4fbf58, 0xf5b52e];
/** Arms and legs keep moving during the warm-up, so the player sees the Mii copy them on the spot. */
const WARMUP_STRIDE_SPEED = 7;

/** What it takes to draw one athlete; the player and the rivals share it. */
interface Athlete {
  mii: MiiRunner;
  lane: number;
  stridePhase: number;
  lean: number;
}

const strideStep = (dt: number, speedMps: number) => (dt * Math.PI * (1.4 + speedMps * 0.28));

/**
 * The athletics race: the Athletics HD stadium, Mii and chase camera, driven only by how hard the
 * player runs in front of the camera (`setEffort`). Rules live in `Race`; this class draws them.
 */
export class AthleticsGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(54, 1, 0.1, 350);
  private readonly player: Athlete = { mii: createMiiRunner(0x2f9be8), lane: 0, stridePhase: 0, lean: 0 };
  private readonly rivals: Athlete[];
  private readonly loop: GameLoop;
  private readonly stadium: Stadium;
  private readonly hudTimer: number;
  private readonly race: Race;
  private readonly intro: THREE.CatmullRomCurve3;
  private readonly lookTarget = new THREE.Vector3();
  private readonly chasePosition = new THREE.Vector3();
  private readonly chaseTarget = new THREE.Vector3();
  private introTime = 0;
  private rivalSpeeds: number[];
  private record?: { best: number; isNew: boolean };
  private feedback?: Feedback;
  private cue = '';
  private lastHud = '';

  constructor(
    canvas: HTMLCanvasElement,
    private readonly onHud: (state: AthleticsHudState) => void,
    private readonly audio?: ProceduralAudio,
    goal: Goal = 100,
  ) {
    this.race = new Race(goal, Math.random);
    this.loop = new GameLoop(canvas, this.scene, this.camera, (dt, _simulationTimeMs, wallTimeMs) => this.update(dt, wallTimeMs));
    this.stadium = buildStadium(this.scene, this.loop.renderer);
    this.loop.onQualityChange = (tier) => this.stadium.setShadows(tier === 0);
    this.rivals = RIVAL_SHIRTS.map((shirt, i) => ({ mii: createMiiRunner(shirt), lane: i + 1, stridePhase: i, lean: 0 }));
    this.rivalSpeeds = this.rivals.map(() => 0);
    // Points at the player's own runner.
    const marker = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.28, 4), new THREE.MeshBasicMaterial({ color: 0xff8a2a }));
    marker.rotation.x = Math.PI;
    marker.position.y = 1.85;
    this.player.mii.root.add(marker);
    this.scene.add(this.player.mii.root, ...this.rivals.map((rival) => rival.mii.root));
    this.drawAll(0);
    const end = this.chasePosition.clone();
    this.intro = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-40, 55, 100),
      new THREE.Vector3(-5, 30, 75),
      new THREE.Vector3(end.x - 18, 9, end.z + 8),
      end,
    ]);
    this.camera.position.copy(this.intro.getPoint(0));
    this.camera.lookAt(this.lookTarget);
    this.stadium.follow(this.player.mii.root.position, this.camera.position);
    this.hudTimer = window.setInterval(() => this.publishHud(), 80);
    this.publishHud();
  }

  onAction(): void {}

  /** Played with the body only. */
  onKey(): void {}

  setEffort(effort: number, sampleAtMs?: number | null): void { this.race.setEffort(effort, sampleAtMs); }

  setFraming(advice: string | undefined, handsHidden?: boolean): void { this.race.setFraming(advice, handsHidden); }

  setHandsRaised(raised: boolean, atMs: number | null): void { this.race.setHandsRaised(raised, atMs); }

  setTracking(tracking: string): void {
    // A player the camera lost stops pushing; momentum fades on its own.
    if (tracking !== 'SEM POSE') return;
    this.race.setHandsRaised(false, null);
    if (this.race.advice !== null) this.race.setFraming(NO_BODY_ADVICE);
  }

  /**
   * Places and animates one athlete. Distance is offset by the goal, so every lane finishes on the
   * painted line and outer lanes get the staggered start of a real track.
   */
  private draw(athlete: Athlete, distance: number, speedMps: number, dt: number): TrackSample {
    const at = sampleTrack(distance - this.race.goal, athlete.lane);
    const { root } = athlete.mii;
    root.position.set(at.x, 0, at.z);
    root.rotation.y = Math.atan2(-at.tangentX, -at.tangentZ);
    const radius = R_RUN + athlete.lane * LANE_WIDTH;
    const lean = Math.abs(at.tangentZ) > 1e-3 ? Math.atan((speedMps * speedMps) / (9.81 * radius)) : 0;
    athlete.lean = THREE.MathUtils.damp(athlete.lean, lean, 6, dt);
    athlete.mii.animate(athlete.stridePhase, Math.min(1, speedMps / TOP_SPEED), athlete.lean);
    return at;
  }

  private drawAll(dt: number): void {
    const { race } = this;
    race.rivals.forEach((rival, i) => { this.draw(this.rivals[i]!, rival.distance, this.rivalSpeeds[i]!, dt); });
    // While warming up the Mii runs on the spot, at the speed the player shows.
    const shown = race.phase === 'warmup' ? race.effort01 * WARMUP_STRIDE_SPEED : race.speed;
    const at = this.draw(this.player, race.distance, shown, dt);
    this.chasePosition.set(at.x - at.tangentX * 6, 3.2, at.z - at.tangentZ * 6);
    this.chaseTarget.set(at.x + at.tangentX * 5, 1.1, at.z + at.tangentZ * 5);
  }

  private update(dt: number, wallTimeMs: number): void {
    const { race } = this;
    if (this.introTime < INTRO_S) this.introTime = Math.min(INTRO_S, this.introTime + dt);
    // The countdown waits for the opening shot; framing and warm-up can run under it.
    if (this.introTime >= INTRO_S || race.phase === 'framing' || race.phase === 'warmup') {
      const before = race.rivals.map((rival) => rival.distance);
      const splits = race.splits.length;
      race.step(dt, wallTimeMs);
      this.rivalSpeeds = race.rivals.map((rival, i) => (rival.distance - before[i]!) / Math.max(dt, 1e-6));
      for (const split of race.splits.slice(splits)) this.announce(split);
    }
    const shown = race.phase === 'warmup' ? race.effort01 * WARMUP_STRIDE_SPEED : race.speed;
    if (shown > 0.2) this.player.stridePhase += strideStep(dt, shown);
    this.rivals.forEach((rival, i) => { if (this.rivalSpeeds[i]! > 0.2) rival.stridePhase += strideStep(dt, this.rivalSpeeds[i]!); });
    this.playCues();
    this.drawAll(dt);

    if (this.introTime < INTRO_S) {
      const t = THREE.MathUtils.smoothstep(this.introTime / INTRO_S, 0, 1);
      this.intro.getPoint(t, this.camera.position);
      this.lookTarget.set(0, 0, 0).lerp(this.chaseTarget, t);
    } else {
      const blend = 1 - Math.exp(-CHASE_RATE * dt);
      this.camera.position.lerp(this.chasePosition, blend);
      this.lookTarget.lerp(this.chaseTarget, blend);
    }
    this.camera.lookAt(this.lookTarget);
    this.stadium.follow(this.player.mii.root.position, this.camera.position);
  }

  /** A beep per countdown number, then the start and a win. */
  private playCues(): void {
    const { race } = this;
    const cue = race.phase === 'countdown' ? `count-${Math.ceil(race.countdown)}` : race.phase;
    if (cue === this.cue) return;
    this.cue = cue;
    if (race.phase === 'countdown') this.audio?.bounce(1);
    if (race.phase === 'racing' || (race.phase === 'finished' && race.place === 1)) this.audio?.success(1);
  }

  private announce(split: Split): void {
    if (split.metres === this.race.goal) this.saveRecord();
    else this.audio?.milestone();
    this.feedback = { id: (this.feedback?.id ?? 0) + 1, kind: 'clear', text: `${split.metres} m · ${formatTime(split.seconds)}` };
    this.publishHud();
  }

  /** The record lives in this browser only; blocked storage just means it is not remembered. */
  private saveRecord(): void {
    let records = {};
    try { records = parseRecords(localStorage.getItem(RECORDS_KEY)); } catch {}
    const result = recordTime(records, this.race.goal, this.race.finishS!);
    try { localStorage.setItem(RECORDS_KEY, JSON.stringify(result.records)); } catch {}
    this.record = { best: result.best, isNew: result.isNew };
  }

  private publishHud(): void {
    const { race } = this;
    const metres = Math.min(race.goal, Math.floor(race.distance));
    const banner = this.introTime < INTRO_S && race.phase !== 'framing' && race.phase !== 'warmup'
      ? undefined
      : race.phase === 'framing'
        ? race.advice === undefined
          ? { title: 'Ótimo!', detail: 'Fique aí' }
          : { title: 'Ajuste a câmera', detail: race.advice ?? 'Ligue a câmera para correr' }
        : race.phase === 'warmup'
          ? { title: 'CORRA COM TUDO!', detail: `${race.retries ? 'Não senti você correr. De novo' : 'Aquecimento: mantenha o ritmo até o fim'} · ${Math.ceil(race.warmupLeft)}` }
          : race.phase === 'countdown' ? { title: String(Math.ceil(race.countdown)), detail: 'Pare. Corra quando zerar' } : undefined;
    const record = this.record?.isNew ? 'Novo recorde pessoal!' : this.record ? `Recorde pessoal: ${formatTime(this.record.best)}` : '';
    const finished = race.finishS !== undefined
      ? {
        title: !race.standingsFinal ? 'PROVA EM ANDAMENTO' : race.place === 1 ? 'VOCÊ VENCEU!' : `${race.place}º lugar`,
        detail: [`${formatTime(race.finishS)} nos ${race.goal} m`, record].filter(Boolean).join(' · '),
        standings: race.standings.map((runner) => ({ name: runner.name, time: formatTime(runner.timeS), you: runner.you, status: runner.status, place: runner.place })),
        standingsFinal: race.standingsFinal,
        restart01: Math.floor(race.restart01 * 20) / 20,
      }
      : undefined;
    const state: AthleticsHudState = {
      score: metres,
      label: formatTime(race.elapsedS),
      speed01: Math.round(race.effort01 * 100) / 100,
      // Coarse steps, so a steady run does not republish the HUD every tick.
      energy: finished ? undefined : { value01: Math.round(race.energy01 * 20) / 20, label: race.phase === 'warmup' || race.phase === 'framing' ? 'SINAL DA CORRIDA' : 'SUA ENERGIA', coaching: race.coaching },
      runners: race.phase === 'racing' ? [
        { name: 'Você', progress01: metres / race.goal, you: true },
        ...race.rivals.map((rival) => ({ name: rival.name, progress01: Math.min(1, Math.floor(rival.distance) / race.goal), you: false })),
      ] : undefined,
      status: race.phase === 'racing' ? `${race.place}º lugar · ${metres} / ${race.goal} m` : race.phase === 'finished' ? 'Chegada!' : 'Corra no lugar, mexendo os braços',
      banner,
      feedback: this.feedback,
      finished,
      framing: race.phase === 'framing' || race.phase === 'warmup',
    };
    const key = JSON.stringify(state);
    if (key === this.lastHud) return;
    this.lastHud = key;
    this.onHud(state);
  }

  dispose(): void {
    window.clearInterval(this.hudTimer);
    this.stadium.dispose();
    this.loop.dispose();
  }
}
