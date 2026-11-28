import type { Hand, PoseSnapshot } from '@wii/spatial-core';

export interface ArmMotion {
  hand: Hand;
  /** Sideways part of the movement, positive towards the player's own left. */
  sideways: number;
}

/*
 * "Did this arm clearly move just now?" — much looser than a stroke on purpose. A first-time player,
 * recorded with the camera seeing them perfectly, swung slower, more upwards and less sideways than
 * the stroke detector asks for. The games only listen to this while there is a ball to hit.
 */
const MOTION_TRAVEL = 1;
const WINDOW_MS = 500;
const MIN_CONFIDENCE = 0.5;

export class ArmMotionDetector {
  private samples: { x: number; y: number; time: number }[] = [];
  private width = 0;

  constructor(private readonly hand: Hand) {}

  update(snapshot: PoseSnapshot): ArmMotion | undefined {
    const [left, right, wrist] = [11, 12, this.hand === 'right' ? 16 : 15].map((index) => snapshot.landmarks[index]);
    if (!left || !right || !wrist || (wrist.visibility ?? 0) < MIN_CONFIDENCE) return undefined;
    const aspect = snapshot.frameHeight && snapshot.frameWidth ? snapshot.frameHeight / snapshot.frameWidth : 0.75;
    // The ruler shrinks slowly: twisting the trunk collapses the apparent shoulder width.
    this.width = Math.max(Math.hypot(left.x - right.x, (left.y - right.y) * aspect), this.width * 0.99);
    if (this.width <= 0) return undefined;
    const sample = {
      x: (wrist.x - (left.x + right.x) / 2) / this.width,
      y: ((wrist.y - (left.y + right.y) / 2) * aspect) / this.width,
      time: snapshot.timestampMs,
    };
    this.samples = [...this.samples.filter((kept) => sample.time - kept.time <= WINDOW_MS), sample];
    let farthest = 0;
    let sideways = 0;
    for (const kept of this.samples) {
      const distance = Math.hypot(sample.x - kept.x, sample.y - kept.y);
      if (distance > farthest) {
        farthest = distance;
        sideways = sample.x - kept.x;
      }
    }
    return farthest >= MOTION_TRAVEL ? { hand: this.hand, sideways } : undefined;
  }

  reset(): void { this.samples = []; this.width = 0; }
}
