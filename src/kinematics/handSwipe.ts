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
  /** Horizontal speed, in image widths per second. */
  minSpeed?: number;
  /** The speed has to hold this long, over at least two samples. */
  minDurationMs?: number;
  /** Below this speed the hand counts as at rest and the next swipe is armed. */
  rearmSpeed?: number;
  cooldownMs?: number;
  /** Longer than the cooldown, so the hand returning to its place is not read as a swipe back. */
  reverseGuardMs?: number;
  maxFrameGapMs?: number;
}

const STILL: HandSwipeState = { direction: 0, moving: false };

/** Detects a quick sideways flick of the hand from its 2D position. */
export class HandSwipeDetector {
  private readonly options: Required<HandSwipeOptions>;
  private previous?: { timestampMs: number; x: number; y: number };
  private armed = false;
  private heading = 0;
  private heldMs = 0;
  private samples = 0;
  private lastSwipe?: { timestampMs: number; heading: number };

  constructor(options: HandSwipeOptions = {}) {
    this.options = {
      // Above the peak of a quick cursor reach (about 2.25 widths/s for 0.3 width in 250ms).
      minSpeed: 2.5,
      minDurationMs: 50,
      rearmSpeed: 0.5,
      cooldownMs: 350,
      reverseGuardMs: 700,
      maxFrameGapMs: 250,
      ...options,
    };
  }

  update({ timestampMs, x, y, blocked }: HandSwipeSample): HandSwipeState {
    const previous = this.previous;
    this.previous = { timestampMs, x, y };
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
      this.heldMs = 0;
      this.samples = 0;
      return STILL;
    }
    if (Math.abs(vx) < this.options.minSpeed || Math.abs(vx) <= Math.abs(vy)) {
      this.heldMs = 0;
      this.samples = 0;
      return STILL;
    }

    const heading = Math.sign(vx);
    if (heading !== this.heading) {
      this.heading = heading;
      this.heldMs = 0;
      this.samples = 0;
    }
    this.heldMs += dtMs;
    this.samples += 1;
    const sinceSwipe = this.lastSwipe ? timestampMs - this.lastSwipe.timestampMs : Number.POSITIVE_INFINITY;
    const guardMs = this.lastSwipe?.heading === heading ? this.options.cooldownMs : this.options.reverseGuardMs;
    // Two samples: a single jump of the tracker is not a movement.
    if (!this.armed || this.samples < 2 || this.heldMs < this.options.minDurationMs || sinceSwipe < guardMs)
      return { direction: 0, moving: true };

    this.armed = false;
    this.lastSwipe = { timestampMs, heading };
    return { direction: heading < 0 ? 1 : -1, moving: true };
  }

  /** Forgets the motion in progress; the cooldown survives, so losing the hand cannot skip it. */
  disarm(): void {
    this.armed = false;
    this.heading = 0;
    this.heldMs = 0;
    this.samples = 0;
  }

  reset(): void {
    this.disarm();
    this.previous = undefined;
    this.lastSwipe = undefined;
  }
}
