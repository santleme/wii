import type { Hand, PoseSnapshot } from '@wii/spatial-core';
import { OneEuroFilter } from '@wii/spatial-core';
import { ShoulderUnit } from './postureSignals';

/** An onset that never confirms stops counting as a punch after this long. */
export const PUNCH_IN_FLIGHT_MS = 400;

/** Which arms have a punch between its onset and its confirmation. */
export class PunchInFlight {
  private readonly startedAt = new Map<Hand, number>();

  start(hand: Hand, timestampMs: number): void { this.startedAt.set(hand, timestampMs); }

  end(hand: Hand): void { this.startedAt.delete(hand); }

  active(timestampMs: number): boolean {
    return [...this.startedAt.values()].some((startedAt) => timestampMs - startedAt < PUNCH_IN_FLIGHT_MS);
  }

  reset(): void { this.startedAt.clear(); }
}

/**
 * Hop thresholds, speeds and distances in shoulder widths (per second). Tunable guesses checked
 * only against synthetic poses, not yet calibrated against recorded players.
 */
export const DASH_THRESHOLDS = {
  /** Lateral speed that opens a hop candidate. */
  onsetSpeed: 1.8,
  /** Below this the motion has stopped: the candidate is dropped and the next hop may arm. */
  continueSpeed: 0.9,
  /** Distance the motion must cover from where it started. */
  minDistance: 0.3,
  /** A candidate that has not covered the distance by now is not a hop. */
  maxDurationMs: 350,
  /** How long a detected hop stays published. */
  holdMs: 200,
  refractoryMs: 500,
  /** A longer gap between samples restarts the motion measure. */
  maxSampleGapMs: 200,
} as const;

const TORSO_CORE = [11, 12, 23, 24] as const;

/**
 * A fast sideways hop of the trunk+hip center, positive toward the player's right (image left in
 * raw camera coordinates). A slow lean stays under the onset speed and belongs to the lane zone.
 */
export class LateralDashTracker {
  // MediaPipe VIDEO mode already smooths the landmarks: this filter stays light to avoid lag.
  private readonly filter = new OneEuroFilter({ minCutoff: 4, beta: 1, derivativeCutoff: 1 });
  private readonly unit = new ShoulderUnit();
  private previous?: { x: number; timeMs: number };
  private candidate?: { direction: -1 | 1; originX: number; startedAt: number; samples: number };
  private fired?: { direction: -1 | 1; atMs: number };
  /** One continuous motion fires once: it has to stop or reverse before the next hop. */
  private armed = true;

  /** ±1 while a detected hop is published, else 0; undefined when the torso is unreadable. */
  update(snapshot: PoseSnapshot, punching = false): -1 | 0 | 1 | undefined {
    const core = TORSO_CORE.map((index) => snapshot.landmarks[index]);
    const centerX = core.reduce((sum, point) => sum + (point?.x ?? Number.NaN), 0) / core.length;
    const unit = this.unit.update(snapshot);
    if (!Number.isFinite(centerX) || unit === undefined) return undefined;

    const timeMs = snapshot.timestampMs;
    if (this.previous && timeMs - this.previous.timeMs > DASH_THRESHOLDS.maxSampleGapMs) this.restartMotion();
    const x = this.filter.filter(centerX, timeMs);
    const previous = this.previous;
    this.previous = { x, timeMs };
    if (previous) this.track(previous, x, unit, timeMs, punching);
    return this.fired && timeMs - this.fired.atMs < DASH_THRESHOLDS.holdMs ? this.fired.direction : 0;
  }

  private track(previous: { x: number; timeMs: number }, x: number, unit: number, timeMs: number, punching: boolean): void {
    const speed = (previous.x - x) / unit / Math.max((timeMs - previous.timeMs) / 1000, 1 / 120);
    const direction = speed >= 0 ? 1 : -1;
    const stopped = Math.abs(speed) < DASH_THRESHOLDS.continueSpeed;
    if (stopped || direction !== this.fired?.direction) this.armed = true;

    const candidate = this.candidate;
    if (punching || (candidate && (stopped || direction !== candidate.direction
      || timeMs - candidate.startedAt > DASH_THRESHOLDS.maxDurationMs))) this.candidate = undefined;
    if (punching) return;

    const refractory = this.fired !== undefined && timeMs - this.fired.atMs < DASH_THRESHOLDS.refractoryMs;
    if (!this.candidate && this.armed && !refractory && Math.abs(speed) >= DASH_THRESHOLDS.onsetSpeed) {
      this.candidate = { direction, originX: previous.x, startedAt: previous.timeMs, samples: 0 };
    }
    if (!this.candidate) return;
    this.candidate.samples += 1;
    // Two moving samples at least: a single jumping frame is tracking noise, not a hop.
    if (this.candidate.samples < 2 || (this.candidate.originX - x) * direction / unit < DASH_THRESHOLDS.minDistance) return;
    this.fired = { direction, atMs: timeMs };
    this.candidate = undefined;
    this.armed = false;
  }

  private restartMotion(): void { this.filter.reset(); this.previous = undefined; this.candidate = undefined; }

  reset(): void { this.restartMotion(); this.unit.reset(); this.fired = undefined; this.armed = true; }
}
