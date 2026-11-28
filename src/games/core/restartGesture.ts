/** After a race or match, holding both hands up this long plays again: no mouse needed. */
export const RESTART_HOLD_S = 1.5;
/** The result is shown this long before hands count; arms are still up from playing. */
export const RESTART_AFTER_S = 2;
/** A frozen camera or a dropped run of frames breaks the hold. */
const MAX_GESTURE_GAP_MS = 250;

export interface GestureSample { active: boolean; atMs: number }

/** Counts time between observed poses. A simulation tick alone cannot advance a hold. */
export class RestartGesture {
  private sample?: GestureSample;
  private sinceOverS = 0;
  /** The hands must have been seen down after the end before raising them means anything. */
  private armed = false;
  private heldS = 0;

  setHandsRaised(active: boolean, atMs: number | null): void {
    if (atMs === null) {
      this.sample = undefined;
      this.heldS = 0;
      return;
    }
    const previous = this.sample;
    if (previous && atMs <= previous.atMs) return;
    const gapMs = previous ? atMs - previous.atMs : Infinity;
    if (this.armed && active && previous?.active && gapMs <= MAX_GESTURE_GAP_MS) this.heldS += gapMs / 1000;
    else this.heldS = 0;
    this.sample = { active, atMs };
  }

  /** Call only while the game is over, or while waiting for the tutorial skip. */
  step(dt: number, wallTimeMs?: number): void {
    this.sinceOverS += dt;
    if (this.sample && wallTimeMs !== undefined && wallTimeMs - this.sample.atMs > MAX_GESTURE_GAP_MS) {
      this.setHandsRaised(false, null);
    }
    if (this.sinceOverS >= RESTART_AFTER_S && this.sample?.active === false) this.armed = true;
  }

  /** 0–1; 1 asks for a new game. */
  get progress01(): number { return Math.min(1, this.heldS / RESTART_HOLD_S); }
}
