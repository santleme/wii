import { JUMP_DURATION_S } from './jump';

/** A jump is "perfect" when the hurdle crosses the runner this close (seconds) to its apex. */
export const PERFECT_WINDOW_S = 0.08;
export const MAX_MULTIPLIER = 4;
const CLEAR_POINTS = 100;
const PERFECT_POINTS = 50;
const HIT_PENALTY = 35;
const COIN_POINTS = 25;

/** `jumpRemaining` is the air time left when the hurdle crossed; 0 means the runner was grounded. */
export function isPerfectJump(jumpRemaining: number): boolean {
  return jumpRemaining > 0 && Math.abs(jumpRemaining - JUMP_DURATION_S / 2) <= PERFECT_WINDOW_S;
}

export interface Award { points: number; multiplier: number; perfect: boolean }

export class TrackScore {
  private value = 0;
  private streak = 0;
  private bestStreak = 0;
  private nextPenalty = HIT_PENALTY;
  private best = 0;
  private ended = false;

  /** Highest score held during the run. */
  get peak(): number {
    return Math.floor(this.best);
  }

  /** True once a trip has wiped the score out: the run is lost. */
  get over(): boolean {
    return this.ended;
  }

  private add(points: number): void {
    this.value += points;
    this.best = Math.max(this.best, this.value);
  }

  get combo(): number {
    return this.streak;
  }

  /** Highest clear streak reached in the run, preserved after a hit resets the live combo. */
  get bestComboCount(): number {
    return this.bestStreak;
  }

  advance(dt: number, speed01: number): void {
    if (!Number.isFinite(speed01)) return;
    this.add(dt * speed01 * 50);
  }

  /** Each clear in a row raises the multiplier by one, up to MAX_MULTIPLIER. */
  hurdleCleared(perfect = false): Award {
    this.streak += 1;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    const multiplier = Math.min(MAX_MULTIPLIER, this.streak);
    const points = (CLEAR_POINTS + (perfect ? PERFECT_POINTS : 0)) * multiplier;
    this.add(points);
    return { points, multiplier, perfect };
  }

  /** Coins are a flat bonus: they neither build nor break the combo. */
  coinCollected(): number {
    this.add(COIN_POINTS);
    return COIN_POINTS;
  }

  /** Every trip of the run costs double the previous one. Returns the penalty charged. */
  hurdleHit(): number {
    const penalty = this.nextPenalty;
    this.nextPenalty *= 2;
    this.streak = 0;
    this.value = Math.max(0, this.value - penalty);
    if (this.display === 0) this.ended = true;
    return penalty;
  }

  get display(): number {
    return Math.floor(this.value);
  }
}
