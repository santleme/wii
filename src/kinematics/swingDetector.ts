import type { Hand, PoseSnapshot } from '@wii/spatial-core';
import { clamp, landmarkConfidence } from './math';

export interface SwingSignal {
  side: 'forehand' | 'backhand';
  power01: number;
  confidence: number;
  peakTimestampMs: number;
  /** Frame where the onset threshold was crossed — the stroke's physical start. */
  onsetTimestampMs: number;
  /** Expected finish height of the stroke relative to the shoulders, in shoulder widths, up positive. */
  contactY: number;
  /** Vertical wrist speed at the peak in shoulder widths/s, up positive — topspin/slice proxy. */
  verticalSpeed: number;
  /** How far the wrist travelled, in shoulder widths — the size of this player's stroke. */
  travel: number;
}

/**
 * What one detector update yields. `onset` is the real-time, unconfirmed notice emitted on the
 * frame the wrist crosses the onset threshold — backswings and aborted strokes fire it too, so it
 * serves animation, never adjudication. `confirmed` is the measured stroke, emitted after the
 * follow-through proves it, carrying the peak-frame measurements.
 */
export type SwingOutput =
  | { kind: 'onset'; timestampMs: number; side: 'forehand' | 'backhand' }
  | ({ kind: 'confirmed' } & SwingSignal);

/*
 * A stroke is the wrist travelling far in very little time, mostly sideways or sideways and up.
 * Measured in the image against the shoulder midpoint, in shoulder widths. Two recordings of one
 * player: exaggerated arm sweeps, and the compact low-to-chest stroke used while actually playing,
 * which covers too little sideways distance to count without its rise. Downward motion does not
 * count: that is the arm settling back.
 */
const STROKE_TRAVEL = 1.9;
/** The arm keeps rising after the stroke is recognised: finish height ≈ height + rise speed × this. */
const FOLLOW_THROUGH_S = 0.04;
const MAX_FOLLOW_THROUGH = 0.8;
const MIN_SIDEWAYS_TRAVEL = 0.8;
const STROKE_WINDOW_MS = 270;
/** After a stroke, the arm coming back the other way is not a second stroke. */
const RETURN_IGNORE_MS = 800;
const REFRACTORY_MS = 400;
/** Twisting the trunk collapses the apparent shoulder width, so the ruler only shrinks slowly. */
const RULER_HALF_LIFE_MS = 3000;
const MIN_WRIST_CONFIDENCE = 0.5;
const FULL_POWER_SPEED = 22;
const MIN_POWER_SPEED = 4;
export const SWING_MAX_DURATION_MS = 300;

interface Sample { x: number; y: number; time: number }

interface PendingSwing {
  direction: -1 | 1;
  startedAt: number;
  peak: { time: number; speed: number; verticalSpeed: number; y: number; confidence: number };
  /** Fastest sideways-and-up speed seen: the power of the stroke. */
  force: number;
  reach: number;
}

export class SwingDetector {
  constructor(private readonly hand: Hand) {}

  private samples: Sample[] = [];
  private ruler?: { width: number; time: number };
  private pending?: PendingSwing;
  /** Shortest travel that counts as a stroke; the tennis warm-up adapts it to the player. */
  minTravel = STROKE_TRAVEL;
  private last?: { direction: -1 | 1; time: number };

  update(snapshot: PoseSnapshot): SwingOutput | undefined {
    const time = snapshot.timestampMs;
    const wrist = snapshot.landmarks[this.hand === 'right' ? 16 : 15];
    const left = snapshot.landmarks[11];
    const right = snapshot.landmarks[12];
    const previous = this.samples.at(-1);
    // A hole in the samples says nothing about how fast the wrist moved across it.
    if (previous && time - previous.time > STROKE_WINDOW_MS) this.forget();
    // One blurred frame in the middle of a stroke is skipped, not a reason to drop the stroke; a real
    // hole is caught above by its length.
    const worldWrist = snapshot.worldLandmarks[this.hand === 'right' ? 16 : 15];
    if (!wrist || !left || !right || !worldWrist || landmarkConfidence(wrist, worldWrist) < MIN_WRIST_CONFIDENCE) return undefined;
    const aspect = snapshot.frameHeight && snapshot.frameWidth ? snapshot.frameHeight / snapshot.frameWidth : 0.75;
    const apparent = Math.hypot(left.x - right.x, (left.y - right.y) * aspect);
    const faded = this.ruler ? this.ruler.width * 0.5 ** ((time - this.ruler.time) / RULER_HALF_LIFE_MS) : 0;
    const width = Math.max(apparent, faded);
    if (width <= 0) return undefined;
    this.ruler = { width, time };
    const sample = {
      x: (wrist.x - (left.x + right.x) / 2) / width,
      // Up positive.
      y: -((wrist.y - (left.y + right.y) / 2) * aspect) / width,
      time,
    };
    const before = this.samples.at(-1);
    this.samples = [...this.samples.filter((kept) => time - kept.time <= STROKE_WINDOW_MS), sample];
    if (!before) return undefined;
    const seconds = Math.max(time - before.time, 8) / 1000;
    const vx = (sample.x - before.x) / seconds;
    const vy = (sample.y - before.y) / seconds;
    const speed = Math.abs(vx);
    const force = Math.hypot(vx, Math.max(0, vy));
    // Same landmarks the pipeline's gate reads, so a swing never claims more than the gate saw.
    const world = [11, 12, this.hand === 'right' ? 16 : 15].map((index) => snapshot.worldLandmarks[index]);
    const confidence = landmarkConfidence(...world.flatMap((point) => (point ? [point] : [])));

    let travel = 0;
    let reach = 0;
    for (const kept of this.samples) {
      const sideways = sample.x - kept.x;
      const distance = Math.hypot(sideways, Math.max(0, sample.y - kept.y));
      if (Math.abs(sideways) >= MIN_SIDEWAYS_TRAVEL && distance > reach) {
        reach = distance;
        travel = sideways;
      }
    }
    const pending = this.pending;
    if (pending) {
      if (Math.sign(travel) === pending.direction) pending.reach = Math.max(pending.reach, reach);
      if (Math.sign(vx) === pending.direction) pending.force = Math.max(pending.force, force);
      if (Math.sign(vx) === pending.direction && speed > pending.peak.speed) {
        pending.peak = { time, speed, verticalSpeed: vy, y: sample.y, confidence };
      }
      const slowed = Math.sign(vx) !== pending.direction || speed <= pending.peak.speed * 0.65;
      if (!slowed && time - pending.startedAt < SWING_MAX_DURATION_MS) return undefined;
      this.pending = undefined;
      return {
        kind: 'confirmed',
        side: this.sideOf(pending.direction),
        power01: clamp((pending.force - MIN_POWER_SPEED) / (FULL_POWER_SPEED - MIN_POWER_SPEED)),
        confidence: pending.peak.confidence,
        travel: pending.reach,
        peakTimestampMs: pending.peak.time,
        onsetTimestampMs: pending.startedAt,
        // Where the stroke will finish: high above the shoulders, or down by the waist.
        contactY: Math.max(pending.peak.y, sample.y) + Math.min(MAX_FOLLOW_THROUGH, Math.max(0, pending.peak.verticalSpeed) * FOLLOW_THROUGH_S),
        verticalSpeed: pending.peak.verticalSpeed,
      };
    }

    if (reach < this.minTravel) return undefined;
    const direction = Math.sign(travel) as -1 | 1;
    if (this.last) {
      const since = time - this.last.time;
      if (since < REFRACTORY_MS || (direction !== this.last.direction && since < RETURN_IGNORE_MS)) return undefined;
    }
    this.last = { direction, time };
    this.pending = { direction, force, reach, startedAt: time, peak: { time, speed, verticalSpeed: vy, y: sample.y, confidence } };
    return { kind: 'onset', timestampMs: time, side: this.sideOf(direction) };
  }

  /** The wrist's own right (image left) toward its left is a right-hander's forehand. */
  private sideOf(direction: -1 | 1): 'forehand' | 'backhand' {
    return (this.hand === 'right') === direction > 0 ? 'forehand' : 'backhand';
  }

  /** A swing in flight that has not confirmed yet: the arbiter may hold a rival's confirmation for it. */
  hasPending(): boolean { return this.pending !== undefined; }

  private forget(): void {
    this.samples = [];
    this.pending = undefined;
  }

  reset(): void {
    this.forget();
    this.ruler = undefined;
    this.last = undefined;
  }
}
