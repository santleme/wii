import type { CalibrationProfile, PoseSnapshot } from '@wii/spatial-core';
import { BodyFeatureExtractor, type CanonicalBodyFeatures } from './bodyFeatures';
import { clamp } from './math';

export type ActivityKind = 'idle' | 'running' | 'swinging' | 'striking';

export interface ContextScores {
  idle: number;
  running: number;
  swinging: number;
  striking: number;
}

export interface ContextDecision {
  /** Current committed activity; stays stable until a challenger sustains a winning score. */
  activity: ActivityKind;
  /** Best score times twice the best-vs-runner-up margin, clamped; 0 while there is too little evidence. */
  confidence01: number;
  /** How long the committed activity has held, in ms. */
  stableForMs: number;
  /** Raw per-activity scores for the current window, exposed for tuning and inspection. */
  scores: ContextScores;
}

/** Windowed statistics extracted from the recent feature stream — the "context signature". */
export interface ContextSignature {
  /** Alternating knee-lift crossings per minute over the window; 0 without a clear oscillation. */
  stepsPerMin: number;
  /** Regularity of step intervals, 0–1 (1 = metronome). */
  stepCoherence01: number;
  /** Count of wrist bursts dominated by lateral motion (racket-like arcs). */
  lateralBursts: number;
  /** Count of wrist bursts dominated by depth motion (punch-like thrusts). */
  forwardBursts: number;
  /** Peak wrist speed across the window, shoulder-widths/s. */
  peakWristSpeed: number;
  /** Fraction of frames with both fists above the shoulder line (guard stance). */
  guardRatio: number;
  /** Mean gross motion level: wrist speeds + step rate. */
  motionEnergy: number;
}

export interface ContextClassifierOptions {
  /** Sliding window length in wall-clock ms; evidence older than this is evicted. */
  windowMs?: number;
  /** Hard cap on buffered frames — memory bound only, not the window definition. */
  maxFrames?: number;
  /** Minimum window span before any non-idle decision is allowed. */
  minWindowMs?: number;
  /** Consecutive evaluations a challenger must win before switching. */
  confirmEvals?: number;
  /** …and it must keep winning for at least this long (ms). */
  dwellMs?: number;
  /** Best score required to take the lead. */
  enterScore?: number;
  /** Best-vs-runner-up gap required to take the lead. */
  enterMargin?: number;
  /** How long untracked input is tolerated before falling back to idle. */
  lostDecayMs?: number;
}

const DEFAULT_WINDOW_MS = 1600;
const DEFAULT_MAX_FRAMES = 96;
const EVIDENCE_GAP_MS = 500;
const DEFAULT_MIN_WINDOW_MS = 500;
const DEFAULT_CONFIRM_EVALS = 3;
const DEFAULT_DWELL_MS = 700;
const DEFAULT_ENTER_SCORE = 0.5;
const DEFAULT_ENTER_MARGIN = 0.15;
const DEFAULT_LOST_DECAY_MS = 900;

const STEP_MIN_AMPLITUDE = 0.15;
const BURST_ON_SPEED = 1.6;
const BURST_OFF_SPEED = 1.2;
const BURST_MIN_PEAK = 3;
const DIRECTION_DOMINANCE = 0.45;
const GUARD_HEIGHT = 0.35;
const RUNNING_MIN_SPM = 90;
const RUNNING_FULL_SPM = 150;
const IDLE_ENERGY_FULL = 1.2;

interface Burst {
  active: boolean;
  peakSpeed: number;
  peakLateralRatio: number;
  peakForwardRatio: number;
}

function hypot3(v: { x: number; y: number; z: number }): number {
  return Math.hypot(v.x, v.y, v.z);
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

function range(values: readonly number[]): number {
  if (!values.length) return 0;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}

/**
 * Slow-path context router: observes the canonical body-feature stream and reports which gross
 * activity the player is performing. Detection is deliberately decoupled from control — the
 * committed activity only changes after a challenger wins several evaluations across a dwell
 * window, so bursts and tracking hiccups never flip the context mid-action.
 */
export class ContextClassifier {
  private readonly extractor = new BodyFeatureExtractor();
  private readonly options: Required<ContextClassifierOptions>;
  private frames: CanonicalBodyFeatures[] = [];
  private current: ActivityKind = 'idle';
  private challenger?: { kind: ActivityKind; evals: number; sinceMs: number };
  private lastSwitchAt?: number;
  private lastTrackedAt?: number;

  constructor(options: ContextClassifierOptions = {}) {
    this.options = {
      windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
      maxFrames: options.maxFrames ?? DEFAULT_MAX_FRAMES,
      minWindowMs: options.minWindowMs ?? DEFAULT_MIN_WINDOW_MS,
      confirmEvals: options.confirmEvals ?? DEFAULT_CONFIRM_EVALS,
      dwellMs: options.dwellMs ?? DEFAULT_DWELL_MS,
      enterScore: options.enterScore ?? DEFAULT_ENTER_SCORE,
      enterMargin: options.enterMargin ?? DEFAULT_ENTER_MARGIN,
      lostDecayMs: options.lostDecayMs ?? DEFAULT_LOST_DECAY_MS,
    };
  }

  update(snapshot: PoseSnapshot, calibration?: CalibrationProfile): ContextDecision {
    const now = snapshot.timestampMs;
    if (this.lastSwitchAt === undefined) this.lastSwitchAt = now;
    let evidenceAdded = false;
    if (snapshot.trackingState === 'tracked') {
      const features = this.extractor.extract(snapshot, calibration);
      if (features) {
        const last = this.frames[this.frames.length - 1];
        // A silent capture gap (stall, throttle) invalidates what came before it: pre- and
        // post-gap motion must never blend into one signature, nor may dead time serve as dwell.
        if (last !== undefined && now - last.timestampMs > EVIDENCE_GAP_MS) this.frames = [];
        this.frames.push(features);
        while (this.frames.length > 0 && now - this.frames[0]!.timestampMs > this.options.windowMs) this.frames.shift();
        if (this.frames.length > this.options.maxFrames) this.frames.shift();
        this.lastTrackedAt = now;
        evidenceAdded = true;
      }
    } else if (this.lastTrackedAt !== undefined && now - this.lastTrackedAt > this.options.lostDecayMs) {
      // Tracking gone long enough that the player state is genuinely unknown: reset to the
      // safe default through the control path rather than letting the frozen window re-score.
      this.frames = [];
      this.challenger = undefined;
      this.current = 'idle';
      this.lastSwitchAt = now;
    }

    const signature = this.signature();
    const scores = signature ? this.score(signature) : { idle: 0, running: 0, swinging: 0, striking: 0 };
    const winner = this.pickWinner(scores);
    const margin = winner ? winner.score - this.runnerUpScore(scores, winner.kind) : 0;

    if (!evidenceAdded) {
      // Frames without new evidence (lost/degraded/extraction failure) must not advance a
      // challenge: re-evaluating the frozen window would count the same evidence many times.
    } else if (
      winner &&
      winner.kind !== this.current &&
      winner.score >= this.options.enterScore &&
      margin >= this.options.enterMargin
    ) {
      if (this.challenger?.kind === winner.kind) this.challenger.evals += 1;
      else this.challenger = { kind: winner.kind, evals: 1, sinceMs: now };
      if (this.challenger.evals >= this.options.confirmEvals && now - this.challenger.sinceMs >= this.options.dwellMs) {
        this.current = winner.kind;
        this.challenger = undefined;
        this.lastSwitchAt = now;
      }
    } else {
      // No qualifying challenger (same winner, weak score, or no data): any pending challenge lapses.
      this.challenger = undefined;
    }

    const confidence01 =
      signature === undefined ||
      this.lastTrackedAt === undefined ||
      now - this.lastTrackedAt > this.options.lostDecayMs
        ? 0
        : winner
          ? clamp(winner.score) * clamp(margin * 2)
          : 0;

    return {
      activity: this.current,
      confidence01,
      stableForMs: this.lastSwitchAt === undefined ? 0 : now - this.lastSwitchAt,
      scores,
    };
  }

  reset(): void {
    this.extractor.reset();
    this.frames = [];
    this.current = 'idle';
    this.challenger = undefined;
    this.lastSwitchAt = undefined;
    this.lastTrackedAt = undefined;
  }

  private pickWinner(scores: ContextScores): { kind: ActivityKind; score: number } | undefined {
    let winner: { kind: ActivityKind; score: number } | undefined;
    for (const kind of ['idle', 'running', 'swinging', 'striking'] as const) {
      if (!winner || scores[kind] > winner.score) winner = { kind, score: scores[kind] };
    }
    return winner;
  }

  private runnerUpScore(scores: ContextScores, best: ActivityKind): number {
    let second = 0;
    for (const kind of ['idle', 'running', 'swinging', 'striking'] as const) {
      if (kind !== best && scores[kind] > second) second = scores[kind];
    }
    return second;
  }

  private signature(): ContextSignature | undefined {
    const frames = this.frames;
    if (frames.length < 8) return undefined;
    const spanMs = frames[frames.length - 1]!.timestampMs - frames[0]!.timestampMs;
    if (spanMs < this.options.minWindowMs) return undefined;
    const windowSec = spanMs / 1000;

    // Frames without both knees measurable carry no step evidence at all — an occluded knee is
    // NaN, never zero — so they are excluded rather than read as phantom leg motion.
    const kneeFrames = frames.filter((f) => Number.isFinite(f.kneeLiftLeft) && Number.isFinite(f.kneeLiftRight));
    const kneeDeltas = kneeFrames.map((f) => f.kneeLiftLeft - f.kneeLiftRight);
    const stepMean = mean(kneeDeltas);
    const stepAmplitude = range(kneeDeltas) / 2;
    const { stepsPerMin, coherence } = this.stepRate(kneeDeltas, stepMean, stepAmplitude, windowSec, kneeFrames);

    const bursts = this.wristBursts(frames);
    const guardRatio =
      frames.filter((f) => f.wristHeightLeft > GUARD_HEIGHT && f.wristHeightRight > GUARD_HEIGHT).length /
      frames.length;

    const meanWristSpeed = mean(frames.map((f) => hypot3(f.wristVelocityLeft) + hypot3(f.wristVelocityRight)));
    const motionEnergy = meanWristSpeed + stepsPerMin / 180;

    return {
      stepsPerMin,
      stepCoherence01: coherence,
      lateralBursts: bursts.lateral,
      forwardBursts: bursts.forward,
      peakWristSpeed: bursts.peakSpeed,
      guardRatio,
      motionEnergy,
    };
  }

  /**
   * Alternating knee lifts appear as sign changes of (liftL − liftR) around its window mean.
   * Crossings count only after the signal leaves a deadband around the mean, and coherence is
   * one minus the coefficient of variation of the inter-crossing intervals.
   */
  private stepRate(
    deltas: readonly number[],
    mu: number,
    amplitude: number,
    windowSec: number,
    frames: readonly CanonicalBodyFeatures[],
  ): { stepsPerMin: number; coherence: number } {
    if (frames.length < 8) return { stepsPerMin: 0, coherence: 0 };
    if (amplitude < STEP_MIN_AMPLITUDE) return { stepsPerMin: 0, coherence: 0 };
    const band = Math.max(amplitude * 0.4, STEP_MIN_AMPLITUDE * 0.5);
    const crossings: number[] = [];
    let side = 0;
    for (let i = 0; i < deltas.length; i += 1) {
      const centered = deltas[i]! - mu;
      const nextSide = centered > band ? 1 : centered < -band ? -1 : side;
      if (nextSide !== 0 && side !== 0 && nextSide !== side) crossings.push(frames[i]!.timestampMs);
      if (nextSide !== 0) side = nextSide;
    }
    if (crossings.length < 3) return { stepsPerMin: 0, coherence: 0 };
    const stepsPerMin = (crossings.length / windowSec) * 60;
    const intervals = crossings.slice(1).map((t, i) => t - crossings[i]!);
    const intervalMean = mean(intervals);
    if (intervalMean <= 0) return { stepsPerMin: 0, coherence: 0 };
    const variance = mean(intervals.map((i) => (i - intervalMean) ** 2));
    const cv = Math.sqrt(variance) / intervalMean;
    return { stepsPerMin, coherence: clamp(1 - cv) };
  }

  /**
   * A wrist burst is a contiguous run above BURST_ON_SPEED whose peak clears BURST_MIN_PEAK —
   * high enough that rhythmic arm pumping while running does not register. The burst is lateral
   * (racket arc) or forward (punch) by which axis dominates the velocity at the peak frame.
   */
  private wristBursts(frames: readonly CanonicalBodyFeatures[]): { lateral: number; forward: number; peakSpeed: number } {
    const open: Burst = { active: false, peakSpeed: 0, peakLateralRatio: 0, peakForwardRatio: 0 };
    const burst: Burst = { ...open };
    let lateral = 0;
    let forward = 0;
    let peakSpeed = 0;
    const close = () => {
      if (burst.active && burst.peakSpeed >= BURST_MIN_PEAK) {
        // Classify by the strictly dominant axis; diagonal bursts where neither direction
        // clearly wins stay unclassified instead of being decided by check order.
        const { peakLateralRatio: lat, peakForwardRatio: fwd } = burst;
        if (lat >= DIRECTION_DOMINANCE && lat > fwd) lateral += 1;
        else if (fwd >= DIRECTION_DOMINANCE && fwd > lat) forward += 1;
      }
      Object.assign(burst, open);
    };
    for (const f of frames) {
      const left = hypot3(f.wristVelocityLeft);
      const right = hypot3(f.wristVelocityRight);
      const speed = Math.max(left, right);
      const v = left >= right ? f.wristVelocityLeft : f.wristVelocityRight;
      if (speed > peakSpeed) peakSpeed = speed;
      if (speed < BURST_OFF_SPEED) {
        if (burst.active) close();
        continue;
      }
      if (speed < BURST_ON_SPEED && !burst.active) continue;
      burst.active = true;
      if (speed > burst.peakSpeed) {
        burst.peakSpeed = speed;
        burst.peakLateralRatio = Math.abs(v.x) / speed;
        burst.peakForwardRatio = Math.abs(v.z) / speed;
      }
    }
    close();
    return { lateral, forward, peakSpeed };
  }

  private score(s: ContextSignature): ContextScores {
    // Running rests on the step signature alone: penalizing it for wrist bursts made the common
    // case — running with natural arm pump — undetectable, while pure swinging/striking produce
    // no coherent knee alternation and lose the margin competition on their own.
    const running =
      clamp((s.stepsPerMin - RUNNING_MIN_SPM) / (RUNNING_FULL_SPM - RUNNING_MIN_SPM)) *
      (0.4 + 0.6 * s.stepCoherence01);
    // Dividing by three keeps a single isolated burst below enterScore: one burst is 0.33,
    // so committing takes repeated events rather than one event lingering in the window.
    const swinging = clamp(s.lateralBursts / 3);
    const striking = clamp(s.forwardBursts / 3) * (0.3 + 0.7 * s.guardRatio);
    const idle = clamp(1 - s.motionEnergy / IDLE_ENERGY_FULL);
    return { idle, running, swinging, striking };
  }
}
