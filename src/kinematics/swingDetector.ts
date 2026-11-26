import type { CalibrationProfile, Hand, PoseSnapshot } from '../cv/protocol';
import { OneEuroFilter } from '@wii/spatial-core';
import { clamp, distance3, landmarkConfidence } from './math';
import { bodyLocalPoint } from './bodyFrame';

export interface SwingSignal {
  side: 'forehand' | 'backhand';
  power01: number;
  confidence: number;
  peakTimestampMs: number;
  /** Frame where the onset threshold was crossed — the stroke's physical start. */
  onsetTimestampMs: number;
  /** Wrist height relative to its shoulder at the speed peak, in shoulder widths, up positive. */
  contactY: number;
  /** Vertical wrist speed at the peak in shoulder widths/s, up positive — topspin/slice proxy. */
  verticalSpeed: number;
}

/**
 * What one detector update yields. `onset` is the real-time, unconfirmed notice emitted on the
 * frame the wrist crosses the onset threshold — backswings and aborted strokes fire it too, so it
 * serves animation, never adjudication. `confirmed` is the measured stroke, emitted after the
 * follow-through proves it, carrying the peak-frame measurements.
 */
export type SwingOutput =
  | { kind: 'onset'; timestampMs: number }
  | ({ kind: 'confirmed' } & SwingSignal);

const MIN_LATERAL_SWING_RATIO = 0.25;
const MIN_SWING_SPEED_BODY_WIDTHS_PER_SEC = 2;
const FULL_POWER_SWING_SPEED_BODY_WIDTHS_PER_SEC = 7;
const SWING_DIRECTION_EPSILON_BODY_WIDTHS_PER_SEC = 0.5;
const SWING_MIN_DURATION_MS = 30;
const POSITIONED_REARM_DWELL_MS = 180;
const VELOCITY_ONLY_REARM_DWELL_MS = 500;
const REARM_MAX_SAMPLE_GAP_MS = 200;
export const SWING_MAX_DURATION_MS = 300;

export function hasMeaningfulLateralComponent(speedBodyWidthsPerSecond: number, lateralSpeedBodyWidthsPerSecond: number): boolean {
  return speedBodyWidthsPerSecond >= MIN_SWING_SPEED_BODY_WIDTHS_PER_SEC
    && Math.abs(lateralSpeedBodyWidthsPerSecond) / speedBodyWidthsPerSecond >= MIN_LATERAL_SWING_RATIO;
}

interface SwingPeak {
  /** Wrist height relative to the shoulder at the peak frame, in shoulder widths. */
  y: number;
  /** Velocities are normalized to shoulder widths per second, not meters per second. */
  speedBodyWidthsPerSecond: number;
  lateralSpeedBodyWidthsPerSecond: number;
  verticalSpeedBodyWidthsPerSecond: number;
  confidence: number;
  timestampMs: number;
}

interface PendingSwing {
  direction: -1 | 1;
  startedAt: number;
  peak: SwingPeak;
}

export class SwingDetector {
  constructor(private readonly hand: Hand) {}

  private readonly xFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
  private readonly yFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
  private readonly zFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
  private previous?: { x: number; y: number; z: number; time: number };
  private mode: 'ready' | 'swing' | 'return' = 'ready';
  private pendingSwing?: PendingSwing;
  private lastSwingAt = Number.NEGATIVE_INFINITY;
  private readySince?: number;
  private lowSpeedSince?: number;

  update(snapshot: PoseSnapshot, calibration: CalibrationProfile): SwingOutput | undefined {
    const hand = this.hand;
    const wrist = snapshot.worldLandmarks[hand === 'right' ? 16 : 15];
    const shoulder = snapshot.worldLandmarks[hand === 'right' ? 12 : 11];
    const leftShoulder = snapshot.worldLandmarks[11];
    const rightShoulder = snapshot.worldLandmarks[12];
    const leftHip = snapshot.worldLandmarks[23];
    const rightHip = snapshot.worldLandmarks[24];
    if (!wrist || !shoulder || !leftShoulder || !rightShoulder || !leftHip || !rightHip) { this.reset(); return undefined; }
    const localWrist = bodyLocalPoint(wrist, shoulder, leftShoulder, rightShoulder, leftHip, rightHip, calibration.world.shoulderWidth);
    if (!localWrist) { this.reset(); return undefined; }
    const current = {
      x: this.xFilter.filter(localWrist.x, snapshot.timestampMs),
      y: this.yFilter.filter(localWrist.y, snapshot.timestampMs),
      z: this.zFilter.filter(localWrist.z, snapshot.timestampMs),
      time: snapshot.timestampMs,
    };
    if (!this.previous) { this.previous = current; return undefined; }
    if (this.pendingSwing && current.time - this.previous.time > SWING_MAX_DURATION_MS) {
      this.enterReturn();
    }
    const dt = Math.max((current.time - this.previous.time) / 1000, 1 / 120);
    const vx = (current.x - this.previous.x) / dt;
    const vy = (current.y - this.previous.y) / dt;
    const vz = (current.z - this.previous.z) / dt;
    const speedBodyWidthsPerSecond = Math.hypot(vx, vy, vz);
    const lateralSpeedBodyWidthsPerSecond = vx;
    const readyWrist = calibration.world.readyWristLocal?.[hand];
    const readyDistance = readyWrist ? distance3(current, readyWrist) : undefined;
    const confidence = landmarkConfidence(leftShoulder, rightShoulder, leftHip, rightHip, wrist);
    const frameGapMs = current.time - this.previous.time;
    this.previous = current;

    if (this.mode === 'ready') {
      if (hasMeaningfulLateralComponent(speedBodyWidthsPerSecond, lateralSpeedBodyWidthsPerSecond) && snapshot.timestampMs - this.lastSwingAt >= 400) {
        const direction = Math.sign(lateralSpeedBodyWidthsPerSecond) as -1 | 1;
        this.pendingSwing = {
          direction,
          startedAt: snapshot.timestampMs,
          peak: {
            y: current.y,
            speedBodyWidthsPerSecond,
            lateralSpeedBodyWidthsPerSecond,
            verticalSpeedBodyWidthsPerSecond: vy,
            confidence,
            timestampMs: snapshot.timestampMs,
          },
        };
        this.mode = 'swing';
        this.lastSwingAt = snapshot.timestampMs;
        return { kind: 'onset', timestampMs: snapshot.timestampMs };
      }
      return undefined;
    }

    if (this.mode === 'swing') {
      const pending = this.pendingSwing;
      if (!pending) { this.enterReturn(); return undefined; }
      const ageMs = snapshot.timestampMs - pending.startedAt;
      const sameDirection = Math.sign(lateralSpeedBodyWidthsPerSecond) === pending.direction;
      const lowLateralSpeed = Math.abs(lateralSpeedBodyWidthsPerSecond) < SWING_DIRECTION_EPSILON_BODY_WIDTHS_PER_SEC;
      if (sameDirection && speedBodyWidthsPerSecond > pending.peak.speedBodyWidthsPerSecond
        && hasMeaningfulLateralComponent(speedBodyWidthsPerSecond, lateralSpeedBodyWidthsPerSecond)) {
        pending.peak = {
          y: current.y,
          speedBodyWidthsPerSecond,
          lateralSpeedBodyWidthsPerSecond,
          verticalSpeedBodyWidthsPerSecond: vy,
          confidence,
          timestampMs: snapshot.timestampMs,
        };
      }
      const reversed = !sameDirection && !lowLateralSpeed;
      const decelerated = (sameDirection || lowLateralSpeed) && ageMs >= SWING_MIN_DURATION_MS
        && speedBodyWidthsPerSecond <= Math.max(pending.peak.speedBodyWidthsPerSecond * 0.65, 1.2);
      const timedOut = ageMs >= SWING_MAX_DURATION_MS;
      if (!reversed && !decelerated && !timedOut) return undefined;

      this.enterReturn();
      const forehandDirection = hand === 'right' ? pending.direction < 0 : pending.direction > 0;
      return {
        kind: 'confirmed',
        side: forehandDirection ? 'forehand' : 'backhand',
        power01: clamp((pending.peak.speedBodyWidthsPerSecond - MIN_SWING_SPEED_BODY_WIDTHS_PER_SEC)
          / (FULL_POWER_SWING_SPEED_BODY_WIDTHS_PER_SEC - MIN_SWING_SPEED_BODY_WIDTHS_PER_SEC)),
        confidence: pending.peak.confidence,
        peakTimestampMs: pending.peak.timestampMs,
        onsetTimestampMs: pending.startedAt,
        contactY: pending.peak.y,
        verticalSpeed: pending.peak.verticalSpeedBodyWidthsPerSecond,
      };
    }

    if (this.mode === 'return') {
      const sampleGapMs = frameGapMs;
      if (sampleGapMs > REARM_MAX_SAMPLE_GAP_MS) {
        this.readySince = undefined;
        this.lowSpeedSince = undefined;
      }
      if (readyDistance !== undefined && readyDistance < 0.35 && speedBodyWidthsPerSecond < 1.2) {
        this.readySince ??= snapshot.timestampMs;
      } else this.readySince = undefined;
      if (speedBodyWidthsPerSecond < 1.2) this.lowSpeedSince ??= snapshot.timestampMs;
      else this.lowSpeedSince = undefined;
      if (
        (this.readySince !== undefined && snapshot.timestampMs - this.readySince >= POSITIONED_REARM_DWELL_MS)
        || (this.lowSpeedSince !== undefined && snapshot.timestampMs - this.lowSpeedSince >= VELOCITY_ONLY_REARM_DWELL_MS)
      ) {
        this.mode = 'ready';
        this.readySince = undefined;
        this.lowSpeedSince = undefined;
      }
    }
    return undefined;
  }

  /** Explicitly rejected/degraded samples break re-arm continuity even when no valid sample reaches this detector. */
  interruptRearm(): void { this.readySince = undefined; this.lowSpeedSince = undefined; }

  /** A swing in flight that has not confirmed yet: the arbiter may hold a rival's confirmation for it. */
  hasPending(): boolean { return this.pendingSwing !== undefined; }

  private enterReturn(): void {
    this.pendingSwing = undefined;
    this.readySince = undefined;
    this.lowSpeedSince = undefined;
    this.mode = 'return';
  }

  reset(): void { this.xFilter.reset(); this.yFilter.reset(); this.zFilter.reset(); this.previous = undefined; this.mode = 'return'; this.pendingSwing = undefined; this.lastSwingAt = Number.NEGATIVE_INFINITY; this.readySince = undefined; this.lowSpeedSince = undefined; }
}
