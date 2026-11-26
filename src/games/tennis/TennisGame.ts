import * as THREE from 'three';
import type { SportActionEvent } from '../../cv/protocol';
import type { ProceduralAudio } from '../audio';
import { GameLoop } from '../core/GameLoop';
import type { GameHudState } from '../core/hud';
import {
  elapsedSimulationSeconds,
  isBeforeOrAtPauseBoundary,
  mapWallTimestampToSimulationMs,
  MAX_FRAME_DELTA_SECONDS,
} from '../core/fixedStepTiming';
import { localDateIso, MISSION_XP } from '../engagement/missions';
import { getBrowserEngagementStores } from '../engagement/browserStores';
import { DailyMissionSession } from '../engagement/dailyMissionSession';
import { applyMissionReward, MissionCompletionCache } from '../engagement/missionCompletion';
import { progressionFor, type ProgressRecordResult } from '../engagement/progression';
import { advanceBall, createBall, solveOutgoing, timeAtPlane, type BallState } from './ballistics';
import { adjudicateContact, type ContactOutcome } from './contactAdjudicator';
import { adaptOpponentSkill, createOpponentAi, decideReturn, type OpponentAiState } from './opponentAi';
import { ballAtPlannedContact, resolveScheduledOpponentReturn, type OpponentHitPlan } from './opponentReturn';
import { advancePlayerShotToNow, crossesNetBelowCord } from './rallyPhysics';
import { RallyTracker, tennisMissionValue } from './tennisEngagement';
import {
  awardPoint,
  createScore,
  matchPerformance,
  matchXp,
  pointLabels,
  type PlayerSide,
  type TennisScoreState,
} from './tennisScore';

/**
 * Wii-Sports-style tennis: a game of WHEN, not WHERE. The player never aims with the arm —
 * direction comes from swing timing relative to the ball's arrival, adjudicated retroactively
 * against the ball state rewound to the swing's physical peak (docs/design-tenis.md §3).
 * Movement is automatic; the only skills are timing and reading the ball.
 *
 * Time base: performance.now() milliseconds, because peakTimestampMs lives in it.
 */

const NET_Z = 0;
const NET_HEIGHT = 0.9;
const OPPONENT_CONTACT_PLANE_Z = -7.2;
const COURT_HALF_WIDTH = 3.5;
const BASELINE_Z = 9.5;
const PLAYER_HOME_Z = 8.3;
const OPPONENT_HOME_Z = -8.3;
const PLAYER_MOVE_SPEED = 5.5;
const TAPE_WINDOW_MS = 1200;
const POINT_PAUSE_S = 2.0;
const MATCH_PAUSE_S = 5.0;
const TOSS_VY = 5.4; // apex ≈ 1.49 m above the release
const SERVE_CONTACT_X_OFFSET = 0.35;

type Phase =
  | { kind: 'player-serve'; tossTimeMs: number; idealHitMs: number }
  | { kind: 'opponent-serve'; hitAtMs: number }
  | { kind: 'rally' }
  | { kind: 'point-over'; resumeAtMs: number }
  | { kind: 'match-over'; restartAtMs: number };

interface TapeEntry {
  tMs: number;
  ball: BallState;
}

const nowMs = () => performance.now();

export class TennisGame {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(48, 1, 0.1, 90);
  private readonly ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xd8ff54, emissive: 0x4d7020, emissiveIntensity: 0.45 }),
  );
  private readonly playerMesh: THREE.Mesh;
  private readonly opponentMesh: THREE.Mesh;
  private readonly playerRacket: THREE.Group;
  private readonly opponentRacket: THREE.Group;
  private readonly loop: GameLoop;
  private readonly hudTimer: number;
  private readonly engagementStores = getBrowserEngagementStores();
  private readonly progressStore = this.engagementStores.progress;
  private readonly missionSession = new DailyMissionSession(
    this.engagementStores.missions,
    'tennis',
    localDateIso(new Date()),
  );
  private progress = this.progressStore.load('tennis');

  private ball: BallState | null = null;
  private tape: TapeEntry[] = [];
  private phase: Phase = { kind: 'point-over', resumeAtMs: 0 };
  private score: TennisScoreState = createScore('player');
  private playerX = 0;
  private opponentX = 0;
  private playerLateralSpeed = 0;
  private swingAnimT = 1;
  private opponentSwingT = 1;
  private opponentHitPlan: OpponentHitPlan | null = null;
  private wallToSimulationOffsetMs = 0;
  private lastSimulationTimeMs = Number.NEGATIVE_INFINITY;
  private lastWallTimeMs = Number.NEGATIVE_INFINITY;
  private pauseBoundaryWallTimeMs = Number.NEGATIVE_INFINITY;
  private opponentAi: OpponentAiState = createOpponentAi();
  private status = 'Espaço ou raquetada para sacar';
  private feedback: { id: number; text: string; tone: 'good' | 'bad' | 'neutral' } | undefined;
  private feedbackCounter = 0;
  private lastHitInfo = '';
  private pointsWon = 0;
  private pointsLost = 0;
  private readonly rally = new RallyTracker();
  private bestRally = 0;
  private matchRecorded = false;
  private matchGeneration = 0;
  private matchSummary = '';
  private readonly missionCompletion = new MissionCompletionCache();
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly onHud: (state: GameHudState) => void,
    private readonly audio?: ProceduralAudio,
  ) {
    this.scene.background = new THREE.Color(0x17251d);
    this.scene.fog = new THREE.Fog(0x17251d, 24, 60);
    this.camera.position.set(0, 7.5, 14.5);
    this.camera.lookAt(0, 1, -3);
    this.scene.add(new THREE.HemisphereLight(0xe3f4d5, 0x1a2c1e, 2));
    const sun = new THREE.DirectionalLight(0xffefc4, 3);
    sun.position.set(-5, 9, 8);
    this.scene.add(sun);

    const court = new THREE.Mesh(new THREE.PlaneGeometry(9.4, 22), new THREE.MeshStandardMaterial({ color: 0x246c55, roughness: 0.8 }));
    court.rotation.x = -Math.PI / 2;
    this.scene.add(court);
    const surround = new THREE.Mesh(new THREE.PlaneGeometry(40, 60), new THREE.MeshStandardMaterial({ color: 0x1c4a3c, roughness: 1 }));
    surround.rotation.x = -Math.PI / 2;
    surround.position.y = -0.02;
    this.scene.add(surround);

    const lineMat = new THREE.MeshBasicMaterial({ color: 0xe8ebd7 });
    const addLine = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), lineMat);
      m.position.set(x, 0.015, z);
      this.scene.add(m);
    };
    for (const z of [-BASELINE_Z, BASELINE_Z, -2.8, 2.8]) addLine(9.2, 0.07, 0, z);
    for (const x of [-4.55, 4.55, -3.45, 3.45]) addLine(0.07, 21, x, 0);
    addLine(0.07, 5.6, 0, 0);

    const net = new THREE.Mesh(new THREE.BoxGeometry(9.4, NET_HEIGHT, 0.1), new THREE.MeshStandardMaterial({ color: 0xdce4d7, roughness: 0.9, transparent: true, opacity: 0.85 }));
    net.position.set(0, NET_HEIGHT / 2, NET_Z);
    this.scene.add(net);

    this.playerMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1, 4, 8), new THREE.MeshStandardMaterial({ color: 0xf3a844, flatShading: true }));
    this.playerMesh.position.set(0, 0.85, PLAYER_HOME_Z);
    this.scene.add(this.playerMesh);
    this.opponentMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 0.9, 4, 8), new THREE.MeshStandardMaterial({ color: 0xe9eee5, flatShading: true }));
    this.opponentMesh.position.set(0, 0.8, OPPONENT_HOME_Z);
    this.scene.add(this.opponentMesh);

    this.playerRacket = this.makeRacket();
    this.playerRacket.position.set(0.45, 1.1, -0.25);
    this.playerMesh.add(this.playerRacket);
    this.opponentRacket = this.makeRacket();
    this.opponentRacket.position.set(0.42, 1.05, 0.25);
    this.opponentMesh.add(this.opponentRacket);

    this.scene.add(this.ballMesh);
    this.loop = new GameLoop(canvas, this.scene, this.camera, (dt, simulationTimeMs, wallTimeMs) => (
      this.update(dt, simulationTimeMs, wallTimeMs)
    ));
    this.hudTimer = window.setInterval(() => this.publishHud(), 200);
  }

  private makeRacket(): THREE.Group {
    const group = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.35, 6), new THREE.MeshStandardMaterial({ color: 0x5a4632 }));
    handle.position.y = 0.17;
    group.add(handle);
    const head = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.02, 6, 14), new THREE.MeshStandardMaterial({ color: 0xcf3d3d }));
    head.position.y = 0.45;
    group.add(head);
    return group;
  }

  // ---------------------------------------------------------------- input

  onAction(event: SportActionEvent): void {
    if (this.disposed) return;
    if (event.type === 'swing-start') {
      this.swingAnimT = 0;
      return;
    }
    if (event.type !== 'swing') return;
    this.resolveSwing({
      side: event.side,
      power01: event.power01,
      verticalSpeed: event.verticalSpeed ?? 0,
      contactY: event.contactY ?? 0,
      peakTimestampMs: event.peakTimestampMs ?? event.timestampMs,
    });
  }

  onKey(key: string): void {
    if (this.disposed) return;
    if (key !== ' ' && key !== 'Spacebar') return;
    this.swingAnimT = 0;
    this.resolveSwing({
      side: 'forehand',
      power01: 0.65,
      verticalSpeed: 0.6,
      contactY: 0,
      peakTimestampMs: nowMs(),
    });
  }

  // ---------------------------------------------------------------- swing resolution

  private resolveSwing(swing: { side: 'forehand' | 'backhand'; power01: number; verticalSpeed: number; contactY: number; peakTimestampMs: number }): void {
    const wallNow = nowMs();
    this.notePauseBoundary(wallNow);
    if (isBeforeOrAtPauseBoundary(swing.peakTimestampMs, this.pauseBoundaryWallTimeMs)) return;
    const now = Math.max(this.lastSimulationTimeMs, this.simulationTimestampAt(wallNow, wallNow));
    const simulationSwing = {
      ...swing,
      peakTimestampMs: Math.min(now, this.simulationTimestampAt(swing.peakTimestampMs, wallNow)),
    };

    if (this.phase.kind === 'player-serve') {
      this.resolveServe(simulationSwing, now, wallNow);
      return;
    }
    if (this.phase.kind !== 'rally' || !this.ball) return;

    const ballAtPeak = this.rewind(simulationSwing.peakTimestampMs);
    if (!ballAtPeak) return; // swing predates the current flight — nothing to adjudicate

    const outcome = adjudicateContact({
      ballAtPeak,
      playerX: this.playerX,
      movementPenalty01: Math.min(1, this.playerLateralSpeed / PLAYER_MOVE_SPEED),
      swing: simulationSwing,
    });
    this.applyPlayerOutcome(outcome, ballAtPeak, simulationSwing.peakTimestampMs, now, false, wallNow);
  }

  private resolveServe(
    swing: { side: 'forehand' | 'backhand'; power01: number; verticalSpeed: number; contactY: number; peakTimestampMs: number },
    now: number,
    wallNow: number,
  ): void {
    if (this.phase.kind !== 'player-serve' || !this.ball) return;
    const ballAtPeak = this.rewind(swing.peakTimestampMs) ?? this.ball;
    // Temporal override: the toss defines its own ideal instant (just past the apex), and the
    // generous reach matches the serve's high contact — the serve teaches the timing mechanic.
    const outcome = adjudicateContact({
      ballAtPeak,
      playerX: this.playerX + SERVE_CONTACT_X_OFFSET,
      movementPenalty01: 0,
      swing,
      timingErrorOverrideMs: swing.peakTimestampMs - this.phase.idealHitMs,
      geometry: { reachRadius: 2.2, playerZ: BASELINE_Z + 1, maxTimingMs: 320 },
    });
    this.applyPlayerOutcome(outcome, ballAtPeak, swing.peakTimestampMs, now, true, wallNow);
  }

  private applyPlayerOutcome(
    outcome: ContactOutcome,
    ballAtPeak: BallState,
    peakMs: number,
    now: number,
    isServe = false,
    wallNow = nowMs(),
  ): void {
    if (outcome.kind === 'ignore') return;
    if (outcome.kind === 'whiff') {
      const labels: Record<typeof outcome.reason, string> = {
        early: 'CEDO DEMAIS',
        late: 'TARDE DEMAIS',
        'out-of-reach': 'FORA DE ALCANCE',
        'dead-ball': 'BOLA MORTA',
      };
      this.setFeedback(labels[outcome.reason], 'bad');
      this.audio?.failure();
      return;
    }

    // Rewind + fast-forward: the new flight starts at the physical peak instant,
    // then advances to now — detection latency never enters the physics.
    const lagSec = Math.max(0, (now - peakMs) / 1000);
    const advancedShot = advancePlayerShotToNow(ballAtPeak, outcome.outgoing, lagSec, NET_HEIGHT);
    this.ball = advancedShot.ball;
    this.tape = [{ tMs: now, ball: this.ball }];
    this.lastSimulationTimeMs = Math.max(this.lastSimulationTimeMs, now);
    this.lastWallTimeMs = wallNow;
    this.wallToSimulationOffsetMs = now - wallNow;
    this.phase = { kind: 'rally' };
    this.opponentHitPlan = null;
    this.rally.recordHit();
    this.audio?.hit(0.4 + 0.6 * outcome.quality01);
    if (advancedShot.netFault) {
      this.endPoint('opponent', 'NA REDE!', now);
      return;
    }

    const spinLabel = outcome.spin > 0.4 ? ' · TOPSPIN' : outcome.spin < -0.4 ? ' · SLICE' : '';
    const dirLabel = outcome.direction === 'cross' ? 'CRUZADA' : outcome.direction === 'line' ? 'PARALELA' : 'CENTRO';
    this.lastHitInfo = `${outcome.timingErrorMs > 20 ? 'tarde' : outcome.timingErrorMs < -20 ? 'cedo' : 'no ponto'} ${Math.abs(Math.round(outcome.timingErrorMs))}ms`;
    if (outcome.smash) this.setFeedback('SMASH!', 'good');
    else if (outcome.quality01 > 0.85) this.setFeedback(isServe ? 'SAQUE PERFEITO' : 'NO PONTO!', 'good');
    this.status = `${dirLabel}${spinLabel} · ${this.lastHitInfo}`;
  }

  /** Ball state at the given timestamp, reconstructed from the tape of the current flight. */
  private rewind(tMs: number): BallState | null {
    if (this.tape.length === 0) return null;
    const first = this.tape[0]!;
    if (tMs < first.tMs - 40) return null; // before this flight even started
    let anchor = first;
    for (const entry of this.tape) {
      if (entry.tMs <= tMs) anchor = entry;
      else break;
    }
    return advanceBall(anchor.ball, Math.max(0, (tMs - anchor.tMs) / 1000));
  }

  private simulationTimestampAt(wallTimestampMs: number, observedWallTimestampMs: number): number {
    this.notePauseBoundary(observedWallTimestampMs);
    return mapWallTimestampToSimulationMs(
      wallTimestampMs,
      observedWallTimestampMs,
      this.wallToSimulationOffsetMs,
      this.lastSimulationTimeMs,
      this.lastWallTimeMs,
      MAX_FRAME_DELTA_SECONDS * 1000,
    );
  }

  // ---------------------------------------------------------------- update

  private update(fixedDt: number, now: number, wallNow: number): void {
    if (this.disposed) return;
    this.notePauseBoundary(wallNow);
    if (now < this.lastSimulationTimeMs) {
      // An input can land between fixed steps and advance the ball beyond this queued step.
      // Skip that stale step so the tape and physics clock stay ordered.
      this.render();
      return;
    }
    this.wallToSimulationOffsetMs = now - wallNow;
    this.lastWallTimeMs = wallNow;
    const dt = elapsedSimulationSeconds(this.lastSimulationTimeMs, now, fixedDt);
    this.lastSimulationTimeMs = now;
    this.stepPhase(dt, now);
    this.stepAvatars(dt);
    this.stepBall(dt, now);
    void this.updateMission();
    this.stepAnimations(dt);
    this.render();
  }

  private notePauseBoundary(wallNow: number): void {
    if (
      Number.isFinite(this.lastWallTimeMs)
      && wallNow - this.lastWallTimeMs > MAX_FRAME_DELTA_SECONDS * 1000
    ) {
      this.pauseBoundaryWallTimeMs = Math.max(this.pauseBoundaryWallTimeMs, this.lastWallTimeMs);
    }
  }

  private stepPhase(_dt: number, now: number): void {
    switch (this.phase.kind) {
      case 'point-over':
        if (now >= this.phase.resumeAtMs) this.startPoint(now);
        break;
      case 'match-over':
        if (now >= this.phase.restartAtMs) this.resetMatch(now);
        break;
      case 'player-serve': {
        // Toss missed and the ball came back down: re-toss quietly, no penalty.
        if (this.ball && this.ball.position.y <= 0.6 && this.ball.velocity.y < 0) {
          this.tossBall(now);
        }
        break;
      }
      case 'opponent-serve':
        if (now >= this.phase.hitAtMs && this.ball) {
          // The serve is not a return: always in, modest pace, slight lateral variety.
          const from = { x: this.opponentX * 0.5, y: 2.2, z: OPPONENT_HOME_Z - 0.6 };
          const targetX = (Math.random() * 2 - 1) * 1.6;
          const velocity = solveOutgoing(from, { x: targetX, z: 5.5 + Math.random() * 2.5 }, 1.05);
          this.ball = createBall(from, velocity, 'opponent');
          this.tape = [{ tMs: now, ball: this.ball }];
          this.opponentSwingT = 0;
          this.phase = { kind: 'rally' };
          this.rally.opponentServeStarted();
          this.audio?.hit(0.5);
          this.status = 'Saque do adversário — prepare-se';
        }
        break;
      case 'rally':
        break;
    }
  }

  private startPoint(now: number): void {
    this.playerX = 0;
    this.opponentX = 0;
    this.opponentHitPlan = null;
    if (this.score.server === 'player') {
      this.tossBall(now);
      this.status = 'Seu saque — raquetada no ápice!';
    } else {
      this.ball = createBall({ x: 0, y: 2.2, z: OPPONENT_HOME_Z - 0.6 }, { x: 0, y: 0, z: 0 }, 'opponent');
      this.tape = [{ tMs: now, ball: this.ball }];
      this.phase = { kind: 'opponent-serve', hitAtMs: now + 900 };
      this.status = 'Saque do adversário…';
    }
  }

  private tossBall(now: number): void {
    const from = { x: this.playerX + SERVE_CONTACT_X_OFFSET, y: 1.4, z: PLAYER_HOME_Z };
    this.ball = createBall(from, { x: 0, y: TOSS_VY, z: 0 }, 'player');
    this.tape = [{ tMs: now, ball: this.ball }];
    const apexSec = TOSS_VY / 9.8;
    // Ideal contact slightly past the apex on the way down — classic serve timing.
    this.phase = { kind: 'player-serve', tossTimeMs: now, idealHitMs: now + (apexSec + 0.12) * 1000 };
  }

  private stepBall(dt: number, now: number): void {
    // Ball physics runs in rally and during the serve toss; everything else is paused.
    if ((this.phase.kind !== 'rally' && this.phase.kind !== 'player-serve') || !this.ball) return;

    const before = this.ball;
    const after = advanceBall(before, dt);
    this.ball = after;
    this.tape.push({ tMs: now, ball: after });
    while (this.tape.length > 0 && this.tape[0]!.tMs < now - TAPE_WINDOW_MS) this.tape.shift();

    if (this.phase.kind !== 'rally') return;

    // Net: crossing the plane below the cord kills the ball — hitter loses.
    if (crossesNetBelowCord(before, after, dt, NET_HEIGHT)) {
      this.endPoint(before.lastHitter === 'player' ? 'opponent' : 'player', 'NA REDE!', now);
      return;
    }

    // Bounce adjudication in the receiver's half.
    if (after.bounces > before.bounces) {
      const receiver: PlayerSide = after.lastHitter === 'player' ? 'opponent' : 'player';
      const inCourt = Math.abs(after.position.x) <= COURT_HALF_WIDTH + 0.35 && Math.abs(after.position.z) <= BASELINE_Z + 0.35;
      if (after.bounces === 1) {
        if (!inCourt) {
          this.endPoint(receiver, 'FORA!', now);
          return;
        }
        this.audio?.bounce(0.35);
      } else if (after.bounces >= 2) {
        this.endPoint(after.lastHitter, receiver === 'player' ? 'PONTO DO ADVERSÁRIO' : 'PONTO!', now);
        return;
      }
    }

    // Safety valve: ball escaped the world or came to rest undecided.
    if (Math.abs(after.position.z) > 15 || Math.abs(after.position.x) > 8 || (after.velocity.x === 0 && after.velocity.y === 0 && after.velocity.z === 0)) {
      const receiver: PlayerSide = after.lastHitter === 'player' ? 'opponent' : 'player';
      this.endPoint(receiver, 'FORA!', now);
      return;
    }

    this.stepOpponentPlan(now);
  }

  private stepOpponentPlan(now: number): void {
    if (!this.ball) return;
    if (this.ball.lastHitter !== 'player' || this.ball.velocity.z >= 0) {
      this.opponentHitPlan = null;
      return;
    }
    if (!this.opponentHitPlan) {
      const crossing = timeAtPlane(this.ball, OPPONENT_CONTACT_PLANE_Z);
      if (!crossing) return;
      this.opponentHitPlan = {
        hitAtMs: now + crossing.timeSeconds * 1000,
        contactAfterSeconds: crossing.timeSeconds,
        fromBall: this.ball,
      };
    }

    if (now >= this.opponentHitPlan.hitAtMs) {
      const plan = this.opponentHitPlan;
      const contactBall = ballAtPlannedContact(plan);
      const decision = decideReturn(this.opponentAi, this.pressureOnOpponent(contactBall), Math.random);
      this.opponentHitPlan = null;
      if (decision.kind === 'no-return') return; // ball plays on — the bounce rules score the point
      this.ball = resolveScheduledOpponentReturn(
        plan,
        now,
        { x: decision.targetX, z: decision.targetZ },
        decision.flightTimeSeconds,
      );
      this.tape = [{ tMs: now, ball: this.ball }];
      this.opponentSwingT = 0;
      this.rally.recordHit();
      this.audio?.hit(0.45);
    }
  }

  /** How much the player's last shot pressures the opponent — pace and width raise faults. */
  private pressureOnOpponent(ball = this.ball): number {
    if (!ball) return 0;
    const speed = Math.hypot(ball.velocity.x, ball.velocity.z);
    const width = Math.abs(ball.position.x) / COURT_HALF_WIDTH;
    return Math.min(1, Math.max(0, (speed - 10) / 12) * 0.7 + width * 0.3);
  }

  private endPoint(winner: PlayerSide, headline: string, now = nowMs()): void {
    const result = awardPoint(this.score, winner);
    this.score = result.state;
    this.opponentAi = adaptOpponentSkill(this.opponentAi, winner);
    this.opponentHitPlan = null;
    if (winner === 'player') this.pointsWon += 1;
    else this.pointsLost += 1;
    const rally = this.rally.finishPoint();
    this.bestRally = Math.max(this.bestRally, rally);

    const youWon = winner === 'player';
    this.setFeedback(headline, youWon ? 'good' : 'bad');
    if (result.matchWonBy) {
      const matchGeneration = this.matchGeneration;
      const completion = this.finishMatch(result.matchWonBy);
      this.phase = { kind: 'match-over', restartAtMs: now + MATCH_PAUSE_S * 1000 };
      this.status = result.matchWonBy === 'player' ? 'VOCÊ VENCEU A PARTIDA!' : 'Adversário venceu a partida';
      // A mission completed by the last point is acknowledged first; the match achievement
      // then takes priority in the single feedback slot.
      const missionCompletion = this.updateMission();
      const finishMatchFeedback = (
        matchCompletion: Awaited<ReturnType<TennisGame['finishMatch']>>,
        missionJustCompleted: boolean,
      ) => {
        if (this.disposed || matchGeneration !== this.matchGeneration) return;
        if (matchCompletion?.record.rankUp) this.setFeedback(`RANK ${matchCompletion.record.after.rank}!`, 'good');
        else if (matchCompletion?.record.isRecord) this.setFeedback('NOVO RECORDE!', 'good');
        else if (!missionJustCompleted) {
          this.setFeedback(
            result.matchWonBy === 'player' ? 'VITÓRIA!' : 'FIM DE PARTIDA',
            result.matchWonBy === 'player' ? 'good' : 'bad',
          );
          this.audio?.milestone();
        }
      };
      const missionClaim = missionCompletion === false ? Promise.resolve(false) : missionCompletion;
      void Promise.all([completion ?? Promise.resolve(undefined), missionClaim]).then(
        ([matchCompletion, missionJustCompleted]) => finishMatchFeedback(matchCompletion, missionJustCompleted),
      );
    } else if (result.gameWonBy) {
      this.phase = { kind: 'point-over', resumeAtMs: now + POINT_PAUSE_S * 1500 };
      this.status = `${result.gameWonBy === 'player' ? 'GAME SEU!' : 'Game do adversário'} · rally ${rally}`;
      this.audio?.milestone();
    } else {
      this.phase = { kind: 'point-over', resumeAtMs: now + POINT_PAUSE_S * 1000 };
      this.status = `${youWon ? 'Ponto seu!' : 'Ponto do adversário'} · rally ${rally}`;
      if (youWon) this.audio?.success(1);
      else this.audio?.failure();
    }
    this.ball = null;
    this.tape = [];
  }

  private livePerformanceScore(): number {
    return matchPerformance({
      pointsWon: this.pointsWon,
      gamesWon: this.score.games.player,
      won: this.score.matchWinner === 'player',
      bestRally: Math.max(this.bestRally, this.rally.current),
    });
  }

  private currentMissionValue(): number {
    return tennisMissionValue(this.missionSession.mission.metric, {
      performance: this.livePerformanceScore(),
      bestRally: Math.max(this.bestRally, this.rally.current),
      won: this.score.matchWinner === 'player',
    });
  }

  private updateMission(): false | Promise<boolean> {
    const matchGeneration = this.matchGeneration;
    return this.missionCompletion.run(this.missionSession.completionKey, () => {
      const completion = this.missionSession.tracker.update(this.currentMissionValue());
      if (completion === false) return false;
      let rankUp = '';
      return applyMissionReward(
        completion,
        async () => {
          const reward = await this.progressStore.addXp('tennis', MISSION_XP);
          this.progress = this.progressStore.load('tennis');
          rankUp = reward.rankUp ? ` · RANK ${reward.after.rank}!` : '';
        },
        () => {
          this.setFeedback(`MISSÃO +${MISSION_XP} XP${rankUp}`, 'good');
          this.audio?.milestone();
        },
        () => !this.disposed && matchGeneration === this.matchGeneration,
      );
    });
  }

  private finishMatch(winner: PlayerSide): Promise<{ performanceScore: number; xpEarned: number; record: ProgressRecordResult } | undefined> | undefined {
    if (this.matchRecorded) return undefined;
    this.matchRecorded = true;
    const performanceScore = matchPerformance({
      pointsWon: this.pointsWon,
      gamesWon: this.score.games.player,
      won: winner === 'player',
      bestRally: this.bestRally,
    });
    const xpEarned = matchXp(performanceScore);
    const pointsWon = this.pointsWon;
    const pointsLost = this.pointsLost;
    const bestRally = this.bestRally;
    const matchGeneration = this.matchGeneration;
    return this.progressStore.record('tennis', performanceScore, xpEarned).then((record) => {
      this.progress = this.progressStore.load('tennis');
      const achievement = record.rankUp ? ` · RANK ${record.after.rank}` : record.isRecord ? ' · NOVO RECORDE' : '';
      if (matchGeneration === this.matchGeneration) {
        this.matchSummary = `DESEMPENHO ${performanceScore} · PONTOS ${pointsWon}×${pointsLost} · MELHOR RALLY ${bestRally} · +${xpEarned} XP${achievement}`;
      }
      return { performanceScore, xpEarned, record };
    });
  }

  private resetMatch(now: number): void {
    this.matchGeneration += 1;
    this.score = createScore('player');
    this.opponentAi = createOpponentAi();
    this.pointsWon = 0;
    this.pointsLost = 0;
    this.rally.reset();
    this.bestRally = 0;
    this.matchRecorded = false;
    this.matchSummary = '';
    this.lastHitInfo = '';
    this.playerX = 0;
    this.opponentX = 0;
    this.playerLateralSpeed = 0;
    this.ball = null;
    this.tape = [];
    this.opponentHitPlan = null;
    this.missionSession.startAttempt(localDateIso(new Date()));
    this.missionCompletion.clear();
    this.startPoint(now);
  }

  private stepAvatars(dt: number): void {
    // Auto-movement like the Miis: glide toward the incoming ball's lateral position.
    let targetX = 0;
    if (this.ball && this.ball.velocity.z > 0.5 && this.ball.position.z < PLAYER_HOME_Z + 2) {
      targetX = Math.max(-2.8, Math.min(2.8, this.ball.position.x));
    }
    const before = this.playerX;
    const delta = targetX - this.playerX;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), PLAYER_MOVE_SPEED * dt);
    this.playerX += step;
    this.playerLateralSpeed = Math.abs(this.playerX - before) / Math.max(dt, 1e-6);

    let oppTarget = 0;
    if (this.ball && this.ball.velocity.z < -0.5) {
      oppTarget = Math.max(-2.5, Math.min(2.5, this.ball.position.x));
    }
    const oppDelta = oppTarget - this.opponentX;
    const oppSpeed = 2.5 + this.opponentAi.skill * 3.5;
    this.opponentX += Math.sign(oppDelta) * Math.min(Math.abs(oppDelta), oppSpeed * dt);
  }

  private stepAnimations(dt: number): void {
    this.swingAnimT = Math.min(1, this.swingAnimT + dt / 0.28);
    this.opponentSwingT = Math.min(1, this.opponentSwingT + dt / 0.28);
  }

  private render(): void {
    if (this.ball) {
      this.ballMesh.visible = true;
      this.ballMesh.position.set(this.ball.position.x, Math.max(0.18, this.ball.position.y), this.ball.position.z);
    } else {
      this.ballMesh.visible = false;
    }
    this.playerMesh.position.x = this.playerX;
    this.opponentMesh.position.x = this.opponentX;

    // Swing tween: a fast outward sweep that settles back — driven by swing-start, not confirmation.
    const sweep = Math.sin(Math.min(1, this.swingAnimT) * Math.PI);
    this.playerRacket.rotation.z = -sweep * 1.9;
    this.playerRacket.rotation.x = sweep * 0.6;
    const oppSweep = Math.sin(Math.min(1, this.opponentSwingT) * Math.PI);
    this.opponentRacket.rotation.z = -oppSweep * 1.9;
  }

  // ---------------------------------------------------------------- hud & lifecycle

  private setFeedback(text: string, tone: 'good' | 'bad' | 'neutral'): void {
    if (this.disposed) return;
    this.feedbackCounter += 1;
    this.feedback = { id: this.feedbackCounter, text, tone };
  }

  private publishHud(): void {
    if (this.disposed) return;
    const labels = pointLabels(this.score);
    const livePerformance = this.livePerformanceScore();
    const rank = progressionFor(this.progress.xp);
    const server = this.score.server === 'player' ? 'SAQUE SEU' : 'SAQUE DO ADVERSÁRIO';
    const timing = this.lastHitInfo ? `${this.lastHitInfo} · ` : '';
    const gap = this.progress.bestScore - livePerformance;
    const chase = this.progress.bestScore > 0
      ? gap >= 0
        ? ` · FALTAM ${gap + 1} P/ RECORDE`
        : ' · RITMO DE RECORDE'
      : '';
    const liveDetail = `${timing}${server} · ADV ${Math.round(this.opponentAi.skill * 100)}%${chase}`;
    this.onHud({
      score: livePerformance,
      label: `${labels.player} × ${labels.opponent}`,
      speed01: 0,
      status: this.status,
      metricLabel: 'GAMES',
      metricValue: `${this.score.games.player} × ${this.score.games.opponent}`,
      bestLabel: `RECORDE ${this.progress.bestScore}`,
      rankLabel: `RANK ${rank.rank} · ${rank.xp} XP`,
      rankProgress01: rank.progress01,
      missionLabel: this.missionSession.tracker.label(),
      missionProgress01: this.missionSession.tracker.progress01(),
      detail: this.phase.kind === 'match-over' && this.matchSummary ? this.matchSummary : liveDetail,
      feedback: this.feedback,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearInterval(this.hudTimer);
    this.loop.dispose();
  }
}
