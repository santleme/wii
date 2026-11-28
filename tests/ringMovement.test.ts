import { describe, expect, it } from 'vitest';
import {
  createOpponentMotion,
  fighterDistance,
  inPunchRange,
  MIN_FIGHTER_DISTANCE,
  moveAround,
  OPPONENT_MAX_ACCELERATION,
  OPPONENT_START,
  type OpponentMotion,
  type OpponentMotionContext,
  PLAYER_START,
  PUNCH_RANGE,
  RING_LIMIT,
  type RingPosition,
  stepOpponentMotion,
} from '../src/games/boxing/ringMovement';

const repeat = (times: number, position: RingPosition, step: (p: RingPosition) => RingPosition) => {
  let current = position;
  for (let i = 0; i < times; i += 1) current = step(current);
  return current;
};

describe('ring movement', () => {
  it('starts both fighters 2.70 m apart, inside punch range', () => {
    expect(fighterDistance(PLAYER_START, OPPONENT_START)).toBeCloseTo(2.7);
    expect(inPunchRange(PLAYER_START, OPPONENT_START)).toBe(true);
  });

  it('stops at the ropes', () => {
    const back = repeat(200, PLAYER_START, (p) => moveAround(p, OPPONENT_START, -0.05, 0));
    expect(back).toEqual({ x: 0, z: RING_LIMIT });
    const circled = repeat(500, PLAYER_START, (p) => moveAround(p, OPPONENT_START, 0, 0.05));
    expect(Math.abs(circled.x)).toBeLessThanOrEqual(RING_LIMIT);
    expect(Math.abs(circled.z)).toBeLessThanOrEqual(RING_LIMIT);
  });

  it('keeps the minimum distance when walking in, even in one huge step', () => {
    for (const forward of [0.05, 10]) {
      const close = repeat(100, PLAYER_START, (p) => moveAround(p, OPPONENT_START, forward, 0));
      expect(fighterDistance(close, OPPONENT_START)).toBeCloseTo(MIN_FIGHTER_DISTANCE);
      expect(close.z).toBeGreaterThan(OPPONENT_START.z);
    }
  });

  it('never ends up overlapping the other fighter against the ropes', () => {
    const cornered = { x: RING_LIMIT, z: RING_LIMIT };
    const other = { x: RING_LIMIT - 1.1, z: RING_LIMIT - 1.1 };
    for (const strafe of [-0.3, 0.3]) {
      const moved = moveAround(cornered, other, 0.2, strafe);
      expect(fighterDistance(moved, other)).toBeGreaterThanOrEqual(MIN_FIGHTER_DISTANCE - 1e-6);
    }
  });

  it('circles on an arc, to the mover own right when strafe is positive', () => {
    const right = moveAround(PLAYER_START, OPPONENT_START, 0, 0.5);
    expect(right.x).toBeGreaterThan(0);
    expect(fighterDistance(right, OPPONENT_START)).toBeCloseTo(2.7);
    expect(moveAround(PLAYER_START, OPPONENT_START, 0, -0.5).x).toBeLessThan(0);
  });

  it('checks reach', () => {
    expect(inPunchRange({ x: 0, z: 0 }, { x: 0, z: PUNCH_RANGE })).toBe(true);
    expect(inPunchRange({ x: 0, z: 0 }, { x: 0, z: PUNCH_RANGE + 0.01 })).toBe(false);
  });

});

describe('opponent motion', () => {
  const DT = 1 / 60;
  const low = () => 0;
  const high = () => 0.999;
  const guard: OpponentMotionContext = { phase: 'guard', skill: 0.55, playerPunching: false };
  const run = (
    motion: OpponentMotion,
    seconds: number,
    context: Partial<OpponentMotionContext> = {},
    player = PLAYER_START,
    rng = low,
  ) => {
    const frames = [motion];
    for (let i = 0; i < Math.round(seconds / DT); i += 1) {
      frames.push(stepOpponentMotion(frames[frames.length - 1]!, player, { ...guard, ...context }, DT, rng));
    }
    return frames;
  };
  const last = (frames: OpponentMotion[]) => frames[frames.length - 1]!;
  const speed = ({ velocity }: OpponentMotion) => Math.hypot(velocity.x, velocity.z);
  const gap = (motion: OpponentMotion, player = PLAYER_START) => fighterDistance(motion.position, player);
  const crowding = { x: 0, z: OPPONENT_START.z + MIN_FIGHTER_DISTANCE };

  it('backs off when crowded and while recovering, and stays punishable', () => {
    expect(gap(last(run(createOpponentMotion(), 0.5, {}, crowding)), crowding)).toBeGreaterThan(1.54);
    const recovering = gap(last(run(createOpponentMotion(), 0.66, { phase: 'recover' })));
    expect(recovering).toBeGreaterThan(2.75);
    expect(recovering).toBeLessThanOrEqual(PUNCH_RANGE);
  });

  it('walks back into range and plants its feet to wind up', () => {
    const far = { x: 0, z: 2.5 };
    const closed = run(createOpponentMotion({ x: 0, z: -2.5 }), 6, {}, far);
    expect(gap(last(closed), far)).toBeLessThanOrEqual(2.76);
    const walking = run(createOpponentMotion({ x: 0, z: -2.5 }), 0.5, {}, far);
    const planted = run(last(walking), 0.5, { phase: 'windup' }, far);
    expect(speed(last(planted))).toBe(0);
    expect(fighterDistance(last(planted).position, last(walking).position)).toBeLessThan(0.05);
  });

  it('stays in punch range through a guard, windup and recover cycle', () => {
    let motion = createOpponentMotion();
    for (let cycle = 0; cycle < 6; cycle += 1) {
      for (const [phase, seconds] of [
        ['guard', 0.7],
        ['windup', 0.94],
        ['recover', 0.66],
      ] as const) {
        const frames = run(motion, seconds, { phase });
        for (const frame of frames) expect(gap(frame)).toBeLessThanOrEqual(PUNCH_RANGE);
        motion = last(frames);
      }
    }
  });

  it('dashes sideways from a punch only on a high roll, once per punch', () => {
    const punching = { playerPunching: true, skill: 0.85 };
    expect(run(createOpponentMotion(), 0.5, punching).every((frame) => frame.dashUntilS === undefined)).toBe(true);

    let rolls = 0;
    const dashed = run(createOpponentMotion(), 3, punching, PLAYER_START, () => {
      rolls += 1;
      return 0.999;
    });
    expect(rolls).toBe(1);
    expect(Math.max(...dashed.map(speed))).toBeGreaterThan(1.5);
    expect(last(dashed).dashUntilS).toBeUndefined();
    expect(speed(last(dashed))).toBeLessThan(0.5);
    for (const frame of dashed) expect(gap(frame)).toBeCloseTo(2.7, 1);
  });

  it('does not dash again within the refractory time', () => {
    let motion = last(run(createOpponentMotion(), DT, { playerPunching: true }, PLAYER_START, high));
    motion = last(run(motion, 0.5, {}, PLAYER_START, high));
    expect(last(run(motion, DT, { playerPunching: true }, PLAYER_START, high)).dashUntilS).toBeUndefined();
    motion = last(run(motion, 1, {}, PLAYER_START, high));
    expect(last(run(motion, DT, { playerPunching: true }, PLAYER_START, high)).dashUntilS).toBeDefined();
  });

  it('scales walking speed and dash frequency with skill', () => {
    const walked = (skill: number) =>
      gap(last(run(createOpponentMotion({ x: 0, z: -2.5 }), 1, { skill }, { x: 0, z: 2.5 })), { x: 0, z: 2.5 });
    expect(walked(0.85)).toBeLessThan(walked(0.55));
    expect(walked(0.55)).toBeLessThan(walked(0.25));
    const dashes = (skill: number, roll: number) =>
      last(run(createOpponentMotion(), DT, { skill, playerPunching: true }, PLAYER_START, () => roll)).dashUntilS !==
      undefined;
    expect(dashes(0.25, 0.999)).toBe(false);
    expect(dashes(0.55, 0.6)).toBe(false);
    expect(dashes(0.85, 0.6)).toBe(true);
  });

  it('never accelerates faster than the bound, dash included', () => {
    let motion = createOpponentMotion();
    for (let i = 0; i < 240; i += 1) {
      const phase = i % 120 < 80 ? 'guard' : 'recover';
      const next = stepOpponentMotion(motion, PLAYER_START, { ...guard, phase, playerPunching: i % 30 < 15 }, DT, high);
      const change = Math.hypot(next.velocity.x - motion.velocity.x, next.velocity.z - motion.velocity.z);
      // A small allowance for the turning of the arc itself.
      expect(change).toBeLessThanOrEqual(OPPONENT_MAX_ACCELERATION * DT + 0.05);
      motion = next;
    }
  });

  it('stays inside the ropes and off a chasing player, turning around at the ropes', () => {
    let motion = createOpponentMotion();
    let player = PLAYER_START;
    const directions = new Set<number>();
    for (let i = 0; i < 6000; i += 1) {
      player = moveAround(player, motion.position, 1.2 * DT, Math.floor(i / 700) % 2 ? 0.5 * DT : -0.5 * DT);
      const phase = i % 200 < 130 ? 'guard' : 'recover';
      motion = stepOpponentMotion(motion, player, { phase, skill: 0.85, playerPunching: i % 90 < 15 }, DT, high);
      directions.add(motion.direction);
      expect(Math.abs(motion.position.x)).toBeLessThanOrEqual(RING_LIMIT);
      expect(Math.abs(motion.position.z)).toBeLessThanOrEqual(RING_LIMIT);
      expect(gap(motion, player)).toBeGreaterThanOrEqual(MIN_FIGHTER_DISTANCE - 1e-6);
    }
    expect(directions).toEqual(new Set([-1, 1]));
  });

  it('separates from a player placed on top of it', () => {
    const motion = stepOpponentMotion(createOpponentMotion(), OPPONENT_START, guard, DT, low);
    expect(gap(motion, OPPONENT_START)).toBeGreaterThanOrEqual(MIN_FIGHTER_DISTANCE - 1e-6);
  });
});
