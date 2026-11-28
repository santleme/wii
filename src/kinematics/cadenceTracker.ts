import { BounceDetector } from './bounce';
import { median } from './math';
import type { TorsoVerticalSample } from './torsoVertical';
import { WalkDetector } from './walk';

/**
 * Running or marching in place keeps the body's weight moving sideways, even when the head and
 * shoulders barely bounce — a player watching the screen stabilizes their upper body, and the
 * movement is irregular drift as much as step-frequency sway. Waving the arms while standing
 * still keeps the weight centered: real clips measure 0.02-0.03 shoulder widths of lateral
 * spread for arm waving against 0.06-0.13 for running. The effort gate opens when vertical
 * bounce is corroborated — either by weight transfer or by rhythmic strides: even violent arm
 * swinging can bounce the torso, but it never shifts the body's weight nor keeps a step rhythm.
 * Once open, either channel holds the gate through flat stretches — but weight transfer alone
 * can only bridge a few seconds without fresh stride evidence, or a sideways shuffle would run
 * the race. The lateral channel never drives cadence speed, so sidesteps don't sprint.
 */
const LATERAL_WINDOW_MS = 1000;
const LATERAL_MIN_SPAN_MS = 500;
/** Between the highest arm-waving stretch (0.033) and the lowest running one (0.052). */
const LATERAL_ACTIVE_SW = 0.042;

/**
 * The locomotion state one result describes, derived in one place from the tracker's evidence.
 * It is not a synonym for `running`: that flag is the effort gate's trust, which stays open
 * through stride gaps and over walking, while the verdict names what the body is doing on
 * this frame —
 * - `idle`: no bounce, no weight-shift walking, no trust held.
 * - `walking`: the weight-shift detector owns the motion and the bounce channel is quiet.
 * - `warming`: the bounce channel says moving, but the trust has not been earned yet.
 * - `running`: moving, with the trust earned.
 * - `bridging`: no motion on this frame, but the trust is still held open through the gap.
 */
export type CadenceVerdict = 'idle' | 'walking' | 'warming' | 'running' | 'bridging';

export interface CadenceResult { cadenceSpm: number; speed01: number; step?: 'left' | 'right'; running: boolean; verdict: CadenceVerdict }

/** Assumed pace until two steps have been timed: a relaxed run in place. */
const DEFAULT_SPM = 150;
const MAX_STEP_INTERVAL_MS = 900;
/** One missed or doubled rise must not swing the speed: the median of these decides. */
const STEPS_AVERAGED = 7;
const ESTABLISHED_RUN_MS = 1000;
/** Walking pace follows the weight shifts, held below the game's running threshold (137.5 steps/min). */
const MIN_WALK_SPM = 70;
const MAX_WALK_SPM = 130;
/**
 * Steps/min to game speed, interpolated. Anchors follow the CADENCE-Adults studies (100 steps/min is a
 * moderate walk; walking turns into running around 135-140). Those were measured moving forward, not in place.
 */
/**
 * A jolt when the player starts moving their arms can fool the bounce verdict for a frame or two
 * (real clips: ~150 ms at 257 spm). Running is only trusted once the verdict persists this long;
 * the trust then holds without flapping through stride gaps.
 */
const RUN_TRUST_MS = 300;
/**
 * Once trusted, the verdict survives weak patches: real running is irregular, and dropping the
 * effort gate for a stride or two cuts the runner's speed mid-race. Closing waits this long
 * without bounce or weight transfer. Arm waving never opens the trust in the first place, and a still body
 * measures no effort even while the trust is open, so the long close only bridges strides.
 */
const RUN_TRUST_HOLD_MS = 2000;
/**
 * Weight transfer may bridge flat stretches between stride bursts, but not sustain the verdict
 * alone: a sideways shuffle is lateral motion too, and without a cap it would renew the trust
 * forever. Real flat jogging shows vertical stride evidence at least this often (the player's
 * own clips gap at most ~4.2 s), while pure shuffling never strides again.
 */
const LATERAL_BRIDGE_CAP_MS = 4500;
/**
 * Rhythm corroborates centered running: bouncing in place with both feet shifts no weight, so
 * the lateral channel stays quiet — but consecutive strides at running cadence are evidence
 * violent arm swinging never produces (one flicker in eight seconds of real clips). The
 * intervals must sit at running pace and near one another: a slow or irregular bob is not a
 * stride however long it persists. 150 spm is a relaxed run in place; the band is generous.
 */
const STRIDES_CORROBORATING = 3;
const STRIDE_MIN_SPM = 120;
const STRIDE_MAX_INTERVAL_MS = 60_000 / STRIDE_MIN_SPM;
const STRIDE_MIN_INTERVAL_MS = 60_000 / 260;
/** Fastest-to-slowest ratio the corroborating strides may span — uneven bobbing is wider. */
const STRIDE_REGULARITY = 1.6;
/**
 * A short sequence can average a slower bob down into the band when timing noise lands in
 * its favor, so averaging alone earns nothing: either the latest strides each read in band, or
 * the longer window has to agree — its quantization error shrinks with every stride added.
 */
const STRIDES_EXTENDED = 5;
const SPEED_BY_CADENCE = [[40, 0.1], [100, 0.3], [137.5, 0.55], [200, 1]] as const;

export function speedFromCadence(spm: number): number {
  if (spm <= 0) return 0;
  let [fromSpm, fromSpeed]: readonly [number, number] = SPEED_BY_CADENCE[0];
  for (const [toSpm, toSpeed] of SPEED_BY_CADENCE) {
    if (spm <= toSpm) return toSpm === fromSpm ? toSpeed : fromSpeed + (toSpeed - fromSpeed) * Math.min(1, Math.max(0, (spm - fromSpm) / (toSpm - fromSpm)));
    [fromSpm, fromSpeed] = [toSpm, toSpeed];
  }
  return fromSpeed;
}

/**
 * Whether the player runs comes from the size of the bounce; how fast comes from the time between
 * rises. Step side cannot be told apart from torso motion, so left/right just alternate.
 */
export class CadenceTracker {
  private readonly bounce = new BounceDetector();
  private readonly walk = new WalkDetector();
  private walking = false;
  private walkSpm = MIN_WALK_SPM;
  private intervals: number[] = [];
  private lastStepAt = Number.NEGATIVE_INFINITY;
  private lastStepSide: 'left' | 'right' = 'right';
  private moving = false;
  private movingSince = Number.POSITIVE_INFINITY;
  private trusted = false;
  private lastMovingAt = Number.NEGATIVE_INFINITY;
  private lastStrideAt = Number.NEGATIVE_INFINITY;
  private lateralWindow: { t: number; x: number; width: number }[] = [];
  private lateralActive = false;
  private suspended = false;
  private ranBeforeJump = false;
  /** Whether the last rise's time is trustworthy enough to measure an interval from. */
  private lastStepWitnessed = false;

  /** `suspend` (a jump in flight) holds the current verdict and ignores the airborne samples. */
  update(sample: TorsoVerticalSample | undefined, nowMs: number, suspend = false): CadenceResult {
    let step: 'left' | 'right' | undefined;
    // A crouch before takeoff can look like running for a moment; only an established run carries
    // through the jump. Decided once, when the jump is first seen.
    if (suspend && !this.suspended) {
      this.ranBeforeJump = this.moving && nowMs - this.movingSince >= ESTABLISHED_RUN_MS;
      this.moving = this.ranBeforeJump;
    }
    this.suspended = suspend;
    let bounceCandidate = false;
    if (suspend) { this.walk.reset(); this.walking = false; }
    if (suspend) this.bounce.forgetJump(nowMs, this.ranBeforeJump);
    if (sample && !suspend) {
      this.lateralWindow.push({ t: sample.timestampMs, x: sample.shoulders.x, width: sample.shoulders.width });
      this.lateralWindow = this.lateralWindow.filter((entry) => sample.timestampMs - entry.t <= LATERAL_WINDOW_MS);
      const span = sample.timestampMs - this.lateralWindow[0]!.t;
      if (span >= LATERAL_MIN_SPAN_MS && this.lateralWindow.length >= 4) {
        const width = this.lateralWindow[Math.floor(this.lateralWindow.length / 2)]!.width;
        const xs = this.lateralWindow.map((entry) => entry.x);
        const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
        const rms = Math.sqrt(xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0) / xs.length) / width;
        if (rms >= LATERAL_ACTIVE_SW) this.lateralActive = true;
        else if (rms < 0.036) this.lateralActive = false;
      }
      const bounce = this.bounce.update(sample.timestampMs, sample.shoulders.left, sample.shoulders.right, sample.shoulders.width, sample.shoulders.head);
      bounceCandidate = bounce.candidate;
      // Right after a jump the window is still filling; the run it interrupted carries on meanwhile.
      this.moving = bounce.moving;
      if (bounce.rise) {
        const interval = bounce.riseAt - this.lastStepAt;
        // After a pause the old pace says nothing about the new one. An interval measured from an
        // unwitnessed rise spans an unknown part of a stride — it starts late, so a slower bob
        // would read deceptively fast.
        if (interval > MAX_STEP_INTERVAL_MS) this.intervals = [];
        else if (this.lastStepWitnessed) this.intervals = [...this.intervals, interval].slice(-STEPS_AVERAGED);
        this.lastStepAt = bounce.riseAt;
        this.lastStepWitnessed = bounce.witnessed;
        if (this.moving) {
          this.lastStepSide = this.lastStepSide === 'left' ? 'right' : 'left';
          step = this.lastStepSide;
        }
      }
      const { left, right, width, x } = sample.shoulders;
      const { head } = sample.shoulders;
      const walk = this.walk.update(sample.timestampMs, x, Number.isFinite(head) ? head : (left + right) / 2, width);
      this.walking = walk.walking;
      if (walk.walking && walk.spm > 0) {
        const spm = Math.min(MAX_WALK_SPM, Math.max(MIN_WALK_SPM, walk.spm));
        // Eased so a change of pace does not jerk the runner.
        this.walkSpm += (spm - this.walkSpm) * 0.08;
      }
      if (walk.step && !this.moving) {
        this.lastStepSide = this.lastStepSide === 'left' ? 'right' : 'left';
        step = this.lastStepSide;
      }
    } else if (!suspend) {
      this.moving = this.bounce.isMoving(nowMs);
      this.walking = false;
    }
    // A rise long gone says nothing now; without this the stale history would corroborate any
    // single torso jolt back into running. The pace estimate keeps resetting on the next rise.
    if (nowMs - this.lastStepAt > MAX_STEP_INTERVAL_MS) this.intervals = [];
    this.movingSince = this.moving ? Math.min(this.movingSince, nowMs) : Number.POSITIVE_INFINITY;
    if (this.moving) this.lastStrideAt = nowMs;
    // Sustained weight transfer with any vertical bounce at all is running; only lateral sway with a
    // truly flat torso must hit the bridge cap. Weak candidacy never fires for sway — the together
    // test sees the shoulders tilt against each other — so corroborated this way it is honest.
    if (bounceCandidate && this.lateralActive) this.lastStrideAt = nowMs;
    if (this.moving || this.lateralActive) this.lastMovingAt = nowMs;
    // Corroboration judges the latest strides alone, never the whole speed history: a slow or
    // uneven start must not delay the verdict once the rhythm is real. Every interval in the
    // record spans a full stride — one measured from an unwitnessed rise never enters it — so a
    // reading strictly inside the band is honest evidence of running pace. The fast path takes
    // three such readings; when admission rests on the average instead, the extended window must
    // agree — the span over more strides absorbs the timing noise a short one cannot.
    const inBand = (interval: number) => interval >= STRIDE_MIN_INTERVAL_MS && interval <= STRIDE_MAX_INTERVAL_MS;
    // A boundary reading alone is no evidence: a slower bob can read exactly the
    // cutoff, so the fast path needs at least one reading strictly below it — something a
    // slower bob can never produce — while the rest may sit anywhere inside the band.
    const strictlyInBand = (interval: number) => interval > STRIDE_MIN_INTERVAL_MS && interval < STRIDE_MAX_INTERVAL_MS;
    const meanOf = (list: readonly number[]) => list.reduce((sum, interval) => sum + interval, 0) / list.length;
    const regular = (list: readonly number[]) => Math.max(...list) <= Math.min(...list) * STRIDE_REGULARITY;
    const recentStrides = this.intervals.slice(-STRIDES_CORROBORATING);
    const extendedStrides = this.intervals.slice(-STRIDES_EXTENDED);
    const strideEvidence = recentStrides.length >= STRIDES_CORROBORATING
      && regular(recentStrides)
      && inBand(meanOf(recentStrides))
      && ((recentStrides.every(inBand) && recentStrides.some(strictlyInBand))
        || (extendedStrides.length >= STRIDES_EXTENDED && inBand(meanOf(extendedStrides)) && regular(extendedStrides)));
    if ((!this.moving && !this.lateralActive && nowMs - this.lastMovingAt >= RUN_TRUST_HOLD_MS)
      || nowMs - this.lastStrideAt >= LATERAL_BRIDGE_CAP_MS) this.trusted = false;
    else if (!this.trusted && this.moving && nowMs - this.movingSince >= RUN_TRUST_MS
      && (this.lateralActive || strideEvidence)) this.trusted = true;
    // Running wins: its bounce also sways.
    if (!this.moving) return this.walking
      ? { cadenceSpm: this.walkSpm, speed01: speedFromCadence(this.walkSpm), step, running: this.trusted, verdict: this.verdict() }
      : { cadenceSpm: 0, speed01: 0, step, running: this.trusted, verdict: this.verdict() };
    const cadenceSpm = this.intervals.length ? 60_000 / median(this.intervals) : DEFAULT_SPM;
    return { cadenceSpm, speed01: speedFromCadence(cadenceSpm), step, running: this.trusted, verdict: this.verdict() };
  }

  /** The one place the internal evidence becomes a named state; see CadenceVerdict. */
  private verdict(): CadenceVerdict {
    if (this.moving) return this.trusted ? 'running' : 'warming';
    if (this.walking) return 'walking';
    return this.trusted ? 'bridging' : 'idle';
  }

  reset(): void {
    this.bounce.reset();
    this.walk.reset();
    this.walking = false;
    this.walkSpm = MIN_WALK_SPM;
    this.intervals = [];
    this.lastStepAt = Number.NEGATIVE_INFINITY;
    this.lastStepSide = 'right';
    this.moving = false;
    this.movingSince = Number.POSITIVE_INFINITY;
    this.trusted = false;
    this.lastMovingAt = Number.NEGATIVE_INFINITY;
    this.lastStrideAt = Number.NEGATIVE_INFINITY;
    this.lateralWindow = [];
    this.lateralActive = false;
    this.suspended = this.ranBeforeJump = this.lastStepWitnessed = false;
  }
}
