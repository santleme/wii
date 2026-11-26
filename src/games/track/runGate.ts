const COUNTDOWN_S = 3;
/**
 * Continuous seconds of 'SEM POSE' the run tolerates before pausing. Production references
 * converge on 1–2 s of sustained loss before degrading gameplay at all, and nothing — not
 * Kinect 2010, not Meta, not Peloton — re-onboards the player after a transient: the pause
 * exists only for the player who actually walked away. The camera pipeline already coasts
 * the input through short bursts, so this window only starts once tracking is truly gone
 * (the gate's own blackout window) — and 'PROCURANDO' still sees the body intermittently,
 * so it ends the continuous-loss window instead of counting toward the pause.
 */
const LOST_GRACE_S = 1;

export type RunPhase = 'countdown' | 'running' | 'paused';

/**
 * Decides whether the run may progress. Owned and written by TrackGame only: camera tracking and
 * key presses come in as calls, time comes in from the fixed-step loop.
 *
 * Losing the camera pauses only a player the camera has actually seen, so keyboard-only runs never
 * pause. Returning from a pause resumes the phase the run was in — never a fresh countdown.
 */
export class RunGate {
  private current: RunPhase = 'countdown';
  private remaining = COUNTDOWN_S;
  private cameraSeen = false;
  /** True while the latest tracking label is 'SEM POSE'; `lostFor` times that continuous window. */
  private poseMissing = false;
  private lostFor = 0;
  /** The phase the pause interrupted, restored verbatim when the player comes back. */
  private pausedFrom: RunPhase = 'running';

  get phase(): RunPhase {
    return this.current;
  }

  /** Whole seconds left to show during the countdown. */
  get count(): number {
    return Math.ceil(this.remaining);
  }

  setTracking(tracking: string): void {
    if (tracking === 'TRACKING' || tracking.startsWith('TRACKING · ')) {
      this.poseMissing = false;
      this.lostFor = 0;
      this.cameraSeen = true;
      if (this.current === 'paused') this.current = this.pausedFrom;
    } else if (tracking === 'SEM POSE') {
      this.poseMissing = true;
    } else {
      this.poseMissing = false;
      this.lostFor = 0;
    }
  }

  /** Returns true when the press was consumed to leave the pause. */
  resumeByKey(): boolean {
    if (this.current !== 'paused') return false;
    this.cameraSeen = false;
    this.current = this.pausedFrom;
    return true;
  }

  advance(dt: number): void {
    if (this.poseMissing) {
      this.lostFor += dt;
      if (this.lostFor >= LOST_GRACE_S && this.cameraSeen && this.current !== 'paused') {
        this.pausedFrom = this.current;
        this.current = 'paused';
      }
    }
    if (this.current !== 'countdown') return;
    this.remaining -= dt;
    // Tolerance for the accumulated error of fixed steps.
    if (this.remaining <= 1e-9) this.current = 'running';
  }
}
