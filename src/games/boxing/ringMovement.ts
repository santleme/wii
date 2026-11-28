/**
 * Pure ring geometry — no DOM, no Three.js, no clocks. Positions are on the canvas plane (x, z)
 * and movement is relative to the line from the mover to the other fighter, so "forward" always
 * closes the distance and "strafe" always circles.
 */

export interface RingPosition {
  readonly x: number;
  readonly z: number;
}

/** Fighter centers stay this far from the middle, inside the ropes of `ringScene.ts`. */
export const RING_LIMIT = 2.55;
export const MIN_FIGHTER_DISTANCE = 1.45;
/** Center-to-center distance up to which a punch, from either side, can land. */
export const PUNCH_RANGE = 2.95;
export const PLAYER_START: RingPosition = Object.freeze({ x: 0, z: 1.85 });
export const OPPONENT_START: RingPosition = Object.freeze({ x: 0, z: -0.85 });
/** The opponent walks in once the player is farther than this. */
const OPPONENT_APPROACH_DISTANCE = 2.75;
const OPPONENT_APPROACH_SPEED = 0.6;
const OPPONENT_CIRCLE_SPEED = 0.25;
const EPSILON = 1e-9;

const clampAxis = (value: number): number => Math.max(-RING_LIMIT, Math.min(RING_LIMIT, value));

export const clampToRing = ({ x, z }: RingPosition): RingPosition => ({ x: clampAxis(x), z: clampAxis(z) });

export const fighterDistance = (a: RingPosition, b: RingPosition): number => Math.hypot(a.x - b.x, a.z - b.z);

export const inPunchRange = (a: RingPosition, b: RingPosition): boolean =>
  fighterDistance(a, b) <= PUNCH_RANGE + EPSILON;

/**
 * A punch is aimed along the player-to-opponent line at onset. Only actual displacement
 * across that line can evade it; radial movement is handled by the range rule.
 */
export function evadedByFootwork(playerAtOnset: RingPosition, targetAtOnset: RingPosition, targetAtPeak: RingPosition): boolean {
  const dx = targetAtOnset.x - playerAtOnset.x;
  const dz = targetAtOnset.z - playerAtOnset.z;
  const distance = Math.hypot(dx, dz);
  if (distance < EPSILON) return false;
  const lateral = ((targetAtPeak.x - targetAtOnset.x) * dz - (targetAtPeak.z - targetAtOnset.z) * dx) / distance;
  return Math.abs(lateral) >= 0.2;
}

/** Unit vector to the right of a fighter at `from` facing `to`. */
export function rightOf(from: RingPosition, to: RingPosition): RingPosition {
  const distance = fighterDistance(from, to) || 1;
  return { x: -(to.z - from.z) / distance, z: (to.x - from.x) / distance };
}

/** Keeps a move inside the ropes and off the other fighter; a move that cannot do both is refused. */
function settle(from: RingPosition, to: RingPosition, other: RingPosition): RingPosition {
  const inside = clampToRing(to);
  const distance = fighterDistance(inside, other);
  if (distance >= MIN_FIGHTER_DISTANCE - EPSILON) return inside;
  // Dead center on the other fighter has no direction of its own: back out the way we came.
  const away = distance > EPSILON ? inside : from;
  const scale = MIN_FIGHTER_DISTANCE / (fighterDistance(away, other) || 1);
  const pushed = clampToRing({ x: other.x + (away.x - other.x) * scale, z: other.z + (away.z - other.z) * scale });
  return fighterDistance(pushed, other) >= MIN_FIGHTER_DISTANCE - EPSILON ? pushed : from;
}

/**
 * Moves `self` by `forward` meters toward `other` and `strafe` meters to its own right, the
 * latter along the arc around `other` so circling alone never changes the distance.
 */
export function moveAround(self: RingPosition, other: RingPosition, forward: number, strafe: number): RingPosition {
  const distance = fighterDistance(self, other);
  if (distance <= EPSILON || (forward === 0 && strafe === 0)) return self;
  const right = rightOf(self, other);
  const back = { x: (self.x - other.x) / distance, z: (self.z - other.z) / distance };
  const angle = strafe / distance;
  // Walking in stops at the minimum distance instead of stepping through the other fighter.
  const radius = Math.max(MIN_FIGHTER_DISTANCE, distance - forward);
  return settle(
    self,
    {
      x: other.x + radius * (back.x * Math.cos(angle) + right.x * Math.sin(angle)),
      z: other.z + radius * (back.z * Math.cos(angle) + right.z * Math.sin(angle)),
    },
    other,
  );
}

export interface OpponentMove {
  readonly position: RingPosition;
  /** Circling direction to pass back in; it flips at the ropes. */
  readonly direction: -1 | 1;
}

/**
 * While guarding or recovering the opponent closes in when out of range and otherwise circles
 * lightly. It plants its feet to wind up, so stepping back is a way out of the punch.
 */
export function stepOpponentPosition(
  opponent: RingPosition,
  player: RingPosition,
  phase: 'guard' | 'windup' | 'recover',
  direction: -1 | 1,
  dtS: number,
): OpponentMove {
  if (phase === 'windup') return { position: opponent, direction };
  const excess = fighterDistance(opponent, player) - OPPONENT_APPROACH_DISTANCE;
  if (excess > EPSILON) {
    const forward = Math.min(excess, OPPONENT_APPROACH_SPEED * dtS);
    return { position: moveAround(opponent, player, forward, 0), direction };
  }
  const strafe = direction * OPPONENT_CIRCLE_SPEED * dtS;
  const position = moveAround(opponent, player, 0, strafe);
  // Hitting a rope bends the arc, which shows up as a changed distance: turn around instead.
  const blocked = Math.abs(fighterDistance(position, player) - fighterDistance(opponent, player)) > 1e-6;
  return blocked ? { position: opponent, direction: direction === 1 ? -1 : 1 } : { position, direction };
}

export interface OpponentMotion {
  readonly position: RingPosition;
  /** m/s over the last step, for footwork animation. */
  readonly velocity: RingPosition;
  /** Circling and dash direction; it flips at the ropes. */
  readonly direction: -1 | 1;
  /** Set while a lateral dash is running, on the motion-local clock. */
  readonly dashUntilS?: number;
  readonly clockS: number;
  /** Earliest `clockS` at which another dash may start. */
  readonly dashReadyAtS?: number;
  /** Last `playerPunching`, so each punch is reacted to (rolled for) only once. */
  readonly sawPunch?: boolean;
}

export interface OpponentMotionContext {
  readonly phase: 'guard' | 'windup' | 'recover';
  /** 0..1 from the opponent profile. */
  readonly skill: number;
  /** A player punch animation is in flight. */
  readonly playerPunching: boolean;
  /** Delayed perception controls intent; `player` remains the current collision position. */
  readonly observedPlayer?: RingPosition;
}

/** Upper bound on how fast the commanded velocity changes, dash included (m/s²). */
export const OPPONENT_MAX_ACCELERATION = 14;
const OPPONENT_WALK_ACCELERATION = 6;
/** Above this speed the opponent is coming out of a dash and brakes at the dash rate. */
const OPPONENT_BRISK_SPEED = 1.2;
const OPPONENT_RETREAT_DISTANCE = 1.55;
/** A recovering opponent backs off up to here, still inside PUNCH_RANGE so it can be punished. */
const OPPONENT_RECOVER_DISTANCE = 2.85;
const OPPONENT_RETREAT_SPEED = 0.7;
const OPPONENT_DASH_SPEED = 2;
const OPPONENT_DASH_S = 0.22;
const OPPONENT_DASH_REFRACTORY_S = 1.2;

export function createOpponentMotion(position: RingPosition = OPPONENT_START): OpponentMotion {
  return { position: clampToRing(position), velocity: { x: 0, z: 0 }, direction: 1, clockS: 0 };
}

/** Chance of dashing away from one punch: none for a rookie, about half for the most skilled. */
const dashChance = (skill: number): number => Math.max(0, skill - 0.25) * 0.9;

/** Fastest speed toward a goal `remaining` meters away that can still stop there. */
const brakingSpeed = (max: number, remaining: number, dtS: number): number =>
  Math.min(max, remaining / dtS, Math.sqrt(2 * OPPONENT_WALK_ACCELERATION * remaining));

/** Last-resort separation: toward the middle of the ring there is always room. */
function keepApart(position: RingPosition, player: RingPosition): RingPosition {
  if (fighterDistance(position, player) >= MIN_FIGHTER_DISTANCE - EPSILON) return position;
  const length = Math.hypot(player.x, player.z);
  const inward = length > EPSILON ? { x: -player.x / length, z: -player.z / length } : { x: 0, z: -1 };
  return { x: player.x + inward.x * MIN_FIGHTER_DISTANCE, z: player.z + inward.z * MIN_FIGHTER_DISTANCE };
}

/**
 * Footwork with momentum. The opponent closes in from out of range, circles while there, backs off
 * when crowded or recovering, plants to wind up, and may dash sideways away from a punch. `rng` is
 * consumed once per player punch, and only when a dash is possible; a high roll triggers it.
 */
export function stepOpponentMotion(
  motion: OpponentMotion,
  player: RingPosition,
  context: OpponentMotionContext,
  dtS: number,
  rng: () => number,
): OpponentMotion {
  if (!(dtS > 0) || !Number.isFinite(dtS)) return motion;
  const { position, velocity } = motion;
  const { phase, playerPunching } = context;
  const skill = Number.isFinite(context.skill) ? Math.min(1, Math.max(0, context.skill)) : 0.5;
  const speedScale = 0.8 + 0.45 * skill;
  const clockS = motion.clockS + dtS;
  const planted = phase === 'windup';

  let { direction, dashReadyAtS = 0 } = motion;
  let dashUntilS =
    !planted && motion.dashUntilS !== undefined && motion.dashUntilS > clockS ? motion.dashUntilS : undefined;
  const chance = dashChance(skill);
  if (
    playerPunching &&
    !motion.sawPunch &&
    !planted &&
    chance > 0 &&
    motion.clockS >= dashReadyAtS &&
    rng() > 1 - chance
  ) {
    dashUntilS = clockS + OPPONENT_DASH_S;
    dashReadyAtS = clockS + OPPONENT_DASH_REFRACTORY_S;
  }

  const distance = fighterDistance(position, player);
  const observedDistance = fighterDistance(position, context.observedPlayer ?? player);
  const right = rightOf(position, player);
  // Unit vector toward the player; `right` turned back a quarter.
  const ahead = { x: right.z, z: -right.x };
  let forward = 0;
  let strafe = 0;
  if (dashUntilS !== undefined) {
    strafe = direction * OPPONENT_DASH_SPEED * speedScale;
  } else if (!planted) {
    const recovering = phase === 'recover';
    const excess = observedDistance - (recovering ? OPPONENT_RECOVER_DISTANCE : OPPONENT_APPROACH_DISTANCE);
    if (excess > EPSILON) {
      forward = brakingSpeed(OPPONENT_APPROACH_SPEED * speedScale, excess, dtS);
    } else {
      const keep = recovering ? OPPONENT_RECOVER_DISTANCE : OPPONENT_RETREAT_DISTANCE;
      if (keep - observedDistance > EPSILON) forward = -brakingSpeed(OPPONENT_RETREAT_SPEED * speedScale, keep - observedDistance, dtS);
      strafe = direction * OPPONENT_CIRCLE_SPEED * speedScale;
    }
  }

  // Determine intent in the delayed frame, then express it in the current physical
  // frame for collision-safe integration. This avoids reacting to an unseen sidestep.
  const perceivedRight = rightOf(position, context.observedPlayer ?? player);
  const perceivedAhead = { x: perceivedRight.z, z: -perceivedRight.x };
  const wantedX = forward * perceivedAhead.x + strafe * perceivedRight.x;
  const wantedZ = forward * perceivedAhead.z + strafe * perceivedRight.z;
  forward = wantedX * ahead.x + wantedZ * ahead.z;
  strafe = wantedX * right.x + wantedZ * right.z;

  const currentForward = velocity.x * ahead.x + velocity.z * ahead.z;
  const currentStrafe = velocity.x * right.x + velocity.z * right.z;
  const brisk = dashUntilS !== undefined || Math.hypot(velocity.x, velocity.z) > OPPONENT_BRISK_SPEED;
  const maxChange = (brisk ? OPPONENT_MAX_ACCELERATION : OPPONENT_WALK_ACCELERATION) * dtS;
  const change = Math.hypot(forward - currentForward, strafe - currentStrafe);
  const blend = change > maxChange ? maxChange / change : 1;
  const nextForward = currentForward + (forward - currentForward) * blend;
  const nextStrafe = currentStrafe + (strafe - currentStrafe) * blend;

  const moved = moveAround(position, player, nextForward * dtS, nextStrafe * dtS);
  // A rope bends or stops the path, which shows up as a distance other than the intended one.
  const intended = Math.max(MIN_FIGHTER_DISTANCE, distance - nextForward * dtS);
  if (Math.abs(nextStrafe) > EPSILON && Math.abs(fighterDistance(moved, player) - intended) > 1e-6) {
    // Away from the side being pushed into, so repeated contact cannot flip back and forth.
    direction = nextStrafe > 0 ? -1 : 1;
  }
  const next = keepApart(clampToRing(moved), player);

  return {
    position: next,
    velocity: { x: (next.x - position.x) / dtS, z: (next.z - position.z) / dtS },
    direction,
    clockS,
    dashReadyAtS,
    sawPunch: playerPunching,
    ...(dashUntilS === undefined ? {} : { dashUntilS }),
  };
}
