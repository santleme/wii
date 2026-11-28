import type { CalibrationProfile, PoseSnapshot } from '@wii/spatial-core';
import { OneEuroFilter } from '@wii/spatial-core';
import { clamp, median, midpoint } from './math';

const MIN_SHOULDER_WIDTH = 0.03;
const MIN_TORSO_HEIGHT = 0.03;
/** The width used as the unit never drops below this share of the recently observed width. */
const WIDTH_FLOOR_RATIO = 0.9;
/** How fast the observed width follows shoulders that stay narrower, e.g. after stepping back. */
const WIDTH_DECAY_MS = 3000;
/**
 * Into a side lane past this displacement, in shoulder widths. A real recording put players coming
 * "back to center" up to 0.26 away from where they started, and deliberate side steps at 0.75–1.0.
 */
export const ENTER_LANE_SW = 0.35;
/** Back to center inside this displacement — the hysteresis gap keeps zone noise from flapping lanes. */
export const EXIT_LANE_SW = 0.2;
/** The center is wherever the player stands still this long, within this spread (shoulder widths). */
const CENTER_STILL_MS = 1000;
const CENTER_STILL_SPREAD_SW = 0.1;
/** Standing still at a clearly different size means the player moved nearer or farther: measure again. */
const RECENTER_SCALE_CHANGE = 0.2;

/**
 * Lane control by body position, not gesture: the lane follows where the player's torso actually
 * is, continuously — lean the trunk or step sideways, both move the shoulder center the same way.
 * Measured from where the player stood still, in the frame's own shoulder widths, positive
 * toward the player's right: in raw camera coordinates the player's right is toward image left,
 * so rightward displacement is center − centerX. Position cannot invert the way an
 * edge-triggered lean gesture did — returning to center at worst leaves the side lane, and
 * snap-back overshoot past center is just noise below the opposite threshold.
 */
export class LanePositionTracker {
  private readonly filter = new OneEuroFilter({ minCutoff: 1.2, beta: 0.4, derivativeCutoff: 1 });
  private zone: -1 | 0 | 1 = 0;
  private center?: { x: number; width: number };
  private recent: { t: number; x: number; width: number }[] = [];

  /** The lane zone the body occupies; undefined until a center exists or when shoulders are unreadable. */
  update(snapshot: PoseSnapshot): -1 | 0 | 1 | undefined {
    const leftShoulder = snapshot.landmarks[11];
    const rightShoulder = snapshot.landmarks[12];
    if (!leftShoulder || !rightShoulder) return undefined;
    // x is normalized by frame width and y by frame height independently, so a raw hypot would
    // mix units: in landscape frames the y contribution is over-weighted and the measured width
    // would inflate as the shoulders tilt in-plane — exactly while the player leans to dodge.
    const aspect = snapshot.frameHeight / snapshot.frameWidth;
    const width = Math.hypot(leftShoulder.x - rightShoulder.x, (leftShoulder.y - rightShoulder.y) * aspect);
    if (!Number.isFinite(width) || width < MIN_SHOULDER_WIDTH) return undefined;
    const centerX = (leftShoulder.x + rightShoulder.x) / 2;
    if (!Number.isFinite(centerX)) return undefined;
    this.measureCenter(snapshot.timestampMs, centerX, width);
    if (!this.center) return undefined;
    const displacement = (this.center.x - centerX) / width;
    const u = this.filter.filter(displacement, snapshot.timestampMs);
    if (this.zone === 0) {
      if (u >= ENTER_LANE_SW) this.zone = 1;
      else if (u <= -ENTER_LANE_SW) this.zone = -1;
    } else if (this.zone === 1 && u <= EXIT_LANE_SW) this.zone = 0;
    else if (this.zone === -1 && u >= -EXIT_LANE_SW) this.zone = 0;
    return this.zone;
  }

  /** The zone the state machine currently believes the body occupies — even while updates pause. */
  get currentZone(): -1 | 0 | 1 { return this.zone; }

  reset(): void { this.filter.reset(); this.zone = 0; this.center = undefined; this.recent = []; }

  /** Sets the center once; it then stays put, so holding a side lane can never drag it along. */
  private measureCenter(t: number, x: number, width: number): void {
    const previous = this.recent.at(-1);
    if (previous && t - previous.t > 200) this.recent = [];
    this.recent.push({ t, x, width });
    while (this.recent.length > 1 && t - this.recent[1]!.t >= CENTER_STILL_MS) this.recent.shift();
    if (t - this.recent[0]!.t < CENTER_STILL_MS) return;
    const xs = this.recent.map((sample) => sample.x);
    const stillWidth = median(this.recent.map((sample) => sample.width));
    if ((Math.max(...xs) - Math.min(...xs)) / stillWidth > CENTER_STILL_SPREAD_SW) return;
    if (this.center && Math.abs(stillWidth / this.center.width - 1) <= RECENTER_SCALE_CHANGE) return;
    this.center = { x: median(xs), width: stillWidth };
    this.filter.reset();
    this.zone = 0;
  }
}

/**
 * Aspect-corrected distance in frame widths. x is normalized by frame width and y by frame height
 * independently, so a raw hypot would mix units: in landscape frames the y contribution is
 * over-weighted and the shoulder width would inflate as the shoulders tilt in-plane — exactly
 * while the player leans to dodge.
 */
function imageSpan(a: { x: number; y: number }, b: { x: number; y: number }, snapshot: PoseSnapshot): number {
  return Math.hypot(a.x - b.x, (a.y - b.y) * (snapshot.frameHeight / snapshot.frameWidth));
}

/** The frame's shoulder width, or undefined when the shoulders are unreadable. */
function shoulderSpan(snapshot: PoseSnapshot): number | undefined {
  const left = snapshot.landmarks[11];
  const right = snapshot.landmarks[12];
  if (!left || !right) return undefined;
  const width = imageSpan(left, right, snapshot);
  return Number.isFinite(width) && width >= MIN_SHOULDER_WIDTH ? width : undefined;
}

/**
 * The shoulder width used as the unit for lateral displacement. Torso yaw (a punch) foreshortens
 * the shoulder line for a moment; dividing by that narrow width would inflate a small sway into a
 * big move, so the unit is floored by the widest recent width.
 */
export class ShoulderUnit {
  /** Widest recent shoulder width, decaying toward the current one. */
  private reference?: { width: number; atMs: number };

  update(snapshot: PoseSnapshot): number | undefined {
    const width = shoulderSpan(snapshot);
    if (width === undefined) return undefined;
    const elapsedMs = this.reference ? Math.max(0, snapshot.timestampMs - this.reference.atMs) : 0;
    const decayed = this.reference ? width + (this.reference.width - width) * Math.exp(-elapsedMs / WIDTH_DECAY_MS) : width;
    const reference = Math.max(width, decayed);
    this.reference = { width: reference, atMs: snapshot.timestampMs };
    return Math.max(width, reference * WIDTH_FLOOR_RATIO);
  }

  reset(): void { this.reference = undefined; }
}

/** Into a dodge past this displacement, in shoulder widths — a deliberate but comfortable lean. */
export const ENTER_DODGE_SW = 0.12;
/** Back to center inside this displacement. */
export const EXIT_DODGE_SW = 0.05;

/**
 * Boxing's dodge: far more sensitive than lane control and measured from the calibrated neutral,
 * since a boxer leans out of a punch's way instead of stepping to another lane.
 */
export class DodgeZoneTracker {
  private readonly filter = new OneEuroFilter({ minCutoff: 1.2, beta: 0.4, derivativeCutoff: 1 });
  private zone: -1 | 0 | 1 = 0;
  private readonly unit = new ShoulderUnit();

  /** The dodge zone the body currently occupies, or undefined when the shoulders are unreadable. */
  update(snapshot: PoseSnapshot, calibration: CalibrationProfile): -1 | 0 | 1 | undefined {
    const leftShoulder = snapshot.landmarks[11];
    const rightShoulder = snapshot.landmarks[12];
    const unit = this.unit.update(snapshot);
    if (!leftShoulder || !rightShoulder || unit === undefined) return undefined;
    const centerX = (leftShoulder.x + rightShoulder.x) / 2;
    const displacement = (calibration.image.shoulderCenterX0 - centerX) / unit;
    const u = this.filter.filter(displacement, snapshot.timestampMs);
    if (this.zone === 0) {
      if (u >= ENTER_DODGE_SW) this.zone = 1;
      else if (u <= -ENTER_DODGE_SW) this.zone = -1;
    } else if (this.zone === 1 && u <= EXIT_DODGE_SW) this.zone = 0;
    else if (this.zone === -1 && u >= -EXIT_DODGE_SW) this.zone = 0;
    return this.zone;
  }

  /** The zone the state machine currently believes the body occupies — even while updates pause. */
  get currentZone(): -1 | 0 | 1 { return this.zone; }

  reset(): void { this.filter.reset(); this.zone = 0; this.unit.reset(); }
}

/** Step in past these width ratios to the calibrated one; return to neutral inside the inner pair. */
const ENTER_NEAR_RATIO = 1.15;
const EXIT_NEAR_RATIO = 1.07;
const ENTER_FAR_RATIO = 0.85;
const EXIT_FAR_RATIO = 0.93;
/** A step has to outlast a momentary change of apparent size. */
const DEPTH_HOLD_MS = 300;
/** Size change that reads as no approach speed, and the one that reads as full speed. */
export const DEPTH_DEAD_BAND = 0.07;
export const DEPTH_FULL_SPEED = 0.25;
/** Readings after calibration that settle the torso reference. */
const TORSO_REFERENCE_SAMPLES = 10;

/**
 * How much closer than calibrated the body looks. A step scales width and height together; torso
 * yaw narrows only the shoulders and a waist bend shortens only the torso. So only the change both
 * measures agree on counts: the smaller one when they agree on direction, none when they do not.
 */
function agreedSizeRatio(widthRatio: number, torsoRatio: number): number {
  if (widthRatio > 1 && torsoRatio > 1) return Math.min(widthRatio, torsoRatio);
  if (widthRatio < 1 && torsoRatio < 1) return Math.max(widthRatio, torsoRatio);
  return 1;
}

/**
 * Depth control by apparent size: a body bigger than at the calibrated neutral means the player
 * stepped toward the camera (1), smaller means they stepped back (-1).
 */
export class RingDepthTracker {
  // MediaPipe VIDEO mode already smooths the landmarks: this filter stays light to avoid lag.
  private readonly filter = new OneEuroFilter({ minCutoff: 3, beta: 1, derivativeCutoff: 1 });
  private move: -1 | 0 | 1 = 0;
  private speed?: number;
  /** When the size first left the dead band; speed stays 0 until that has lasted DEPTH_HOLD_MS. */
  private outsideSinceMs?: number;
  private outsideSign = 0;
  private pending?: { move: -1 | 1; sinceMs: number };
  /** The profile has no torso reference: derived from the first readings against its width. */
  private torso?: { widthReference: number; samples: number[] };

  /**
   * The current step, or undefined without a reference width or a readable torso. While `punching`
   * the step and the approach speed hold their last values.
   */
  update(snapshot: PoseSnapshot, calibration: CalibrationProfile, punching = false): -1 | 0 | 1 | undefined {
    const reference = calibration.image.shoulderWidth0;
    const width = shoulderSpan(snapshot);
    const [leftShoulder, rightShoulder, leftHip, rightHip] = [11, 12, 23, 24].map((index) => snapshot.landmarks[index]);
    if (!reference || width === undefined || !leftShoulder || !rightShoulder || !leftHip || !rightHip) return undefined;
    const torsoHeight = imageSpan(midpoint(leftShoulder, rightShoulder), midpoint(leftHip, rightHip), snapshot);
    if (!Number.isFinite(torsoHeight) || torsoHeight < MIN_TORSO_HEIGHT) return undefined;
    if (punching) {
      // A step or a speed still waiting out its hold must not count the punch as time held; a speed
      // already established carries on after it.
      this.pending = undefined;
      if (!this.speed) this.outsideSinceMs = undefined;
      return this.move;
    }
    if (this.torso?.widthReference !== reference) this.torso = { widthReference: reference, samples: [] };
    // Scaled to the calibrated distance, so a player mid-step on these frames does not skew it.
    if (this.torso.samples.length < TORSO_REFERENCE_SAMPLES) this.torso.samples.push(torsoHeight * reference / width);
    const ratio = this.filter.filter(agreedSizeRatio(width / reference, torsoHeight / median(this.torso.samples)), snapshot.timestampMs);
    const offset = ratio - 1;
    // A brief change of apparent size (a lean, a turn) must not walk the player: same dwell as the step.
    const outside = Math.abs(offset) > DEPTH_DEAD_BAND;
    // Jumping across the band to the other side is a new direction, with its own dwell.
    if (!outside || Math.sign(offset) !== this.outsideSign) this.outsideSinceMs = undefined;
    this.outsideSign = outside ? Math.sign(offset) : 0;
    if (outside) this.outsideSinceMs ??= snapshot.timestampMs;
    this.speed = !outside || snapshot.timestampMs - this.outsideSinceMs! < DEPTH_HOLD_MS
      ? 0
      : Math.sign(offset) * clamp((Math.abs(offset) - DEPTH_DEAD_BAND) / (DEPTH_FULL_SPEED - DEPTH_DEAD_BAND));
    if ((this.move === 1 && ratio <= EXIT_NEAR_RATIO) || (this.move === -1 && ratio >= EXIT_FAR_RATIO)) this.move = 0;
    const wanted = ratio >= ENTER_NEAR_RATIO ? 1 : ratio <= ENTER_FAR_RATIO ? -1 : undefined;
    if (wanted === undefined || wanted === this.move) this.pending = undefined;
    else {
      if (this.pending?.move !== wanted) this.pending = { move: wanted, sinceMs: snapshot.timestampMs };
      if (snapshot.timestampMs - this.pending.sinceMs >= DEPTH_HOLD_MS) {
        this.move = wanted;
        this.pending = undefined;
      }
    }
    return this.move;
  }

  /** Signed approach speed -1..1 as of the last unfrozen reading, positive toward the camera. */
  get approach01(): number | undefined { return this.speed; }

  reset(): void { this.filter.reset(); this.move = 0; this.speed = undefined; this.outsideSinceMs = undefined; this.outsideSign = 0; this.pending = undefined; this.torso = undefined; }
}

/** The shoulder line moving vertically faster than this, in image shoulder widths per second,
 * means the torso reference frame itself is in fast motion — wrist measurements relative to it
 * are dominated by the torso, not the arm, so punch onsets are vetoed while it lasts. A duck
 * drop peaks around 1-2 sw/s; punching barely moves the shoulders vertically. */
export const REFERENCE_VETO_SPEED_SW_PER_S = 0.7;

/**
 * Vertical speed of the shoulder-line midpoint in image space, normalized by shoulder width —
 * the same space the duck is measured in, because world landmarks are hip-origin and a crouch
 * moves the origin with the shoulders. Positive is descending. Light filtering only: a duck
 * drop spans a handful of frames and heavy smoothing would both miss it and outlast it.
 */
export class ShoulderLineVerticalSpeed {
  private readonly filter = new OneEuroFilter({ minCutoff: 2, beta: 0.5, derivativeCutoff: 1 });
  private previous?: { y: number; t: number };
  private readonly unit = new ShoulderUnit();

  /** Speed in shoulder widths per second; undefined while the shoulders or scale are unreadable. */
  update(snapshot: PoseSnapshot): number | undefined {
    const leftShoulder = snapshot.landmarks[11];
    const rightShoulder = snapshot.landmarks[12];
    const width = this.unit.update(snapshot);
    if (!leftShoulder || !rightShoulder || width === undefined) return undefined;
    const aspect = snapshot.frameHeight / snapshot.frameWidth;
    const raw = ((leftShoulder.y + rightShoulder.y) / 2) * aspect / width;
    if (!Number.isFinite(raw)) return undefined;
    const y = this.filter.filter(raw, snapshot.timestampMs);
    const previous = this.previous;
    this.previous = { y, t: snapshot.timestampMs };
    if (!previous) return undefined;
    const dt = (snapshot.timestampMs - previous.t) / 1000;
    if (dt <= 0 || dt > 0.3) return undefined;
    return (y - previous.y) / dt;
  }

  reset(): void { this.filter.reset(); this.previous = undefined; this.unit.reset(); }
}

/** Into a duck past this drop below the standing baseline, in shoulder widths. */
export const ENTER_DUCK_SW = 0.18;
/** Back up inside this drop — the hysteresis gap keeps a crouched bob from flapping. */
export const EXIT_DUCK_SW = 0.1;
/** The standing baseline comes only from readings this still, held this long. */
const DUCK_BASELINE_STILL_MS = 800;
const DUCK_BASELINE_STILL_SPREAD_SW = 0.05;

/**
 * Boxing's duck: a fast, reversible vertical drop of the shoulder line below the player's own
 * standing baseline. Measured in image space, not world landmarks — the world frame is
 * hip-origin, so a crouch lowers the origin with the shoulders and the drop vanishes. The
 * baseline is measured from frames where the player stands still, the same philosophy as the
 * lane center: a player who starts out crouched is simply standing there. Frozen while a punch
 * is in flight, since punching dips the shoulder line on its own.
 */
export class DuckTracker {
  private readonly filter = new OneEuroFilter({ minCutoff: 1.5, beta: 0.5, derivativeCutoff: 1 });
  private ducked = false;
  private baseline?: number;
  private readonly unit = new ShoulderUnit();
  private recent: { t: number; y: number }[] = [];

  /**
   * Whether the body is currently ducked, or undefined when the shoulders are unreadable or
   * no standing baseline exists yet. While `punching`, the last state holds.
   */
  update(snapshot: PoseSnapshot, punching = false): boolean | undefined {
    const leftShoulder = snapshot.landmarks[11];
    const rightShoulder = snapshot.landmarks[12];
    const width = this.unit.update(snapshot);
    if (!leftShoulder || !rightShoulder || width === undefined) return undefined;
    if (punching) return this.ducked;
    // y is normalized by frame height but x by frame width: rescale y into frame-width units
    // so the drop is measured in the same shoulder widths as the dodge displacement.
    const aspect = snapshot.frameHeight / snapshot.frameWidth;
    const y = ((leftShoulder.y + rightShoulder.y) / 2) * aspect / width;
    if (!Number.isFinite(y)) return undefined;
    this.measureBaseline(snapshot.timestampMs, y);
    if (this.baseline === undefined) return undefined;
    const drop = this.filter.filter(y - this.baseline, snapshot.timestampMs);
    if (!this.ducked && drop >= ENTER_DUCK_SW) this.ducked = true;
    else if (this.ducked && drop <= EXIT_DUCK_SW) this.ducked = false;
    return this.ducked;
  }

  /** The duck state the tracker currently believes — even while updates pause. */
  get current(): boolean { return this.ducked; }

  reset(): void { this.filter.reset(); this.ducked = false; this.baseline = undefined; this.recent = []; this.unit.reset(); }

  /**
   * The standing baseline comes from stillness, exactly like the lane center. While ducked the
   * baseline never updates — a held duck must not drag it down and erase itself.
   */
  private measureBaseline(t: number, y: number): void {
    const previous = this.recent.at(-1);
    if (previous && t - previous.t > 200) this.recent = [];
    this.recent.push({ t, y });
    while (this.recent.length > 1 && t - this.recent[1]!.t >= DUCK_BASELINE_STILL_MS) this.recent.shift();
    if (t - this.recent[0]!.t < DUCK_BASELINE_STILL_MS) return;
    const ys = this.recent.map((sample) => sample.y);
    if (Math.max(...ys) - Math.min(...ys) > DUCK_BASELINE_STILL_SPREAD_SW) return;
    const still = median(ys);
    if (this.baseline === undefined) this.baseline = still;
    else if (!this.ducked) this.baseline += (still - this.baseline) * 0.2;
  }
}
