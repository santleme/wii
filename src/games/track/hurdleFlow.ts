export type ItemKind = 'hurdle' | 'coin';
/** Hurdles end up `cleared` (jumped), `dodged` (passed in another lane) or `hit`; coins end up `collected` or `missed`. */
export type Outcome = 'cleared' | 'dodged' | 'hit' | 'collected' | 'missed';
export interface HurdleBody { kind: ItemKind; lane: number; z: number; passed: boolean }
export interface HurdleStep<T extends HurdleBody> { judged: { hurdle: T; outcome: Outcome }[]; despawned: T[]; spawn: boolean }

/** The runner holds this depth; a hurdle is judged only once it crosses this plane. */
export const RUNNER_Z = 1.4;
const DESPAWN_Z = 8;
export const MAX_SPAWN_DISTANCE = 26;
/** Floor: at full speed (22 units/s) this still leaves a whole jump (0.72 s) between hurdles. */
export const MIN_SPAWN_DISTANCE = 16;
/** Travelled distance over which the spacing tightens from the maximum to the floor. */
export const RAMP_DISTANCE = 1200;

export function spawnSpacing(travelled: number): number {
  const progress = Math.min(1, Math.max(0, travelled / RAMP_DISTANCE));
  return MAX_SPAWN_DISTANCE - (MAX_SPAWN_DISTANCE - MIN_SPAWN_DISTANCE) * progress;
}

/**
 * A hurdle is cleared only by jumping over it; going around it is safe but earns nothing.
 * A coin only needs the runner in its lane.
 */
function judge(item: HurdleBody, runnerLane: number, airborne: boolean): Outcome {
  const sameLane = item.lane === runnerLane;
  if (item.kind === 'coin') return sameLane ? 'collected' : 'missed';
  if (!sameLane) return 'dodged';
  return airborne ? 'cleared' : 'hit';
}

/**
 * Pure rules for the track's hurdles: they move with travelled distance, are judged a single
 * time when they cross the runner's plane, spawn every `spawnSpacing` travelled
 * (stretched by `boost`, so a faster world keeps the same time between them) and are
 * recycled once they are well behind the runner.
 */
export class HurdleFlow {
  private sinceSpawn = 0;

  /** Moves every hurdle `distance` toward the runner and reports what that step produced. */
  advance<T extends HurdleBody>(hurdles: T[], distance: number, runnerLane: number, airborne: boolean, travelled = 0, boost = 1): HurdleStep<T> {
    const judged: HurdleStep<T>['judged'] = [];
    for (const hurdle of hurdles) {
      hurdle.z += distance;
      if (!hurdle.passed && hurdle.z > RUNNER_Z) {
        hurdle.passed = true;
        judged.push({ hurdle, outcome: judge(hurdle, runnerLane, airborne) });
      }
    }
    this.sinceSpawn += distance;
    const spawn = this.sinceSpawn > spawnSpacing(travelled) * boost;
    if (spawn) this.sinceSpawn = 0;
    return { judged, despawned: hurdles.filter((hurdle) => hurdle.z > DESPAWN_Z), spawn };
  }
}
