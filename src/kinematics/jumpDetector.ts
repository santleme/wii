import { median } from './math';
import type { TorsoVerticalSample } from './torsoVertical';

/**
 * Both shoulders this far above where they just were, in shoulder widths. Real recordings put
 * jumps at 0.5–0.9 and running strides below 0.25; the hips are not needed, a close camera cuts them off.
 */
export const JUMP_MIN_RISE_SW = 0.45;
/** "Where they just were": this stretch before now, clear of the takeoff. */
const BASELINE_FROM_MS = 1600;
const BASELINE_TO_MS = 250;
const MIN_BASELINE_SAMPLES = 8;
/** Takeoff to settled landing; also how long the running verdict is held. */
const AIRBORNE_MS = 600;
const REFRACTORY_MS = 900;
/**
 * Hopping without pause leaves the typical height up in the air, so right after a jump the next one
 * is measured from the ground instead, and must come back down first and reach a similar height.
 */
const FOLLOW_UP_MS = 1500;
const FOLLOW_UP_REFRACTORY_MS = 400;
const FOLLOW_UP_HEIGHT_RATIO = 0.8;
const GROUND_PERCENTILE = 0.9;
const LANDED_RISE_SW = 0.2;
const PEAK_WINDOW_MS = 450;
/** The head must rise too: lifting the arms hoists the shoulders under a head that stays put. */
const HEAD_RISE_RATIO = 0.3;

export class JumpDetector {
  private samples: TorsoVerticalSample[] = [];
  private lastJumpAt = Number.NEGATIVE_INFINITY;
  private now = Number.NEGATIVE_INFINITY;
  private landed = true;
  /** How high the last jump went above the ground. */
  private height = 0;

  get suppressesCadence(): boolean { return this.now - this.lastJumpAt < AIRBORNE_MS; }

  update(sample: TorsoVerticalSample): boolean {
    this.now = sample.timestampMs;
    const before = this.samples.filter((old) => this.now - old.timestampMs >= BASELINE_TO_MS && this.now - old.timestampMs <= BASELINE_FROM_MS);
    this.samples = [...this.samples.filter((old) => this.now - old.timestampMs <= BASELINE_FROM_MS), sample];
    if (before.length < MIN_BASELINE_SAMPLES) return false;
    const { left, right, width } = sample.shoulders;
    const lefts = before.map((old) => old.shoulders.left);
    const rights = before.map((old) => old.shoulders.right);
    // Image y grows downward: rising is a baseline minus the current height, and the ground is a high y.
    const ground = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * GROUND_PERCENTILE)]!;
    const aboveTypical = Math.min(median(lefts) - left, median(rights) - right) / width;
    const aboveGround = Math.min(ground(lefts) - left, ground(rights) - right) / width;

    const heads = before.map((old) => old.shoulders.head);
    const headRose = (baseline: number, rise: number) => !((baseline - sample.shoulders.head) / width < rise * HEAD_RISE_RATIO);

    const since = this.now - this.lastJumpAt;
    if (since < PEAK_WINDOW_MS) this.height = Math.max(this.height, aboveGround);
    if (aboveGround < LANDED_RISE_SW) this.landed = true;
    const again = since >= FOLLOW_UP_REFRACTORY_MS && since <= FOLLOW_UP_MS && this.landed
      && aboveGround >= Math.max(JUMP_MIN_RISE_SW, this.height * FOLLOW_UP_HEIGHT_RATIO)
      && headRose(ground(heads), aboveGround);
    const fresh = since >= REFRACTORY_MS && aboveTypical >= JUMP_MIN_RISE_SW && headRose(median(heads), aboveTypical);
    if (!again && !fresh) return false;
    this.lastJumpAt = this.now;
    this.landed = false;
    this.height = aboveGround;
    return true;
  }

  reset(): void {
    this.samples = [];
    this.lastJumpAt = this.now = Number.NEGATIVE_INFINITY;
    this.landed = true;
    this.height = 0;
  }
}
