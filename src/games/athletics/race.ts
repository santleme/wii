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
export interface Rival {
  name: string;
  /** Top speed for this race, fixed once at the starting line. */
  pace: number;
  distance: number;
  speed: number;
  reactionS: number;
  accelerationS: number;
  /** Maximum proportional reduction in speed at the finish. */
  fade: number;
  finishS?: number;
}
export interface Standing {
  name: string;
  timeS: number;
  you: boolean;
  status: 'confirmed' | 'estimated';
  /** Competition rank: tied times share a place. */
  place: number;
}
export interface Split { metres: number; seconds: number }
export type Phase = 'framing' | 'warmup' | 'countdown' | 'racing' | 'finished';

/** Paces over 100 m; longer races are run a little slower, as people do. */
const RIVALS = [
  { name: 'Bia', pace: 5.1, reactionS: 0.24, accelerationS: 1.5, fade: 0.025 },
  { name: 'Caio', pace: 5.8, reactionS: 0.2, accelerationS: 1.8, fade: 0.015 },
  { name: 'Davi', pace: 6.5, reactionS: 0.16, accelerationS: 2, fade: 0.035 },
];
const GOAL_PACE: Record<Goal, number> = { 100: 1.012, 200: 0.978, 400: 0.888 };
/** The longer the event, the more speed the athletes lose in its second half. */
const GOAL_FADE: Record<Goal, number> = { 100: 1, 200: 2, 400: 4 };
const POST_FINISH_DISTANCE = 6;
const POST_FINISH_TAU_S = 0.8;

/** Integral of the zero-to-one acceleration ramp, in seconds. */
function accelerationIntegral(rival: Rival, timeS: number): number {
  const sinceStart = Math.max(0, timeS - rival.reactionS);
  return sinceStart < rival.accelerationS
    ? sinceStart * sinceStart / (2 * rival.accelerationS)
    : sinceStart - rival.accelerationS / 2;
}

function timeForAccelerationIntegral(rival: Rival, integral: number): number {
  return rival.reactionS + (integral < rival.accelerationS / 2
    ? Math.sqrt(2 * rival.accelerationS * integral)
    : integral + rival.accelerationS / 2);
}

function rivalSpeed(rival: Rival, elapsedS: number, goal: Goal): number {
  const acceleration = Math.min(1, Math.max(0, (elapsedS - rival.reactionS) / rival.accelerationS));
  const progress = Math.min(1, Math.max(0, rival.distance / goal));
  return rival.pace * acceleration * (1 - rival.fade * Math.max(0, (progress - 0.5) * 2));
}

/** Unfaded travel required to reach `to`, integrating the distance-dependent fade exactly. */
function travelRequired(rival: Rival, goal: Goal, to: number): number {
  const midpoint = goal / 2;
  const from = Math.min(goal, Math.max(0, rival.distance));
  let travel = Math.max(0, Math.min(to, midpoint) - from);
  const lateFrom = Math.max(midpoint, from);
  if (to <= lateFrom) return travel;
  if (rival.fade === 0) return travel + to - lateFrom;
  const scale = 2 * rival.fade / goal;
  const fromFactor = 1 - scale * (lateFrom - midpoint);
  const toFactor = 1 - scale * (to - midpoint);
  travel += Math.log(fromFactor / toFactor) / scale;
  return travel;
}

function advanceRival(rival: Rival, goal: Goal, fromS: number, toS: number): void {
  if (rival.finishS !== undefined) {
    const dt = toS - fromS;
    const travelled = rival.speed * POST_FINISH_TAU_S * (1 - Math.exp(-dt / POST_FINISH_TAU_S));
    rival.distance = Math.min(goal + POST_FINISH_DISTANCE, rival.distance + travelled);
    rival.speed = rival.distance >= goal + POST_FINISH_DISTANCE ? 0 : rival.speed * Math.exp(-dt / POST_FINISH_TAU_S);
    return;
  }
  const initialIntegral = accelerationIntegral(rival, fromS);
  const available = rival.pace * (accelerationIntegral(rival, toS) - initialIntegral);
  const finishTravel = travelRequired(rival, goal, goal);
  if (available >= finishTravel && rival.pace > 0) {
    const crossedAt = timeForAccelerationIntegral(rival, initialIntegral + finishTravel / rival.pace);
    rival.finishS = crossedAt;
    rival.distance = goal;
    rival.speed = rivalSpeed(rival, crossedAt, goal);
    advanceRival(rival, goal, crossedAt, toS);
    return;
  }
  const midpoint = goal / 2;
  const beforeFade = Math.min(available, Math.max(0, midpoint - rival.distance));
  rival.distance += beforeFade;
  const lateTravel = Math.max(0, available - beforeFade);
  if (lateTravel > 0) {
    if (rival.fade === 0) rival.distance += lateTravel;
    else {
      const scale = 2 * rival.fade / goal;
      const factor = 1 - scale * (rival.distance - midpoint);
      rival.distance += factor * -Math.expm1(-scale * lateTravel) / scale;
    }
  }
  rival.speed = rivalSpeed(rival, toS, goal);
}

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

  constructor(readonly goal: Goal = 100, rng: () => number = () => 0.5) {
    this.rivals = RIVALS.map((rival) => {
      const sample = rng();
      const variation = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
      return {
        ...rival,
        pace: rival.pace * GOAL_PACE[goal] * (0.985 + variation * 0.03),
        fade: rival.fade * GOAL_FADE[goal] / 2,
        distance: 0,
        speed: 0,
      };
    });
  }

  /** The camera's latest raw effort, which can exceed 1. */
  setEffort(effort: number, sampleAtMs?: number | null): void {
    this.effort = Number.isFinite(effort) ? Math.max(0, effort) : 0;
    if (sampleAtMs === null || (sampleAtMs !== undefined && !Number.isFinite(sampleAtMs))) this.effortAgeS = Infinity;
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
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.effortAgeS = wallTimeMs !== undefined && Number.isFinite(wallTimeMs) && typeof this.effortSampleAtMs === 'number' && Number.isFinite(this.effortSampleAtMs)
      ? Math.max(0, (wallTimeMs - this.effortSampleAtMs) / 1000)
      : this.effortAgeS + dt;
    if (this.phase === 'framing') {
      this.framedFor = this.advice === undefined ? this.framedFor + dt : 0;
      if (this.advice !== null && this.advice !== NO_BODY_ADVICE) this.seenFor += dt;
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
    for (const rival of this.rivals) advanceRival(rival, this.goal, this.elapsedS - dt, this.elapsedS);
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

  /** A pending time is an estimate, not a result. Finished times are never recalculated. */
  get standings(): Standing[] {
    const rivals: Standing[] = this.rivals.map((rival) => {
      if (rival.finishS !== undefined) {
        return { name: rival.name, timeS: rival.finishS, you: false, status: 'confirmed', place: 0 };
      }
      // Estimate using the mean of current and expected end speed, including fade.
      const remaining = Math.max(0, this.goal - rival.distance);
      const endSpeed = rival.pace * (1 - rival.fade);
      const currentSpeed = Math.max(rival.speed, rival.pace * 0.5);
      const timeS = this.elapsedS + remaining / Math.max((currentSpeed + endSpeed) / 2, 1e-6);
      return { name: rival.name, timeS, you: false, status: 'estimated', place: 0 };
    });
    const you: Standing[] = this.finishS === undefined ? [] : [{ name: 'Você', timeS: this.finishS, you: true, status: 'confirmed', place: 0 }];
    const sorted = [...rivals, ...you].sort((a, b) => a.timeS - b.timeS);
    return sorted.map((standing, index) => ({ ...standing, place: index > 0 && sorted[index - 1]!.timeS === standing.timeS ? sorted.findIndex((other) => other.timeS === standing.timeS) + 1 : index + 1 }));
  }

  get standingsFinal(): boolean { return this.rivals.every((rival) => rival.finishS !== undefined); }

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
