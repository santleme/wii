/**
 * Pure tennis-ball ballistics — no DOM, no Three.js, no Math.random, no global time.
 *
 * The ball is a point mass under gravity bouncing on a flat ground plane. Integration
 * is analytic within each segment (not Euler), and ground crossings inside a step are
 * resolved exactly: the ball is advanced to the impact instant, its velocity is damped,
 * and the remaining time keeps integrating — so large steps never tunnel below ground
 * and the trajectory is a deterministic function of the inputs.
 *
 * Scoring rules (second bounce, out, net) deliberately do NOT live here; this module
 * only moves the ball. `bounces` counts the bounces since the last hit so callers can
 * apply those rules themselves.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type BallHitter = 'player' | 'opponent';

export interface BallState {
  readonly position: Vec3;
  readonly velocity: Vec3;
  /** Bounces since the last hit; the hitter's first bounce is 1. */
  readonly bounces: number;
  readonly lastHitter: BallHitter;
}

export interface BallisticsConfig {
  /** Positive magnitude in units/s², applied downward. */
  readonly gravity: number;
  /** Height of the ground plane the ball bounces on. */
  readonly groundY: number;
  /** Fraction of the vertical impact speed kept after a bounce (0..1). */
  readonly bounceDamping: number;
  /** Fraction of the horizontal speed kept after a bounce (0..1). */
  readonly horizontalBounceDamping: number;
  /** Post-bounce vertical speed below which the ball is considered at rest. */
  readonly restVerticalSpeed: number;
}

export const DEFAULT_BALLISTICS: BallisticsConfig = {
  gravity: 9.8,
  groundY: 0,
  bounceDamping: 0.6,
  horizontalBounceDamping: 0.85,
  restVerticalSpeed: 0.6,
};

/** Hard cap on the bounces resolved inside a single advance; geometric decay hits rest long before. */
const MAX_BOUNCES_PER_STEP = 32;
const TIME_EPSILON_SECONDS = 1e-12;

export function createBall(position: Vec3, velocity: Vec3, lastHitter: BallHitter): BallState {
  return {
    position: { x: position.x, y: position.y, z: position.z },
    velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
    bounces: 0,
    lastHitter,
  };
}

/**
 * Advances the ball by dtSeconds under gravity, resolving every ground bounce exactly.
 * Returns the input object unchanged for non-positive dt. Never mutates the input.
 */
export function advanceBall(
  ball: BallState,
  dtSeconds: number,
  config: BallisticsConfig = DEFAULT_BALLISTICS,
): BallState {
  if (!(dtSeconds > 0)) return ball;

  const { gravity, groundY } = config;
  let x = ball.position.x;
  let y = ball.position.y;
  let z = ball.position.z;
  let vx = ball.velocity.x;
  let vy = ball.velocity.y;
  let vz = ball.velocity.z;
  let bounces = ball.bounces;
  let remaining = dtSeconds;

  for (let iteration = 0; remaining > TIME_EPSILON_SECONDS && iteration < MAX_BOUNCES_PER_STEP; iteration += 1) {
    const drop = y - groundY;
    if (drop <= 0 && vy <= 0) {
      // On (or numerically below) the ground with no upward speed: the ball is resting.
      // Horizontal motion is zeroed at rest — rolling is out of scope for the MVP.
      y = groundY;
      vx = 0;
      vy = 0;
      vz = 0;
      break;
    }

    // Positive root of y + vy·t − ½g·t² = groundY — the next ground impact, always
    // positive when the ball is airborne or moving up from the ground.
    const discriminant = vy * vy + 2 * gravity * drop;
    const impactTime = discriminant >= 0 ? (vy + Math.sqrt(discriminant)) / gravity : Number.POSITIVE_INFINITY;

    if (impactTime > remaining) {
      x += vx * remaining;
      z += vz * remaining;
      y += vy * remaining - 0.5 * gravity * remaining * remaining;
      vy -= gravity * remaining;
      remaining = 0;
      break;
    }

    // Advance exactly to the impact, then reflect with damping.
    x += vx * impactTime;
    z += vz * impactTime;
    y = groundY;
    vy -= gravity * impactTime;
    remaining -= impactTime;
    vx *= config.horizontalBounceDamping;
    vz *= config.horizontalBounceDamping;
    vy = -vy * config.bounceDamping;
    bounces += 1;

    if (vy < config.restVerticalSpeed) {
      vx = 0;
      vy = 0;
      vz = 0;
      break;
    }
  }

  return {
    position: { x, y, z },
    velocity: { x: vx, y: vy, z: vz },
    bounces,
    lastHitter: ball.lastHitter,
  };
}

/**
 * Exact projectile solution: the velocity the ball must leave `from` with so that it
 * lands on the ground plane at (target.x, target.z) exactly `flightTimeSeconds` later
 * (docs/design-tenis.md §3.6). Throws RangeError for a non-positive flight time —
 * that is a programming error, not a gameplay situation.
 */
export function solveOutgoing(
  from: Vec3,
  target: { readonly x: number; readonly z: number },
  flightTimeSeconds: number,
  config: BallisticsConfig = DEFAULT_BALLISTICS,
): Vec3 {
  if (!Number.isFinite(flightTimeSeconds) || flightTimeSeconds <= 0) {
    throw new RangeError(`flightTimeSeconds must be a positive finite number, got ${flightTimeSeconds}`);
  }
  const t = flightTimeSeconds;
  return {
    x: (target.x - from.x) / t,
    y: (config.groundY - from.y + 0.5 * config.gravity * t * t) / t,
    z: (target.z - from.z) / t,
  };
}

export interface PlaneCrossing {
  /** Seconds from now until the ball first crosses the plane. */
  readonly timeSeconds: number;
  /** Ball height at the crossing — callers decide whether it is in the hittable band. */
  readonly y: number;
}

const PLANE_SCAN_STEP_SECONDS = 1 / 120;
const DEFAULT_SCAN_HORIZON_SECONDS = 5;

/**
 * Time until the ball first crosses the plane z = planeZ, or null when it is moving
 * away, parallel, dies first, or would cross beyond the horizon.
 *
 * Because bounces damp the horizontal speed, there is no closed form once the ball
 * touches the ground — so this scans forward in small deterministic steps of the same
 * advanceBall integrator and linearly interpolates the crossing inside the final step
 * (exact while the ball is airborne, off by sub-millisecond across a bounce step).
 */
export function timeAtPlane(
  ball: BallState,
  planeZ: number,
  config: BallisticsConfig = DEFAULT_BALLISTICS,
  maxTimeSeconds: number = DEFAULT_SCAN_HORIZON_SECONDS,
): PlaneCrossing | null {
  const initialOffset = planeZ - ball.position.z;
  if (initialOffset === 0) return { timeSeconds: 0, y: ball.position.y };
  if (ball.velocity.z === 0 || Math.sign(ball.velocity.z) !== Math.sign(initialOffset)) return null;

  let current = ball;
  let elapsed = 0;
  while (elapsed < maxTimeSeconds) {
    const next = advanceBall(current, PLANE_SCAN_STEP_SECONDS, config);
    const before = planeZ - current.position.z;
    const after = planeZ - next.position.z;
    if (before * after <= 0) {
      const fraction = before / (before - after);
      return {
        timeSeconds: elapsed + fraction * PLANE_SCAN_STEP_SECONDS,
        y: current.position.y + fraction * (next.position.y - current.position.y),
      };
    }
    if (next.velocity.x === 0 && next.velocity.y === 0 && next.velocity.z === 0) return null;
    current = next;
    elapsed += PLANE_SCAN_STEP_SECONDS;
  }
  return null;
}

/**
 * As solveOutgoing, but lofted until the ball clears the net by `clearance`: as in the console game,
 * a stroke that connects does not die on the tape.
 */
export function solveOverNet(from: Vec3, target: { x: number; z: number }, flightSeconds: number, clearance = 1.25): Vec3 {
  let seconds = flightSeconds;
  let velocity = solveOutgoing(from, target, seconds);
  for (let tries = 0; tries < 20; tries += 1) {
    const atNet = -from.z / velocity.z;
    if (!(atNet > 0) || advanceBall(createBall(from, velocity, 'player'), atNet).position.y >= clearance) break;
    seconds *= 1.08;
    velocity = solveOutgoing(from, target, seconds);
  }
  return velocity;
}
