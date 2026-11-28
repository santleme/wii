import { median } from './math';

/**
 * Walking in place barely lifts the shoulders (0.010 shoulder widths on real recordings, less than
 * swinging the arms) but shifts the weight from foot to foot: the shoulders sway side to side, one
 * turn per step. That sway, with almost no vertical movement, is what walking looks like from a webcam.
 * Chosen on two walking segments of one player, and the margin is narrow: a turn size of 0.15 loses
 * most walking, 0.10 with fewer than three intervals lets camera jitter through.
 */
/** A turn counts after coming back this far (shoulder widths); standing and arm swinging stay below. */
const TURN_SW = 0.1;
/** Between two turns, a wider travel is a step into another lane, not weight shifting. */
const MAX_SWAY_SW = 0.35;
const MIN_TURN_GAP_MS = 250;
/** The pace is the middle of the last few steps: one early or late turn must not change the speed. */
const PACE_STEPS = 5;
const MAX_TURN_GAP_MS = 1000;
/** Consecutive well-spaced turn intervals needed before it counts. */
const MIN_INTERVALS = 3;
/** Landmark jitter turns constantly and at random; smoothing removes it, and real steps are alike. */
const SMOOTHING_MS = 120;
const MAX_GAP_CHANGE = 0.4;
/**
 * More vertical spread of the head than this (over one second) is running or jumping. The head, not
 * the shoulders: swinging the arms high while walking hoists the shoulders and left the head quiet.
 */
const MAX_VERTICAL_SW = 0.045;
const VERTICAL_WINDOW_MS = 1000;

type Point = { t: number; x: number };

/** `spm` is the pace of the latest weight shifts, in steps per minute; 0 while not walking. */
export interface Walk { walking: boolean; step: boolean; spm: number }

export class WalkDetector {
  private high?: Point;
  private low?: Point;
  private direction: -1 | 0 | 1 = 0;
  private lastTurn?: Point;
  private intervals = 0;
  private smooth?: Point;
  private lastGap?: number;
  private gaps: number[] = [];
  private vertical: { t: number; y: number }[] = [];

  /** `x` is the shoulder midpoint and `y` the head (or shoulders), in the shoulder width's units. */
  update(t: number, x: number, y: number, width: number): Walk {
    this.vertical = [...this.vertical.filter((sample) => t - sample.t <= VERTICAL_WINDOW_MS), { t, y }];
    const mean = this.vertical.reduce((sum, sample) => sum + sample.y, 0) / this.vertical.length;
    const spread = Math.sqrt(this.vertical.reduce((sum, sample) => sum + (sample.y - mean) ** 2, 0) / this.vertical.length) / width;

    const alpha = this.smooth ? 1 - Math.exp(-(t - this.smooth.t) / SMOOTHING_MS) : 1;
    x = (this.smooth?.x ?? x) + (x - (this.smooth?.x ?? x)) * alpha;
    const here = { t, x };
    this.smooth = here;
    if (!this.high || x > this.high.x) this.high = here;
    if (!this.low || x < this.low.x) this.low = here;
    let turn: Point | undefined;
    if (this.direction >= 0 && (this.high.x - x) / width >= TURN_SW) { turn = this.high; this.direction = -1; }
    else if (this.direction <= 0 && (x - this.low.x) / width >= TURN_SW) { turn = this.low; this.direction = 1; }
    let step = false;
    if (turn) {
      this.high = this.low = here;
      const gap = this.lastTurn ? turn.t - this.lastTurn.t : Number.POSITIVE_INFINITY;
      const sway = this.lastTurn ? Math.abs(turn.x - this.lastTurn.x) / width : Number.POSITIVE_INFINITY;
      const alike = this.lastGap === undefined || Math.abs(gap - this.lastGap) <= this.lastGap * MAX_GAP_CHANGE;
      const regular = gap >= MIN_TURN_GAP_MS && gap <= MAX_TURN_GAP_MS && sway <= MAX_SWAY_SW && alike;
      this.lastGap = gap <= MAX_TURN_GAP_MS ? gap : undefined;
      this.intervals = regular ? this.intervals + 1 : 0;
      step = regular && this.intervals >= MIN_INTERVALS;
      this.gaps = regular ? [...this.gaps, gap].slice(-PACE_STEPS) : [];
      this.lastTurn = turn;
    }
    const walking = this.intervals >= MIN_INTERVALS && this.lastTurn !== undefined
      && t - this.lastTurn.t <= MAX_TURN_GAP_MS && spread < MAX_VERTICAL_SW;
    return { walking, step: step && walking, spm: walking && this.gaps.length ? 60_000 / median(this.gaps) : 0 };
  }

  reset(): void {
    this.high = this.low = this.lastTurn = undefined;
    this.direction = 0;
    this.intervals = 0;
    this.vertical = [];
    this.smooth = this.lastGap = undefined;
    this.gaps = [];
  }
}
