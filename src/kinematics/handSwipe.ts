export interface HandSwipeSample {
  timestampMs: number;
  /** Anchor position in the mirrored image, both axes in units of image width. */
  x: number;
  y: number;
  /** True while another gesture owns the hand. */
  blocked: boolean;
}

export interface HandSwipeState {
  /** One-sample pulse, as a wheel step: a hand sent left brings the next slot (+1), right the previous. */
  direction: -1 | 0 | 1;
  /** The hand is moving sideways fast enough to be swiping; clicks should not start now. */
  moving: boolean;
}

export interface HandSwipeOptions {
  /** Horizontal speed, in image widths per second, measured over a short sliding window. */
  minSpeed?: number;
  /** Shortest window evaluated for a swipe. */
  minDurationMs?: number;
  /** Below this speed the hand counts as at rest and the next swipe is armed. */
  rearmSpeed?: number;
  cooldownMs?: number;
  /** Longer than the cooldown, so the hand returning to its place is not read as a swipe back. */
  reverseGuardMs?: number;
  maxFrameGapMs?: number;
  /** Longest sliding window evaluated for net displacement. */
  windowMs?: number;
  /** Net horizontal displacement inside the window, in image widths. */
  minDistance?: number;
}

/** Horizontal displacement has to beat vertical by this much, so a diagonal pointer move is not a swipe. */
const HORIZONTAL_DOMINANCE = 1.25;

const STILL: HandSwipeState = { direction: 0, moving: false };

interface MotionSample {
  timestampMs: number;
  x: number;
  y: number;
}

/** Detects a quick sideways flick of the hand from its 2D position. */
export class HandSwipeDetector {
  private readonly options: Required<HandSwipeOptions>;
  private previous?: MotionSample;
  private motion: MotionSample[] = [];
  private armed = false;
  private lastSwipe?: { timestampMs: number; heading: number };

  constructor(options: HandSwipeOptions = {}) {
    this.options = {
      // Tuned on real camera footage at playing distance. A very quick cursor reach can pass it.
      minSpeed: 1.55,
      minDurationMs: 40,
      rearmSpeed: 0.45,
      cooldownMs: 350,
      reverseGuardMs: 450,
      maxFrameGapMs: 250,
      windowMs: 140,
      minDistance: 0.1,
      ...options,
    };
  }

  update({ timestampMs, x, y, blocked }: HandSwipeSample): HandSwipeState {
    const previous = this.previous;
    const current = { timestampMs, x, y };
    this.previous = current;
    const dtMs = previous ? timestampMs - previous.timestampMs : 0;
    if (blocked || !previous || dtMs <= 0 || dtMs > this.options.maxFrameGapMs) {
      this.disarm();
      return STILL;
    }

    const vx = (x - previous.x) / (dtMs / 1000);
    const vy = (y - previous.y) / (dtMs / 1000);
    // Rest is judged on both axes: a hand still travelling vertically is not waiting for a swipe.
    if (Math.hypot(vx, vy) <= this.options.rearmSpeed) {
      this.armed = true;
      this.motion = [];
      return STILL;
    }

    if (this.motion.length === 0) this.motion.push(previous);
    this.motion.push(current);
    this.prune(timestampMs);

    const movement = this.windowMovement(timestampMs);
    if (!movement.moving) return STILL;

    const sinceSwipe = this.lastSwipe ? timestampMs - this.lastSwipe.timestampMs : Number.POSITIVE_INFINITY;
    const pulse = movement.pulse;
    const guardMs = pulse && this.lastSwipe?.heading === pulse.heading ? this.options.cooldownMs : this.options.reverseGuardMs;
    if (!this.armed || !pulse || sinceSwipe < guardMs) return { direction: 0, moving: true };

    this.armed = false;
    this.lastSwipe = { timestampMs, heading: pulse.heading };
    return { direction: pulse.heading < 0 ? 1 : -1, moving: true };
  }

  /** Forgets the motion in progress; the cooldown survives, so losing the hand cannot skip it. */
  disarm(): void {
    this.armed = false;
    this.motion = [];
  }

  reset(): void {
    this.disarm();
    this.previous = undefined;
    this.lastSwipe = undefined;
  }

  private prune(timestampMs: number): void {
    const cutoffMs = timestampMs - this.options.windowMs;
    // Keep one sample before the cutoff so the exact window edge can be interpolated.
    while (this.motion.length > 2 && this.motion[1]!.timestampMs < cutoffMs) this.motion.shift();
  }

  private windowMovement(endMs: number): { moving: boolean; pulse?: { heading: -1 | 1; speed: number } } {
    const end = this.motion.at(-1);
    const first = this.motion[0];
    if (!end || !first) return { moving: false };

    const cutoffMs = endMs - this.options.windowMs;
    const latestStartMs = endMs - this.options.minDurationMs;
    const starts = new Map<number, MotionSample>();
    if (cutoffMs >= first.timestampMs && cutoffMs <= latestStartMs) {
      const edge = this.positionAt(cutoffMs);
      if (edge) starts.set(cutoffMs, edge);
    }
    for (const sample of this.motion) {
      if (sample.timestampMs >= cutoffMs && sample.timestampMs <= latestStartMs) starts.set(sample.timestampMs, sample);
    }

    let moving = false;
    let pulse: { heading: -1 | 1; speed: number } | undefined;
    for (const start of starts.values()) {
      const durationMs = endMs - start.timestampMs;
      if (durationMs < this.options.minDurationMs || durationMs > this.options.windowMs) continue;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const absX = Math.abs(dx);
      if (absX <= Math.abs(dy) * HORIZONTAL_DOMINANCE) continue;
      const speed = absX / (durationMs / 1000);
      if (speed < this.options.minSpeed) continue;
      const heading = Math.sign(dx) as -1 | 1;
      if (!this.hasSustainedMotion(start.timestampMs, endMs, heading)) continue;
      moving = true;
      if (absX >= this.options.minDistance && (!pulse || speed > pulse.speed)) pulse = { heading, speed };
    }
    return { moving, pulse };
  }

  /**
   * A window is sustained when at least two frame intervals inside it move the same way. One bad
   * interval only lowers the net displacement; it no longer erases the whole swipe.
   */
  private hasSustainedMotion(startMs: number, endMs: number, heading: -1 | 1): boolean {
    let intervals = 0;
    for (let index = 1; index < this.motion.length; index += 1) {
      const before = this.motion[index - 1]!;
      const after = this.motion[index]!;
      const overlapStartMs = Math.max(before.timestampMs, startMs);
      const overlapEndMs = Math.min(after.timestampMs, endMs);
      const intervalMs = after.timestampMs - before.timestampMs;
      if (overlapEndMs <= overlapStartMs || intervalMs <= 0) continue;
      const overlapRatio = (overlapEndMs - overlapStartMs) / intervalMs;
      const overlapDx = (after.x - before.x) * overlapRatio;
      const intervalSpeed = Math.abs(after.x - before.x) / (intervalMs / 1000);
      if (Math.sign(overlapDx) === heading && intervalSpeed >= this.options.rearmSpeed) intervals += 1;
    }
    return intervals >= 2;
  }

  private positionAt(timestampMs: number): MotionSample | undefined {
    const first = this.motion[0];
    if (!first || timestampMs < first.timestampMs) return undefined;
    for (let index = 1; index < this.motion.length; index += 1) {
      const before = this.motion[index - 1]!;
      const after = this.motion[index]!;
      if (timestampMs > after.timestampMs) continue;
      const spanMs = after.timestampMs - before.timestampMs;
      if (spanMs <= 0) return after;
      const progress = (timestampMs - before.timestampMs) / spanMs;
      return {
        timestampMs,
        x: before.x + (after.x - before.x) * progress,
        y: before.y + (after.y - before.y) * progress,
      };
    }
    return this.motion.at(-1);
  }
}
