import { RestartGesture } from '../core/restartGesture';

export { RESTART_AFTER_S, RESTART_HOLD_S } from '../core/restartGesture';
/**
 * One athletics race, with no rendering. Before the start the player is framed and then runs flat out for a few
 * seconds, which sets what "full effort" means for that body, camera and angle. In the race the speed
 * follows that share of effort, with momentum, against three runners. Pure, so every rule is testable.
 */
/** Distances on offer: 800 m is too long to show anyone at a demo. */
export const GOALS = [100, 200, 400] as const;
export type Goal = (typeof GOALS)[number];
export const SPLIT_METRES = 100;
/** Best time in seconds, keyed by distance in metres. */
export type Records = Record<string, number>;
export const COUNTDOWN_S = 3;
export const WARMUP_S = 5;
/** The picture has to stay good this long before the warm-up starts. */
export const FRAMED_S = 1;
/** Nobody gets stuck: with a body in view, an imperfect picture is accepted after this long. */
export const FRAMING_PATIENCE_S = 15;
export const NO_BODY_ADVICE = 'Apareça na câmera';
/** A warm-up the camera barely registered is repeated, with advice, this many times. */
export const WARMUP_RETRIES = 2;
/** A reading older than this is not believed: a camera that froze without an error stops the runner. */
export const EFFORT_EXPIRES_S = 0.5;
/** Camera readings under this are rest, not slow running. */
const REST_EFFORT = 0.05;
/** A warm-up this weak was not understood: repeat it, then fall back to the default reference. */
const MIN_TRIED_EFFORT = 0.12;
/** Require at least half of the three-second sampling window at a usable signal. */
const MIN_ACTIVE_WARMUP_S = 1.5;
const MAX_WARMUP_SAMPLE_GAP_MS = 250;
const DEFAULT_REFERENCE = 0.6;
/** Room above the warm-up: matching it is fast, and pushing harder still makes a difference. */
export const HEADROOM = 1.15;
/** Speed at the top of the scale; matching the warm-up gives about 7.4 m/s, 100 m in some 14 s. */
export const TOP_SPEED = 8.5;
/** How fast the speed catches up: quicker to build than to lose, so a missed stride costs little. */
const GAIN_TAU_S = 0.5;
const LOSS_TAU_S = 1.4;
export interface Rival { name: string; pace: number; distance: number; finishS?: number }
export interface Split { metres: number; seconds: number }
export type Phase = 'framing' | 'warmup' | 'countdown' | 'racing' | 'finished';

/** Paces over 100 m; longer races are run a little slower, as people do. */
const RIVALS = [{ name: 'Bia', pace: 5.1 }, { name: 'Caio', pace: 5.8 }, { name: 'Davi', pace: 6.5 }];
const GOAL_PACE: Record<Goal, number> = { 100: 1, 200: 0.97, 400: 0.88 };

export class Race {
  phase: Phase = 'framing';
  countdown = COUNTDOWN_S;
  warmupLeft = WARMUP_S;
  /** What the camera asks the player to change; null until it has said anything. */
  advice: string | undefined | null = null;
  private framedFor = 0;
  private seenFor = 0;
  /** The camera reading that counts as this player's full effort. */
  reference = DEFAULT_REFERENCE;
  private readonly warmup: number[] = [];
  private warmupSampleAtMs?: number;
  private warmupLastActiveAtMs?: number;
  private warmupActiveS = 0;
  /** Warm-ups repeated because the camera did not register any running. */
  retries = 0;
  private handsHidden = false;
  private readonly restart = new RestartGesture();
  elapsedS = 0;
  distance = 0;
  speed = 0;
  finishS?: number;
  readonly rivals: Rival[];
  readonly splits: Split[] = [];
  private effort = 0;
  private effortAgeS = 0;
  private effortSampleAtMs?: number | null;

  constructor(readonly goal: Goal = 100) {
    this.rivals = RIVALS.map((rival) => ({ ...rival, pace: rival.pace * GOAL_PACE[goal], distance: 0 }));
  }

  /** The camera's latest raw effort, which can exceed 1. */
  setEffort(effort: number, sampleAtMs?: number | null): void {
    this.effort = Number.isFinite(effort) ? Math.max(0, effort) : 0;
    if (sampleAtMs === null) this.effortAgeS = Infinity;
    else if (sampleAtMs === undefined || sampleAtMs !== this.effortSampleAtMs) this.effortAgeS = 0;
    this.effortSampleAtMs = sampleAtMs;
  }

  /** The latest reading, or nothing once it is too old to trust. */
  private get reading(): number { return this.effortAgeS > EFFORT_EXPIRES_S ? 0 : this.effort; }

  /** Undefined advice means the picture is good. */
  setFraming(advice: string | undefined, handsHidden = false): void {
    this.advice = advice;
    this.handsHidden = handsHidden;
  }

  setHandsRaised(raised: boolean, atMs: number | null): void { this.restart.setHandsRaised(raised, atMs); }

  /** How far the raise-both-hands gesture is, 0–1; 1 asks for a new race. */
  get restart01(): number { return this.restart.progress01; }

  /** Shows whether the camera detects enough motion to calibrate, then shows race effort. */
  get energy01(): number {
    return this.phase === 'framing' || this.phase === 'warmup' ? Math.min(1, this.reading / MIN_TRIED_EFFORT) : this.effort01;
  }

  /** What to do when the bar will not fill; undefined while it is filling. */
  get coaching(): string | undefined {
    if (this.phase !== 'warmup' || (this.retries === 0 && this.warmupLeft > WARMUP_S - 2) || this.reading >= MIN_TRIED_EFFORT) return undefined;
    return this.handsHidden ? 'Mostre as mãos na câmera' : 'Mexa mais os braços, como quem corre';
  }

  get effort01(): number {
    return this.reading < REST_EFFORT ? 0 : Math.min(1, this.reading / (this.reference * HEADROOM));
  }

  step(dt: number, wallTimeMs?: number): void {
    this.effortAgeS = wallTimeMs !== undefined && typeof this.effortSampleAtMs === 'number'
      ? Math.max(0, (wallTimeMs - this.effortSampleAtMs) / 1000)
      : this.effortAgeS + dt;
    if (this.phase === 'framing') {
      this.framedFor = this.advice === undefined ? this.framedFor + dt : 0;
      // Patience counts a body in view: like framedFor, it restarts when that stops being true.
      if (this.advice === NO_BODY_ADVICE) this.seenFor = 0;
      else if (this.advice !== null) this.seenFor += dt;
      if (this.framedFor >= FRAMED_S || this.seenFor >= FRAMING_PATIENCE_S) this.phase = 'warmup';
      return;
    }
    if (this.phase === 'warmup') {
      this.warmupLeft -= dt;
      // The first seconds are getting up to pace.
      if (this.warmupLeft < WARMUP_S - 2) this.sampleWarmup();
      if (this.warmupLeft <= 1e-9) {
        // Near the top of what was read, ignoring one-off spikes.
        const peak = [...this.warmup].sort((a, b) => a - b)[Math.floor(this.warmup.length * 0.8)] ?? 0;
        const ready = this.warmupActiveS >= MIN_ACTIVE_WARMUP_S && peak >= MIN_TRIED_EFFORT;
        if (!ready && this.retries < WARMUP_RETRIES) {
          this.retries += 1;
          this.warmupLeft = WARMUP_S;
          this.warmup.length = 0;
          this.warmupSampleAtMs = this.warmupLastActiveAtMs = undefined;
          this.warmupActiveS = 0;
          return;
        }
        this.reference = ready ? peak : DEFAULT_REFERENCE;
        this.phase = 'countdown';
      }
      return;
    }
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 1e-9) this.phase = 'racing';
      return;
    }
    this.elapsedS += dt;
    for (const rival of this.rivals) {
      // A short acceleration off the blocks, then a steady pace.
      const from = rival.distance;
      const speed = rival.pace * Math.min(1, this.elapsedS / 1.2);
      rival.distance += speed * dt;
      if (rival.finishS === undefined && rival.distance >= this.goal && speed > 0) {
        rival.finishS = this.elapsedS - dt + (this.goal - from) / speed;
      }
    }
    if (this.phase === 'finished') {
      this.restart.step(dt, wallTimeMs);
      this.speed *= Math.exp(-dt / GAIN_TAU_S);
      this.distance += this.speed * dt;
      return;
    }
    const target = this.effort01 * TOP_SPEED;
    this.speed += (target - this.speed) * (1 - Math.exp(-dt / (target > this.speed ? GAIN_TAU_S : LOSS_TAU_S)));
    const from = this.distance;
    this.distance += this.speed * dt;
    const mark = Math.min(this.goal, (this.splits.length + 1) * SPLIT_METRES);
    if (this.distance < mark) return;
    // Timed inside the step, not at its end: at 8 m/s a 1/60 s step is 13 cm.
    const crossed = this.elapsedS - dt + (mark - from) / Math.max(this.speed, 1e-6);
    this.splits.push({ metres: mark, seconds: crossed });
    if (mark === this.goal) {
      this.finishS = crossed;
      this.phase = 'finished';
    }
  }

  private sampleWarmup(): void {
    const atMs = this.effortSampleAtMs === undefined ? (WARMUP_S - this.warmupLeft) * 1000 : this.effortSampleAtMs;
    if (atMs === null || this.effortAgeS > MAX_WARMUP_SAMPLE_GAP_MS / 1000) {
      this.warmupLastActiveAtMs = undefined;
      return;
    }
    if (this.warmupSampleAtMs !== undefined && atMs <= this.warmupSampleAtMs) return;
    this.warmupSampleAtMs = atMs;

    const reading = this.reading;
    this.warmup.push(reading);
    if (reading < MIN_TRIED_EFFORT) {
      this.warmupLastActiveAtMs = undefined;
      return;
    }
    const gapMs = this.warmupLastActiveAtMs === undefined ? Infinity : atMs - this.warmupLastActiveAtMs;
    if (gapMs <= MAX_WARMUP_SAMPLE_GAP_MS) this.warmupActiveS += gapMs / 1000;
    this.warmupLastActiveAtMs = atMs;
  }

  /** Everyone, fastest first; a rival still running is given the time its pace will take. */
  get standings(): { name: string; timeS: number; you: boolean }[] {
    const rivals = this.rivals.map((rival) => ({
      name: rival.name,
      timeS: rival.finishS ?? this.elapsedS + (this.goal - rival.distance) / rival.pace,
      you: false,
    }));
    const you = this.finishS === undefined ? [] : [{ name: 'Você', timeS: this.finishS, you: true }];
    return [...rivals, ...you].sort((a, b) => a.timeS - b.timeS);
  }

  /** 1 for first: rivals already across the line, or further along, are ahead. */
  get place(): number {
    return 1 + this.rivals.filter((rival) => (this.finishS === undefined
      ? rival.distance > this.distance
      : rival.finishS !== undefined && rival.finishS < this.finishS)).length;
  }
}

/** Stored data is untrusted: anything that is not a positive time is dropped. */
export function parseRecords(raw: string | null): Records {
  try {
    const data: unknown = JSON.parse(raw ?? '{}');
    if (!data || typeof data !== 'object') return {};
    return Object.fromEntries(
      Object.entries(data).filter((entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] > 0),
    );
  } catch {
    return {};
  }
}

export function recordTime(records: Records, goal: number, seconds: number) {
  const previous = records[goal];
  const isNew = previous === undefined || seconds < previous;
  const best = isNew ? seconds : previous;
  return { records: { ...records, [goal]: best }, best, isNew };
}

export function formatTime(seconds: number): string {
  const tenths = Math.floor(seconds * 10);
  const minutes = Math.floor(tenths / 600);
  return `${minutes}:${((tenths % 600) / 10).toFixed(1).padStart(4, '0')}`;
}
