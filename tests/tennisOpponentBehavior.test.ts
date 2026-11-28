// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createBall, solveOverNet, type BallState } from '../src/games/tennis/ballistics';
import { canContactBall, chooseOpponentTarget, stepOpponentMotion } from '../src/games/tennis/opponentAi';
import { TennisGame } from '../src/games/tennis/TennisGame';

vi.mock('../src/games/core/GameLoop', () => ({ GameLoop: class { dispose() {} } }));

const geometry = { x: 0, z: -8.3, lateralReach: 1.15, forwardReach: 1.4, minimumHeight: 0.12, maximumHeight: 2.5 };

describe('opponent physical behavior', () => {
  it('requires lateral, longitudinal and vertical reach', () => {
    expect(canContactBall(geometry, { x: 1, y: 1.2, z: -7.2 })).toBe(true);
    expect(canContactBall(geometry, { x: 1.16, y: 1.2, z: -7.2 })).toBe(false);
    expect(canContactBall(geometry, { x: 0, y: 1.2, z: -6.8 })).toBe(false);
    expect(canContactBall(geometry, { x: 0, y: 4.1, z: -7.2 })).toBe(false);
  });

  it('accelerates within bounds and does not teleport or overshoot the court', () => {
    let motion = { x: 0, velocity: 0 };
    for (let i = 0; i < 120; i += 1) {
      const next = stepOpponentMotion(motion, 5, 1 / 60, 4, 12, 2.5);
      expect(Math.abs(next.x - motion.x)).toBeLessThanOrEqual(4 / 60 + 1e-9);
      expect(Math.abs(next.velocity)).toBeLessThanOrEqual(4 + 1e-9);
      expect(next.x).toBeLessThanOrEqual(2.5);
      motion = next;
    }
    expect(motion.x).toBeCloseTo(2.5, 4);
  });

  it('chooses the open side reproducibly from observed position', () => {
    const right = chooseOpponentTarget(2, 0, 0.2, 0.7, () => 0.5);
    const left = chooseOpponentTarget(-2, 0, 0.2, 0.7, () => 0.5);
    expect(right.x).toBeLessThan(0);
    expect(left.x).toBeGreaterThan(0);
    expect(chooseOpponentTarget(2, 0, 0.2, 0.7, () => 0.5)).toEqual(right);
  });
});

type Internals = {
  phase: { kind: string };
  ball: BallState;
  tape: Array<{ tMs: number; ball: BallState; playerX?: number; opponentX?: number; opponentVelocity?: number; rngState?: number }>;
  playerX: number;
  opponentX: number;
  opponentVelocity: number;
  opponentStepStartX: number;
  opponentStepMs: number;
  opponentHitPlan: { fromBall: BallState; contactAfterSeconds: number; hitAtMs: number } | null;
  opponentBeaten: boolean;
  randomState: number;
  servingFlight: boolean;
  stepOpponentPlan(now: number): void;
  stepAvatars(dt: number, now: number): void;
  stepBall(dt: number, now: number): void;
  applyPlayerOutcome(outcome: object, ball: BallState, peak: number, now: number, serve: boolean, wall: number): void;
};

it('does not return a high ball even when lateral position is reachable', () => {
  const game = new TennisGame(document.createElement('canvas'), () => {});
  const state = game as unknown as Internals;
  try {
    const ball = createBall({ x: 0, y: 10, z: -6.2 }, { x: 0, y: -1, z: -1 }, 'player');
    state.phase = { kind: 'rally' };
    state.ball = ball;
    state.opponentX = 0;
    state.opponentStepStartX = 0;
    state.opponentStepMs = 1000 / 60;
    state.opponentHitPlan = { fromBall: ball, contactAfterSeconds: 1, hitAtMs: 2000 };
    state.stepOpponentPlan(2000);
    expect(state.ball.lastHitter).toBe('player');
    expect(state.opponentBeaten).toBe(true);
  } finally { game.dispose(); }
});

it('uses position at the crossing, not the later end of the tick', () => {
  const game = new TennisGame(document.createElement('canvas'), () => {});
  const state = game as unknown as Internals;
  try {
    const ball = createBall({ x: 2, y: 1, z: -7.2 }, { x: 0, y: 0, z: -4 }, 'player');
    state.phase = { kind: 'rally' };
    state.ball = ball;
    state.opponentStepStartX = 0;
    state.opponentX = 1.2;
    state.opponentStepMs = 100;
    state.opponentHitPlan = { fromBall: ball, contactAfterSeconds: 0, hitAtMs: 1900 };
    state.stepOpponentPlan(2000);
    expect(state.ball.lastHitter).toBe('player');
    expect(state.opponentBeaten).toBe(true);
  } finally { game.dispose(); }
});

it('reconstructs opponent motion with the ball when a stroke is confirmed late', () => {
  const run = (delay: number) => {
    const game = new TennisGame(document.createElement('canvas'), () => {}, undefined, { randomSeed: 42 });
    const state = game as unknown as Internals;
    const hit = createBall({ x: 1, y: 1.1, z: 7.2 }, { x: 0, y: 0, z: 5 }, 'opponent');
    const outcome = {
      kind: 'contact', outgoing: solveOverNet(hit.position, { x: -2, z: -8 }, 1.3),
      direction: 'cross', aimX: -2, timingErrorMs: 0, quality01: 0.8, spin: 0, smash: false, height: 'normal',
    };
    state.phase = { kind: 'rally' };
    state.ball = hit;
    state.randomState = 42;
    state.tape = [{ tMs: 1000, ball: hit, playerX: 0.5, opponentX: 1, opponentVelocity: 0, rngState: 42 }];
    state.playerX = delay ? -1 : 0.5;
    state.opponentX = delay ? -2 : 1;
    state.opponentVelocity = 0;
    state.applyPlayerOutcome(outcome, hit, 1000, 1000 + delay, false, 1000 + delay);
    for (let elapsed = delay; elapsed < 800 - 1e-8; elapsed += 1000 / 60) {
      const now = 1000 + elapsed + 1000 / 60;
      state.stepAvatars(1 / 60, now);
      state.stepBall(1 / 60, now);
    }
    const result = { ball: state.ball, x: state.opponentX, velocity: state.opponentVelocity, beaten: state.opponentBeaten };
    game.dispose();
    return result;
  };
  const immediate = run(0);
  const delayed = run(500);
  expect(delayed.x).toBeCloseTo(immediate.x, 8);
  expect(delayed.velocity).toBeCloseTo(immediate.velocity, 8);
  expect(delayed.beaten).toBe(immediate.beaten);
  expect(delayed.ball.position.z).toBeCloseTo(immediate.ball.position.z, 7);
  expect(delayed.ball.lastHitter).toBe(immediate.ball.lastHitter);
});

it('learns a bounded placement tendency only from observed non-central shots', async () => {
  const { createOpponentAi, observePlayerPlacement, opponentRecoveryX, adaptOpponentSkill } = await import('../src/games/tennis/opponentAi');
  let ai = createOpponentAi();
  ai = observePlayerPlacement(ai, 0.1);
  expect(opponentRecoveryX(ai)).toBe(0);
  for (let i = 0; i < 3; i += 1) ai = observePlayerPlacement(ai, -2);
  expect(opponentRecoveryX(ai)).toBe(0);
  ai = observePlayerPlacement(ai, -2);
  expect(opponentRecoveryX(ai)).toBeLessThan(0);
  for (let i = 0; i < 30; i += 1) ai = observePlayerPlacement(ai, -2);
  expect(ai.placements).toHaveLength(12);
  expect(opponentRecoveryX(ai)).toBeGreaterThanOrEqual(-0.65);
  expect(adaptOpponentSkill(ai, 'player').placements).toEqual(ai.placements);
});

it('replays a stroke through the opponent contact with identical seeded result and audio', () => {
  const run = (delayMs: number) => {
    const audio = { racket: vi.fn(), bounce: vi.fn(), failure: vi.fn(), success: vi.fn(), say: vi.fn(), milestone: vi.fn(), cheer: vi.fn() };
    const game = new TennisGame(document.createElement('canvas'), () => {}, audio as never, { randomSeed: 1234 });
    const state = game as unknown as Internals;
    const hit = createBall({ x: 0.4, y: 1.1, z: 7.2 }, { x: 0, y: 0, z: 5 }, 'opponent');
    const outcome = {
      kind: 'contact', outgoing: solveOverNet(hit.position, { x: 0, z: -8 }, 0.7),
      direction: 'center', aimX: 0, timingErrorMs: 0, quality01: 0.8, spin: 0, smash: false, height: 'normal',
    };
    state.phase = { kind: 'rally' };
    state.ball = hit;
    state.randomState = 1234;
    state.tape = [{ tMs: 1000, ball: hit, playerX: 0, opponentX: 0, opponentVelocity: 0, rngState: 1234 }];
    state.applyPlayerOutcome(outcome, hit, 1000, 1000 + delayMs, false, 1000 + delayMs);
    const totalMs = 1000;
    for (let elapsed = delayMs; elapsed < totalMs - 1e-8; elapsed += 1000 / 60) {
      const now = 1000 + elapsed + 1000 / 60;
      state.stepAvatars(1 / 60, now);
      state.stepBall(1 / 60, now);
    }
    const result = { ball: state.ball, x: state.opponentX, random: state.randomState, racketCalls: audio.racket.mock.calls.length };
    game.dispose();
    return result;
  };
  const immediate = run(0);
  const delayed = run(1000);
  expect(immediate.ball.lastHitter).toBe('opponent');
  expect(delayed.ball.lastHitter).toBe('opponent');
  expect(delayed.ball.position.x).toBeCloseTo(immediate.ball.position.x, 7);
  expect(delayed.ball.position.z).toBeCloseTo(immediate.ball.position.z, 7);
  expect(delayed.random).toBe(immediate.random);
  expect(immediate.racketCalls).toBe(2);
  expect(delayed.racketCalls).toBe(2);
});

it('commits a replayed out point once with the same score and audio', () => {
  const run = (delayMs: number) => {
    const audio = { racket: vi.fn(), bounce: vi.fn(), failure: vi.fn(), success: vi.fn(), say: vi.fn(), milestone: vi.fn(), cheer: vi.fn() };
    const game = new TennisGame(document.createElement('canvas'), () => {}, audio as never, { randomSeed: 99 });
    const state = game as unknown as Internals & { score: { points: { player: number; opponent: number } } };
    const hit = createBall({ x: 0, y: 1.1, z: 7.2 }, { x: 0, y: 0, z: 5 }, 'opponent');
    const outcome = {
      kind: 'contact', outgoing: solveOverNet(hit.position, { x: 5, z: -7 }, 0.9),
      direction: 'cross', aimX: 5, timingErrorMs: 0, quality01: 0.8, spin: 0, smash: false, height: 'normal',
    };
    state.phase = { kind: 'rally' };
    state.ball = hit;
    state.randomState = 99;
    state.tape = [{ tMs: 1000, ball: hit, playerX: 0, opponentX: 0, opponentVelocity: 0, rngState: 99 }];
    state.applyPlayerOutcome(outcome, hit, 1000, 1000 + delayMs, false, 1000 + delayMs);
    for (let elapsed = delayMs; elapsed < 2200 - 1e-8; elapsed += 1000 / 60) {
      const now = 1000 + elapsed + 1000 / 60;
      state.stepAvatars(1 / 60, now);
      state.stepBall(1 / 60, now);
    }
    const result = { points: state.score.points, phase: state.phase.kind, failure: audio.failure.mock.calls.length, say: audio.say.mock.calls.length };
    game.dispose();
    return result;
  };
  const immediate = run(0);
  const delayed = run(1000);
  expect(immediate.points.opponent).toBe(1);
  expect(immediate.failure).toBe(1);
  expect(immediate.say).toBe(1);
  expect(delayed).toEqual(immediate);
});

it('restores policy, score, serve state and random stream at the accepted swing instant', () => {
  const game = new TennisGame(document.createElement('canvas'), () => {}, undefined, { randomSeed: 7 });
  const state = game as unknown as Internals & {
    score: { points: { player: number; opponent: number } };
    faults: number;
    opponentAi: { skill: number; placements?: readonly number[] };
    opponentReturns: number;
    captureRallySnapshot(): object;
  };
  try {
    const hit = createBall({ x: 0, y: 1.1, z: 7.2 }, { x: 0, y: 0, z: 5 }, 'opponent');
    const outcome = {
      kind: 'contact', outgoing: solveOverNet(hit.position, { x: 0, z: -8 }, 1.4),
      direction: 'center', aimX: 0, timingErrorMs: 0, quality01: 0.8, spin: 0, smash: false, height: 'normal',
    };
    state.phase = { kind: 'rally' };
    state.ball = hit;
    state.randomState = 7;
    state.opponentAi = { skill: 0.4, placements: [-1, -1, -1, -1] };
    state.opponentReturns = 2;
    state.faults = 1;
    const savedScore = state.score;
    const snapshot = state.captureRallySnapshot();
    state.tape = [{ tMs: 1000, ball: hit, playerX: 0, opponentX: 0, opponentVelocity: 0, rngState: 7, snapshot } as never];
    state.score = { ...savedScore, points: { player: 3, opponent: 2 } };
    state.opponentAi = { skill: 0.9, placements: [1, 1, 1, 1] };
    state.opponentReturns = 9;
    state.opponentBeaten = true;
    state.faults = 0;
    state.randomState = 999;
    state.applyPlayerOutcome(outcome, hit, 1000, 1100, false, 1100);
    expect(state.score).toEqual(savedScore);
    expect(state.faults).toBe(1);
    expect(state.opponentAi).toEqual({ skill: 0.4, placements: [-1, -1, -1, -1] });
    expect(state.opponentReturns).toBe(2);
    expect(state.opponentBeaten).toBe(false);
    expect(state.randomState).toBe(7);
  } finally { game.dispose(); }
});

it('resolves an opponent contact before a second bounce in the same simulation step', () => {
  const game = new TennisGame(document.createElement('canvas'), () => {}, undefined, { randomSeed: 7 });
  const state = game as unknown as Internals & { pendingPoint?: unknown };
  try {
    // Ground impact occurs roughly 10 ms after the start; contact occurs at 5 ms.
    const ball = { ...createBall({ x: 0, y: 0.021, z: -7.15 }, { x: 0, y: -2, z: -10 }, 'player'), bounces: 1 };
    state.phase = { kind: 'rally' };
    state.ball = ball;
    state.opponentX = 0;
    state.opponentStepStartX = 0;
    state.opponentStepMs = 20;
    state.opponentHitPlan = { fromBall: ball, contactAfterSeconds: 0.005, hitAtMs: 1005 };
    // For this low ball, relax the geometry by making the actual contact just above its lower bound.
    // The standard opponent reach floor is 0.12, so use an elevated trajectory below.
    const highBall = { ...ball, position: { ...ball.position, y: 0.13 }, velocity: { ...ball.velocity, y: -13 } };
    state.ball = highBall;
    const fromBall = createBall({ x: 0, y: 2.542, z: -5.19 }, { x: 0, y: -11.03, z: -10 }, 'player');
    state.opponentHitPlan = { fromBall, contactAfterSeconds: 0.201, hitAtMs: 1000.5 };
    state.stepBall(0.02, 1020);
    expect(state.ball.lastHitter).toBe('opponent');
    expect(state.pendingPoint).toBeUndefined();
  } finally { game.dispose(); }
});

it('does not react to a ball that reaches an otherwise reachable racket before the reaction delay', () => {
  const game = new TennisGame(document.createElement('canvas'), () => {}, undefined, { randomSeed: 7 });
  const state = game as unknown as Internals;
  try {
    const ball = createBall({ x: 0, y: 1.2, z: -6.2 }, { x: 0, y: 1, z: -10 }, 'player');
    state.phase = { kind: 'rally' };
    state.ball = ball;
    state.opponentX = 0;
    state.opponentStepStartX = 0;
    state.opponentStepMs = 0;
    state.stepOpponentPlan(1000);
    state.stepOpponentPlan(1101);
    expect(state.ball.lastHitter).toBe('player');
    expect(state.opponentBeaten).toBe(true);
  } finally { game.dispose(); }
});

it('scores the second bounce when it precedes the planned contact in the same step', () => {
  const game = new TennisGame(document.createElement('canvas'), () => {}, undefined, { randomSeed: 7 });
  const state = game as unknown as Internals & { pendingPoint?: unknown };
  try {
    const ball = { ...createBall({ x: 0, y: 0.13, z: -7.15 }, { x: 0, y: -13, z: -10 }, 'player'), bounces: 1 };
    const fromBall = createBall({ x: 0, y: 2.542, z: -5.19 }, { x: 0, y: -11.03, z: -10 }, 'player');
    state.phase = { kind: 'rally' };
    state.ball = ball;
    state.opponentX = 0;
    state.opponentStepStartX = 0;
    state.opponentStepMs = 20;
    state.opponentHitPlan = { fromBall, contactAfterSeconds: 0.201, hitAtMs: 1015 };
    state.stepBall(0.02, 1020);
    expect(state.ball.lastHitter).toBe('player');
    expect(state.pendingPoint).toBeDefined();
  } finally { game.dispose(); }
});
