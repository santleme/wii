import { describe, expect, it } from 'vitest';
import {
  solveOverNet,
  advanceBall,
  createBall,
  DEFAULT_BALLISTICS,
  solveOutgoing,
  timeAtPlane,
  type BallisticsConfig,
} from '../src/games/tennis/ballistics';

// Exact binary-friendly config: every value below is a multiple of a power of two,
// so the analytic integration in advanceBall produces exactly representable results.
const exactConfig: BallisticsConfig = {
  gravity: 10,
  groundY: 0,
  bounceDamping: 0.5,
  horizontalBounceDamping: 0.5,
  restVerticalSpeed: 0.1,
};

describe('ballistics', () => {
  it('creates a ball with zero bounces and the given hitter', () => {
    const ball = createBall({ x: 1, y: 2, z: 3 }, { x: 0, y: 1, z: -5 }, 'player');
    expect(ball.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(ball.velocity).toEqual({ x: 0, y: 1, z: -5 });
    expect(ball.bounces).toBe(0);
    expect(ball.lastHitter).toBe('player');
  });

  it('returns the identical state for a non-positive dt', () => {
    const ball = createBall({ x: 0, y: 2, z: 0 }, { x: 1, y: 0, z: -5 }, 'player');
    expect(advanceBall(ball, 0)).toBe(ball);
    expect(advanceBall(ball, -1)).toBe(ball);
  });

  it('integrates gravity analytically while airborne', () => {
    const ball = createBall({ x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: 0 }, 'player');
    const after = advanceBall(ball, 0.5);
    expect(after.velocity.y).toBeCloseTo(-4.9, 10);
    expect(after.position.y).toBeCloseTo(3.775, 10);
    expect(after.bounces).toBe(0);
  });

  it('keeps horizontal velocity constant in flight', () => {
    const ball = createBall({ x: 0, y: 5, z: 0 }, { x: 2, y: 0, z: -3 }, 'player');
    const after = advanceBall(ball, 0.25);
    expect(after.position.x).toBeCloseTo(0.5, 10);
    expect(after.position.z).toBeCloseTo(-0.75, 10);
    expect(after.velocity.x).toBe(2);
    expect(after.velocity.z).toBe(-3);
  });

  it('bounces exactly once with damped vertical and horizontal speed', () => {
    // With the exact config the ball hits the ground at t=1 with vy=-10;
    // the bounce damps it to vy=+5 and halves the horizontal speed.
    const ball = createBall({ x: 0, y: 5, z: 0 }, { x: 2, y: 0, z: 0 }, 'player');
    const after = advanceBall(ball, 1.5, exactConfig);
    expect(after.bounces).toBe(1);
    expect(after.position.x).toBe(2.5);
    expect(after.position.y).toBe(1.25);
    expect(after.position.z).toBe(0);
    expect(after.velocity.x).toBe(1);
    expect(after.velocity.y).toBe(0);
  });

  it('never tunnels below the ground even with a large dt', () => {
    const ball = createBall({ x: 0, y: 5, z: 0 }, { x: 0, y: -30, z: 0 }, 'player');
    const after = advanceBall(ball, 2);
    expect(after.position.y).toBeGreaterThanOrEqual(DEFAULT_BALLISTICS.groundY);
    expect(after.bounces).toBeGreaterThanOrEqual(1);
  });

  it('settles to rest after the bounce energy decays', () => {
    const ball = createBall({ x: 0, y: 0.2, z: 0 }, { x: 1, y: 0, z: -1 }, 'player');
    const after = advanceBall(ball, 10);
    expect(after.position.y).toBe(DEFAULT_BALLISTICS.groundY);
    expect(after.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(after.bounces).toBeGreaterThanOrEqual(2);
  });

  it('leaves a resting ball untouched', () => {
    const resting = createBall({ x: 3, y: 0, z: -2 }, { x: 0, y: 0, z: 0 }, 'opponent');
    const after = advanceBall(resting, 1);
    expect(after.position).toEqual({ x: 3, y: 0, z: -2 });
    expect(after.bounces).toBe(0);
  });

  it('does not mutate the input state', () => {
    const ball = createBall({ x: 0, y: 1, z: 0 }, { x: 1, y: 2, z: -3 }, 'opponent');
    const snapshot = JSON.parse(JSON.stringify(ball)) as unknown;
    advanceBall(ball, 0.75);
    expect(JSON.parse(JSON.stringify(ball))).toEqual(snapshot);
  });

  describe('solveOutgoing', () => {
    it('solves a velocity that lands exactly on the target after the flight time', () => {
      const from = { x: 0, y: 1.2, z: 7.2 };
      const target = { x: 1.5, z: -6 };
      const flightTime = 1.1;
      const velocity = solveOutgoing(from, target, flightTime);
      const ball = createBall(from, velocity, 'player');
      const after = advanceBall(ball, flightTime);
      expect(after.position.x).toBeCloseTo(target.x, 6);
      expect(after.position.z).toBeCloseTo(target.z, 6);
      expect(after.position.y).toBeCloseTo(DEFAULT_BALLISTICS.groundY, 6);
    });

    it('throws on a non-positive flight time', () => {
      expect(() => solveOutgoing({ x: 0, y: 1, z: 0 }, { x: 0, z: -5 }, 0)).toThrow(RangeError);
      expect(() => solveOutgoing({ x: 0, y: 1, z: 0 }, { x: 0, z: -5 }, -1)).toThrow(RangeError);
      expect(() => solveOutgoing({ x: 0, y: 1, z: 0 }, { x: 0, z: -5 }, Number.NaN)).toThrow(RangeError);
    });
  });

  describe('timeAtPlane', () => {
    it('returns the crossing time and height for a ball heading to the plane', () => {
      const ball = createBall({ x: 0, y: 5, z: 0 }, { x: 0, y: 3, z: 5 }, 'opponent');
      const crossing = timeAtPlane(ball, 3);
      expect(crossing).not.toBeNull();
      expect(crossing!.timeSeconds).toBeCloseTo(0.6, 6);
      // y(0.6) = 5 + 3*0.6 - 4.9*0.36 = 5.036
      expect(crossing!.y).toBeCloseTo(5.036, 2);
    });

    it('returns null when the ball moves away from the plane or parallel to it', () => {
      const away = createBall({ x: 0, y: 2, z: 0 }, { x: 0, y: 2, z: -5 }, 'opponent');
      expect(timeAtPlane(away, 3)).toBeNull();
      const parallel = createBall({ x: 0, y: 2, z: 0 }, { x: 2, y: 2, z: 0 }, 'opponent');
      expect(timeAtPlane(parallel, 3)).toBeNull();
    });

    it('returns null when the ball cannot reach the plane within the horizon', () => {
      const slow = createBall({ x: 0, y: 2, z: 0 }, { x: 0, y: 5, z: 0.1 }, 'opponent');
      expect(timeAtPlane(slow, 100)).toBeNull();
    });

    it('returns null when the ball dies before reaching the plane', () => {
      // Almost no forward speed and low height: the ball bounces in place and rests.
      const dying = createBall({ x: 0, y: 0.3, z: 0 }, { x: 0, y: 0, z: 0.05 }, 'opponent');
      expect(timeAtPlane(dying, 5)).toBeNull();
    });

    it('still finds a crossing when the ball bounces before the plane', () => {
      // Low fast ball: it will bounce on the way but the horizontal speed keeps sign.
      const ball = createBall({ x: 0, y: 0.5, z: 0 }, { x: 0, y: 0.5, z: 6 }, 'opponent');
      const crossing = timeAtPlane(ball, 2.5);
      expect(crossing).not.toBeNull();
      expect(crossing!.timeSeconds).toBeGreaterThan(0);
      expect(crossing!.timeSeconds).toBeLessThan(2);
    });

    it('reports a zero time when the ball is already on the plane', () => {
      const ball = createBall({ x: 0, y: 1.5, z: 3 }, { x: 0, y: 0, z: 5 }, 'opponent');
      expect(timeAtPlane(ball, 3)).toEqual({ timeSeconds: 0, y: 1.5 });
    });
  });
});

it('lofts a low or early contact until it clears the net and still lands on target', () => {
  for (const from of [{ x: 0, y: 0.1, z: 9.5 }, { x: 1, y: 0.2, z: 2 }, { x: 0, y: 1, z: 7.2 }]) {
    const velocity = solveOverNet(from, { x: -2, z: -8 }, 0.7);
    const flight = createBall(from, velocity, 'player');
    expect(advanceBall(flight, -from.z / velocity.z).position.y).toBeGreaterThan(0.9);
    const landed = (-8 - from.z) / velocity.z;
    expect(advanceBall(flight, landed).position.y).toBeCloseTo(0, 1);
  }
});
