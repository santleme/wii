/**
 * Raw running effort: simply how much they move per second. Vertical speed of the
 * wrists (relative to the shoulders) plus that of the head, in shoulder widths, so distance to the
 * camera cancels out. It grows with both the pace and the size of the movement. A bounce shared
 * by the head and shoulders also registers when arm movement is small or the wrists are out of view.
 *
 * Real recordings, shoulder widths per second: standing 0.02–0.3, walking up to 0.7, running 1.2–2.8.
 * Chosen on one player; each race also learns the player's own maximum in the warm-up.
 */
const REST_SPEED = 0.35;
const REFERENCE_SPEED = 3.5;
/** The torso moves less than the arms, so give a confirmed bounce more weight. */
const BOUNCE_GAIN = 3;
/**
 * Marching or running flat shifts the body's weight sideways even when nothing moves vertically:
 * the torso's lateral speed is real exertion the vertical channels miss. It only counts when the
 * gate is already open, so arm waving — where the weight stays centered — never reaches it.
 */
const LATERAL_GAIN = 1;
/** Landmark jitter is fast and tiny: smoothing the positions removes most of its apparent speed. */
const POSITION_SMOOTHING_MS = 80;
const AVERAGE_MS = 1000;
const ATTACK_MS = 300;
const RELEASE_MS = 700;
/** A longer hole than this means the two positions are not one movement. */
const MAX_FRAME_GAP_MS = 250;

/** Heights in the shoulder width's units; a wrist out of view is NaN. `x` is the torso's lateral position. */
export interface Body { head: number; shoulders: number; width: number; leftWrist: number; rightWrist: number; x: number }

export class IntensityMeter {
  private previous?: { t: number; positions: number[] };
  private speeds: { t: number; value: number }[] = [];
  private level = 0;
  private at?: number;
  private measuredAtMs: number | null = null;

  get sampleAtMs(): number | null { return this.measuredAtMs; }

  /**
   * One frame; `body` is undefined when the player cannot be read, and the level then fades.
   * `moving` is the torso-bounce verdict: without it the movement is not running (arms waved
   * in place reach the same speeds), so it feeds nothing — the level fades through the normal
   * release instead of a hard cut, and reopens without a step when the bounce returns.
   */
  update(t: number, body?: Body, moving = true): number {
    const speed = body && moving ? this.measure(t, body) : undefined;
    if (!body || !moving) this.previous = undefined;
    if (speed === undefined) {
      this.speeds.length = 0;
    } else {
      // Start the new motion estimate without carrying faded effort into fresh measurements.
      if (this.speeds.length === 0) this.level = 0;
      this.measuredAtMs = t;
      this.speeds.push({ t, value: speed });
      this.speeds = this.speeds.filter((sample) => t - sample.t <= AVERAGE_MS);
    }
    const mean = this.speeds.length ? this.speeds.reduce((sum, sample) => sum + sample.value, 0) / this.speeds.length : 0;
    const raw = Math.max(0, (mean - REST_SPEED) / (REFERENCE_SPEED - REST_SPEED));
    const dt = this.at === undefined ? 0 : Math.max(0, t - this.at);
    this.at = t;
    this.level += (raw - this.level) * (1 - Math.exp(-dt / (raw > this.level ? ATTACK_MS : RELEASE_MS)));
    return this.level;
  }

  private measure(t: number, { head, shoulders, width, leftWrist, rightWrist, x }: Body): number | undefined {
    const positions = [head, shoulders, leftWrist - shoulders, rightWrist - shoulders, x];
    const previous = this.previous;
    const dt = previous ? t - previous.t : 0;
    if (!previous || dt <= 0 || dt > MAX_FRAME_GAP_MS) {
      this.previous = { t, positions };
      return undefined;
    }
    const alpha = 1 - Math.exp(-dt / POSITION_SMOOTHING_MS);
    const smoothed = positions.map((now, i) => {
      const before = previous.positions[i]!;
      return Number.isFinite(before) ? before + (now - before) * alpha : now;
    });
    const velocity = smoothed.map((now, i) => (now - previous.positions[i]!) / width / (dt / 1000));
    const [headVelocity = Number.NaN, shoulderVelocity = Number.NaN, leftHand = Number.NaN, rightHand = Number.NaN, lateralVelocity = Number.NaN] = velocity;
    const hands = [leftHand, rightHand];
    const seen = hands.filter(Number.isFinite);
    const headSpeed = Number.isFinite(headVelocity) ? Math.abs(headVelocity) : 0;
    const armSpeed = seen.length ? seen.reduce((sum, speed) => sum + Math.abs(speed), 0) / seen.length : 0;
    const bounce = headVelocity * shoulderVelocity > 0 ? Math.min(headSpeed, Math.abs(shoulderVelocity)) : 0;
    const lateralSpeed = Number.isFinite(lateralVelocity) ? Math.abs(lateralVelocity) * LATERAL_GAIN : 0;
    this.previous = { t, positions: smoothed };
    return Number.isFinite(headVelocity) || seen.length > 0 ? Math.max(headSpeed + armSpeed, bounce * BOUNCE_GAIN) + lateralSpeed : undefined;
  }

  reset(): void { this.previous = this.at = undefined; this.measuredAtMs = null; this.speeds = []; this.level = 0; }
}
