import type { PoseSnapshot, TrackingState } from '@wii/spatial-core';
import { landmarkConfidence } from './math';

const CORE_BODY_LANDMARKS = [11, 12, 23, 24] as const;
/**
 * Per-landmark confidence floor to enter 'tracked' — the BlazePose author's recommended sigmoid
 * threshold (mediapipe issue #1351: "reasonable threshold will be 0.5").
 */
const CONFIDENCE_FLOOR = 0.5;
/**
 * Dual-threshold hysteresis floor to STAY in 'tracked' once confirmed: fast motion blur dips
 * MediaPipe's landmark visibility score by ~15-25% even while the ROI tracker is still locked on.
 */
const STAY_TRACKED_FLOOR = 0.35;
/**
 * Consecutive good frames to confirm tracking. Reacquisition stays fast because gesture
 * reaction needs it; only presence abandonment is slow (DeepSORT confirms in 3 frames too).
 */
const GOOD_FRAMES_TO_TRACKED = 3;
/**
 * Continuous time without a single good frame before the gate gives up on the player's
 * presence. Production trackers converge on ~0.5–1 s for abandoning a track (DeepSORT
 * max_age 30 frames ≈ 1 s at 30 fps; tf.js pose tracker maxAge 1000 ms; VRM retarget 0.5 s),
 * while nothing reacts in ~130 ms — the frame-count window this replaces. Measured on
 * timestamps rather than frame counts so a 15 fps stream gets the same grace as 30 fps,
 * and a dropped frame cannot shrink the window.
 */
export const LOST_AFTER_MS = 800;

export type LandmarkSpace = 'image' | 'world';

/**
 * Temporal hysteresis on body-part visibility: 'tracked' after a few consecutive good
 * frames, 'lost' only after a sustained blackout, 'degraded' in between. A single good
 * frame restarts the blackout window — degraded can last indefinitely under marginal
 * light, which is the honest answer for a body the camera half-sees.
 */
export class TrackingGate {
  private goodFrames = 0;
  private lastGoodAt?: number;
  private state: TrackingState = 'lost';

  constructor(
    private readonly requiredIndices: readonly number[] = CORE_BODY_LANDMARKS,
    private readonly space: LandmarkSpace = 'image',
  ) {}

  evaluate(
    snapshot: PoseSnapshot,
    requiredIndices: readonly number[] = this.requiredIndices,
    space: LandmarkSpace = this.space,
  ): { state: TrackingState; confidence: number } {
    const points = space === 'world' ? snapshot.worldLandmarks : snapshot.landmarks;
    const required = requiredIndices.map((index) => points[index]);
    const complete = required.length > 0 && required.every((point) => point !== undefined);
    const confidence = complete ? landmarkConfidence(...required) : 0;
    const activeFloor = this.state === 'tracked' ? STAY_TRACKED_FLOOR : CONFIDENCE_FLOOR;
    if (complete && confidence >= activeFloor) {
      if (confidence >= CONFIDENCE_FLOOR) this.goodFrames += 1;
      this.lastGoodAt = snapshot.timestampMs;
      if (this.goodFrames >= GOOD_FRAMES_TO_TRACKED) this.state = 'tracked';
      else if (this.state !== 'tracked') this.state = 'degraded';
    } else {
      this.goodFrames = 0;
      const blackoutMs = this.lastGoodAt === undefined ? Number.POSITIVE_INFINITY : snapshot.timestampMs - this.lastGoodAt;
      if (blackoutMs >= LOST_AFTER_MS) this.state = 'lost';
      else this.state = 'degraded';
    }
    return { state: this.state, confidence };
  }

  reset(): void { this.goodFrames = 0; this.lastGoodAt = undefined; this.state = 'lost'; }
}
