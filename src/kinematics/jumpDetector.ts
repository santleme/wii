import type { TorsoVerticalSample } from './torsoVertical';

/**
 * Takeoff amplitude in torsoHeights above the adaptive baseline, measured on the channel's
 * FILTERED signal. Input bounce of 0.09 torso semi-amplitude (the high tail of the running
 * literature) reads as ~0.07 filtered, so 0.10 sits above realistic bounce with margin while
 * still catching an 8 cm hop — the smaller end of what hurdle gameplay needs. The plan's
 * initial guess (0.12) was calibrated for the unfiltered signal: on the filtered chain it can
 * never coincide with the velocity gate during a mid-run jump, so the gates below are the
 * measured starting point — final values wait on real-camera recordings (spec §9d).
 */
export const JUMP_MIN_RISE = 0.1;
/**
 * Sustained upward velocity at fire time, torsoHeights/s, again on the filtered signal.
 * Bounce and jump separate through the phase of the two signals: in a sinusoidal bounce
 * velocity peaks where rise is zero, while a takeoff carries high velocity INTO high rise.
 * At the moment bounce crosses the amplitude floor its filtered velocity is under ~0.7; a
 * jump through the same point carries 1.4–2.3. In steady-state sinusoidal bounce the velocity
 * peak (~1.4 filtered at the extreme) is a quarter-cycle away from the rise peak, so the two
 * gates never hold at once — that phase separation is what rejects bounce. The protection is
 * weaker during amplitude transients: a bounce ramping up fast can carry velocity into the
 * amplitude crossing, so the false-fire boundary is an open measurement question (spec §9).
 */
export const JUMP_MIN_VELOCITY = 1.2;
/** A jump's takeoff must rise above the slow envelope of sustained running bounce. */
const MIN_JUMP_TO_BOUNCE_RATIO = 1.2;
const TAKEOFF_CONFIRM_MS = 30;
const REFRACTORY_MS = 400;
/** Initial arming needs quiet standing: this long inside the neutral band. */
const ARM_BAND_TORSO = 0.03;
const ARM_DWELL_MS = 160;
/**
 * After firing, the detector re-arms as soon as the position falls back under this height —
 * deliberately generous: re-arming must work while the player keeps bouncing (the in-band
 * dwell of a running bounce never lasts 160 ms), and false re-arms are harmless because the
 * amplitude+velocity gates are what actually discriminate jumps from bounce.
 */
const REARM_RISE_TORSO = 0.05;
/**
 * Hard bound on time airborne. A real takeoff falls back under the rearm band well inside
 * this window; rise held above the band past it is stale signal — tracking micro-oscillation
 * hovering over the threshold — not a flight, so the detector re-arms anyway instead of
 * swallowing every later jump.
 */
const MAX_AIRBORNE_MS = 700;

/**
 * Jump detection against the torso channel's adaptive baseline — no calibration involved.
 * State machine: disarmed until quiet standing proves a sane baseline; fires when rise and
 * upward velocity hold the gates together for 30 ms; re-arms on the way back down.
 */
export class JumpDetector {
  private risingSince?: number;
  private airborne = false;
  private armed = false;
  private neutralSince?: number;
  private lastJumpAt = Number.NEGATIVE_INFINITY;

  get suppressesCadence(): boolean { return this.risingSince !== undefined || this.airborne; }

  update(sample: TorsoVerticalSample): boolean {
    const { rise, velocityUp, timestampMs } = sample;
    if (!this.armed) {
      if (Math.abs(rise) <= ARM_BAND_TORSO) {
        this.neutralSince ??= timestampMs;
        if (timestampMs - this.neutralSince >= ARM_DWELL_MS) {
          this.armed = true;
          this.neutralSince = undefined;
        }
      } else this.neutralSince = undefined;
      return false;
    }

    // A continuous bounce can briefly align rise and velocity after filtering. Require the
    // candidate to stand above its slow amplitude envelope as well as the absolute rise floor;
    // the envelope follows sustained running but does not chase a single takeoff transient.
    // After the crossing, confirmation watches position only: sampled velocity near a threshold
    // is noisy, but a real takeoff keeps climbing, so holding the rise band for 30 ms confirms it.
    if (this.risingSince === undefined) {
      const isProminentAboveBounce = rise >= Math.max(JUMP_MIN_RISE, sample.sustainedOscillationAmplitude * MIN_JUMP_TO_BOUNCE_RATIO);
      if (isProminentAboveBounce && velocityUp >= JUMP_MIN_VELOCITY) this.risingSince = timestampMs;
    } else if (rise < JUMP_MIN_RISE * 0.9) this.risingSince = undefined;

    let fired = false;
    if (!this.airborne && this.risingSince !== undefined && timestampMs - this.risingSince >= TAKEOFF_CONFIRM_MS && timestampMs - this.lastJumpAt >= REFRACTORY_MS) {
      this.airborne = true;
      this.lastJumpAt = timestampMs;
      this.risingSince = undefined;
      fired = true;
    }
    if (this.airborne && (rise <= REARM_RISE_TORSO || timestampMs - this.lastJumpAt >= MAX_AIRBORNE_MS)) this.airborne = false;
    return fired;
  }

  reset(): void {
    this.risingSince = undefined;
    this.airborne = false;
    this.armed = false;
    this.neutralSince = undefined;
    this.lastJumpAt = Number.NEGATIVE_INFINITY;
  }
}
