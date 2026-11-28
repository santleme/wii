/**
 * Is the player running? Judged only by how much both shoulders bounce over one second, in shoulder
 * widths. Real recordings: standing 0.001–0.011, swinging only the arms 0.003–0.020, running in
 * place 0.045–0.14. Jumps are the jump detector's business: judging them
 * here by size too stopped the runner for seconds after every jump taken mid-run. Real running is irregular, so no rhythm is required.
 */
const WINDOW_MS = 1000;
const MIN_SPAN_MS = 600;
const MIN_SPREAD_SW = 0.03;
const JUMP_LOCKOUT_MS = 1200;
/** Both shoulders must move together, which independent landmark jitter and one-arm waving do not. */
const MIN_TOGETHER = 0.65;
/**
 * Once strides confirm, the verdict outlives weak patches: real running is irregular, and a
 * borderline stride or a noisy stretch must not drop it within a step or two. This is safe
 * because candidates never fire for arm waving at all — the together/head tests see to that —
 * and because a genuinely still body reads flat in the quiet window long before this expires.
 */
const HOLD_MS = 300;
/**
 * Running carries the head along; swinging the arms hard moves the shoulders under a steadier head.
 * Chosen on one player's recordings: 0.45 still let arms through (7%), 0.55 nearly stopped them
 * (2%, the fallback if other people lose their run), and the lowest running windows sat near 0.71.
 */
const MIN_HEAD_RATIO = 0.65;
/** Running heads measured 0.054–0.097; walking with big arm swings stayed under 0.028 at its p90. */
const MIN_HEAD_SPREAD_SW = 0.035;
/** A jump passes through running-sized bounces on its way up; only a run stays there. */
const SUSTAIN_MS = 200;
/** A noisy frame or two does not restart the wait. */
const CANDIDATE_GAP_MS = 100;
/** A run confirmed this recently (a tracking hole, a stumble) resumes without waiting again. */
const RESUME_MS = 1000;
/** The long window remembers the last strides; a flat recent stretch means the player already stopped. */
const QUIET_WINDOW_MS = 450;
const QUIET_SPREAD_SW = 0.012;
const MIN_STEP_INTERVAL_MS = 220;

type Sample = { t: number; left: number; right: number; head: number };

/** Removes the straight-line trend, so walking nearer or settling does not count as bouncing. */
function detrend(times: readonly number[], values: readonly number[]): number[] {
  const mean = (list: readonly number[]) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const t0 = mean(times), v0 = mean(values);
  let top = 0, bottom = 0;
  for (const [i, t] of times.entries()) { top += (t - t0) * (values[i]! - v0); bottom += (t - t0) ** 2; }
  const slope = bottom > 0 ? top / bottom : 0;
  return values.map((value, i) => value - v0 - slope * (times[i]! - t0));
}

/** Peak-to-peak travel of the shoulder midpoint. */
function moved(samples: readonly Sample[]): number {
  const mids = samples.map((sample) => (sample.left + sample.right) / 2);
  return mids.length > 1 ? Math.max(...mids) - Math.min(...mids) : 0;
}

/** `rise` marks one stride's upward crossing, timed even before the run is confirmed. `riseAt` is
 * when the body crossed, interpolated between the two frames around it: frame timestamps alone are up
 * to a frame late, enough to pass a slow bob off as a stride. `witnessed` is false when the body was
 * already above at the first look, so the crossing's time is unknown. `candidate` is the raw per-frame window verdict before any sustain or hold: weak but honest evidence — the
 * together and head tests mean swaying without bouncing never produces it. */
export interface Bounce { moving: boolean; rise: boolean; riseAt: number; witnessed: boolean; candidate: boolean }

export class BounceDetector {
  private samples: Sample[] = [];
  private until = Number.NEGATIVE_INFINITY;
  private blockedUntil = Number.NEGATIVE_INFINITY;
  private above = false;
  private candidateSince?: number;
  private candidateAt = Number.NEGATIVE_INFINITY;
  private lastRiseAt = Number.NEGATIVE_INFINITY;

  /** Heights are image y (growing downward) in the same units as the shoulder width. */
  update(t: number, left: number, right: number, width: number, head: number): Bounce {
    this.samples.push({ t, left, right, head });
    this.samples = this.samples.filter((sample) => t - sample.t <= WINDOW_MS);
    if (t - this.samples[0]!.t < MIN_SPAN_MS) return { moving: this.isMoving(t), rise: false, riseAt: t, witnessed: false, candidate: false };
    const times = this.samples.map((sample) => sample.t);
    const l = detrend(times, this.samples.map((sample) => sample.left));
    const r = detrend(times, this.samples.map((sample) => sample.right));
    let lr = 0, ll = 0, rr = 0, mid = 0;
    for (const [i, a] of l.entries()) { const b = r[i]!; lr += a * b; ll += a * a; rr += b * b; mid += ((a + b) / 2) ** 2; }
    const spread = Math.sqrt(mid / l.length) / width;
    const together = ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : 0;
    const recent = this.samples.filter((sample) => t - sample.t <= QUIET_WINDOW_MS);
    // Old strides alone prove nothing: the body must also be moving in the latest frames.
    const h = detrend(times, this.samples.map((sample) => sample.head));
    const headSpread = Math.sqrt(h.reduce((sum, value) => sum + value * value, 0) / h.length) / width;
    // A head that cannot be read (NaN) does not veto: the shoulders still decide.
    const candidate = !(headSpread < MIN_HEAD_SPREAD_SW) && !(headSpread < spread * MIN_HEAD_RATIO) && spread >= MIN_SPREAD_SW && together >= MIN_TOGETHER && moved(recent) / width >= QUIET_SPREAD_SW;
    if (candidate) {
      if (this.candidateSince === undefined || t - this.candidateAt > CANDIDATE_GAP_MS) this.candidateSince = t;
      this.candidateAt = t;
      // Entering takes persistence; a run confirmed moments ago stays confirmed on any good frame.
      if (t - this.until <= RESUME_MS || t - this.candidateSince >= SUSTAIN_MS) this.until = t + HOLD_MS;
    }

    const recentTimes = recent.map((sample) => sample.t);
    const recentMid = detrend(recentTimes, recent.map((sample) => (sample.left + sample.right) / 2));
    // Two frames straddling a tracking hole always look flat after detrending, so they prove nothing.
    const quiet = recent.length >= 4 && t - recentTimes[0]! >= QUIET_WINDOW_MS * 0.7
      && Math.sqrt(recentMid.reduce((sum, value) => sum + value * value, 0) / recentMid.length) / width < QUIET_SPREAD_SW;
    if (quiet) this.until = Number.NEGATIVE_INFINITY;

    // One step per rise through the window's middle (image y falls as the body rises).
    const height = -(l.at(-1)! + r.at(-1)!) / 2 / width;
    let rise = false, witnessed = false, riseAt = t;
    if (!this.above && height > spread / 2) {
      this.above = true;
      // The previous frame, read against this window's trend and threshold.
      const before = -(l.at(-2)! + r.at(-2)!) / 2 / width;
      witnessed = before <= spread / 2;
      if (witnessed) riseAt = times.at(-2)! + (t - times.at(-2)!) * (spread / 2 - before) / (height - before);
      // Spaced on the same basis cadence is measured on: frame times can bunch two real strides closer
      // than the floor. An unwitnessed crossing falls back to its frame time.
      if (spread >= MIN_SPREAD_SW && riseAt - this.lastRiseAt >= MIN_STEP_INTERVAL_MS) { rise = true; this.lastRiseAt = riseAt; }
    } else if (this.above && height < -spread / 2) this.above = false;
    return { moving: this.isMoving(t), rise, riseAt, witnessed, candidate };
  }

  isMoving(t: number): boolean { return t <= this.until && t > this.blockedUntil; }

  /**
   * A jump was recognised: its flight must not linger in the window or keep the run locked out.
   * A run in progress stays confirmed while the emptied window refills; a jump from standing keeps
   * the landing from reading as the first strides of a run.
   */
  forgetJump(t: number, wasRunning: boolean): void {
    this.until = wasRunning ? t + WINDOW_MS : Number.NEGATIVE_INFINITY;
    this.samples = [];
    this.blockedUntil = wasRunning ? Number.NEGATIVE_INFINITY : t + JUMP_LOCKOUT_MS;
  }

  reset(): void {
    this.samples = [];
    this.until = this.blockedUntil = this.lastRiseAt = Number.NEGATIVE_INFINITY;
    this.above = false;
    this.candidateSince = undefined;
    this.candidateAt = Number.NEGATIVE_INFINITY;
  }
}
