// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { advanceBall, createBall, type BallState } from '../src/games/tennis/ballistics';
import { TennisGame } from '../src/games/tennis/TennisGame';
import type { TennisScoreState } from '../src/games/tennis/tennisScore';

vi.mock('../src/games/core/GameLoop', () => ({ GameLoop: class { dispose() {} } }));

function match() {
  const game = new TennisGame(document.createElement('canvas'), () => {});
  const state = game as unknown as {
    ball: BallState;
    score: TennisScoreState;
    faults: number;
    servingFlight: boolean;
    phase: { kind: string };
    tape: { tMs: number; ball: BallState }[];
    pendingPoint?: { deadAt: number };
    startPoint(now: number): void;
    stepBall(dt: number, now: number): void;
    resolveSwing(swing: { hand?: 'left' | 'right'; side: 'forehand'; power01: number; verticalSpeed: number; contactY: number; peakTimestampMs: number }): void;
  };
  return { game, state };
}

it('keeps the serve side on first fault and scores the second fault exactly once', () => {
  const { game, state } = match();
  try {
    state.startPoint(1000);
    const firstX = state.ball.position.x;
    for (const time of [1200, 1400]) {
      state.phase = { kind: 'rally' };
      state.servingFlight = true;
      state.ball = createBall({ x: 2, y: 0.01, z: -4 }, { x: 0, y: -2, z: 0 }, 'player');
      state.stepBall(1 / 60, time);
      if (time === 1200) {
        expect(state.faults).toBe(1);
        expect(state.ball.position.x).toBe(firstX);
        expect(state.score.points.opponent).toBe(0);
      }
    }
    state.stepBall(1 / 60, 1500);
    expect(state.score.points.opponent).toBe(1);
    expect(state.faults).toBe(0);
  } finally {
    game.dispose();
  }
});

it('accepts a confirmed return from before the second bounce', () => {
  const { game, state } = match();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1200);
  try {
    const incoming = { ...createBall({ x: 0, y: 0.5, z: 7.2 }, { x: 0, y: -3, z: 5 }, 'opponent'), bounces: 1 };
    state.phase = { kind: 'rally' };
    state.ball = incoming;
    state.tape = [{ tMs: 1000, ball: incoming }];
    state.stepBall(0.15, 1150);
    expect(state.pendingPoint).toBeDefined();
    const swing = { side: 'forehand' as const, power01: 0.5, verticalSpeed: 0, contactY: 0 };
    state.resolveSwing({ ...swing, peakTimestampMs: 999 });
    state.resolveSwing({ ...swing, peakTimestampMs: 1190 });
    expect(state.pendingPoint).toBeDefined();
    state.resolveSwing({ ...swing, peakTimestampMs: 1000 });
    expect(state.pendingPoint).toBeUndefined();
    expect(state.ball.lastHitter).toBe('player');
    expect(state.score.points.opponent).toBe(0);
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});

it('plays again when both hands are held up after the match, and not before they come down', () => {
  const huds: { tennis?: { restart01: number } }[] = [];
  const game = new TennisGame(document.createElement('canvas'), (hud) => { huds.push(hud as never); });
  const state = game as unknown as {
    phase: { kind: string };
    stepPhase(dt: number, now: number, wallTimeMs: number): void;
    publishHud(): void;
  };
  try {
    state.phase = { kind: 'match-over' };
    let atMs = 0;
    const hold = (raised: boolean, seconds: number) => {
      for (let i = 0; i < seconds * 60; i += 1) {
        atMs += 1000 / 60;
        game.setHandsRaised(raised, atMs);
        state.stepPhase(1 / 60, atMs, atMs);
      }
    };
    hold(true, 5); // still swinging after the last point
    state.publishHud();
    expect(huds.at(-1)!.tennis!.restart01).toBe(0);
    hold(false, 2);
    hold(true, 1.6);
    state.publishHud();
    expect(huds.at(-1)!.tennis!.restart01).toBe(1);
  } finally {
    game.dispose();
  }
});

it.each([-900, -300, 0, 400, 1500])('puts any serve stroke in play, %i ms from the apex', (offsetMs) => {
  const { game, state } = match();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  try {
    state.startPoint(1000);
    clock.mockReturnValue(1100);
    game.setTossHand(undefined);
    game.setTossHand('left');
    const { idealHitMs } = (state.phase as unknown as { serve: { idealHitMs: number } }).serve;
    state.resolveSwing({ side: 'forehand', power01: 0, verticalSpeed: 0, contactY: -1, peakTimestampMs: idealHitMs + offsetMs });
    expect(state.phase.kind).toBe('rally');
    for (let now = 1100; now < 3500 && state.ball && state.ball.bounces === 0 && state.faults === 0; now += 1000 / 60) {
      state.stepBall(1 / 60, now);
    }
    // First bounce reached on the far side: no net, no fault, no point against.
    expect(state.ball?.bounces).toBe(1);
    expect(state.ball!.position.z).toBeLessThan(0);
    expect(state.faults).toBe(0);
    expect(state.score.points.opponent).toBe(0);
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});

it('keeps the held serve free of any toss instant until the ball leaves the hand', () => {
  const { game, state } = match();
  const serveOf = () => (state.phase as unknown as { serve: Record<string, unknown> }).serve;
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  try {
    state.startPoint(1000);
    const held = serveOf();
    expect(held.kind).toBe('held');
    expect(held).not.toHaveProperty('tossedAtMs');
    expect(held).not.toHaveProperty('idealHitMs');

    clock.mockReturnValue(1400);
    game.setTossHand(undefined);
    game.setTossHand('left');
    const tossed = serveOf() as unknown as { kind: string; tossedAtMs: number; idealHitMs: number };
    expect(tossed.kind).toBe('tossed');
    expect(tossed.idealHitMs).toBeGreaterThan(tossed.tossedAtMs);
    // The ideal is fixed once, at the toss: stepping the ball never moves it.
    state.stepBall(1 / 60, 1500);
    state.stepBall(1 / 60, 2000);
    const after = serveOf() as unknown as { tossedAtMs: number; idealHitMs: number };
    expect(after.tossedAtMs).toBe(tossed.tossedAtMs);
    expect(after.idealHitMs).toBe(tossed.idealHitMs);
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});

it('tosses on its own at the scheduled instant, with the same ideal offset as a hand toss', () => {
  const serveOf = (state: ReturnType<typeof match>['state']) => (
    (state.phase as unknown as { serve: { kind: string; tossedAtMs: number; idealHitMs: number } }).serve
  );
  const manual = match();
  const auto = match();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  try {
    manual.state.startPoint(1000);
    clock.mockReturnValue(1400);
    manual.game.setTossHand(undefined);
    manual.game.setTossHand('left');
    const handToss = serveOf(manual.state);
    expect(handToss.kind).toBe('tossed');

    auto.state.startPoint(1000);
    auto.state.stepBall(1 / 60, 6999);
    expect(serveOf(auto.state).kind).toBe('held');
    expect(auto.state.ball.velocity.y).toBe(0);
    auto.state.stepBall(1 / 60, 7000);
    const autoToss = serveOf(auto.state);
    expect(autoToss.kind).toBe('tossed');
    expect(autoToss.tossedAtMs).toBe(7000);
    expect(auto.state.ball.velocity.y).toBeGreaterThan(0);
    expect(autoToss.idealHitMs - autoToss.tossedAtMs).toBeCloseTo(handToss.idealHitMs - handToss.tossedAtMs, 6);
  } finally {
    clock.mockRestore();
    manual.game.dispose();
    auto.game.dispose();
  }
});

it.each([0, 1])('serves the opponent diagonally into the box, never a fault (point %i)', (points) => {
  const { game, state } = match();
  const opponent = state as unknown as { stepPhase(dt: number, now: number): void };
  try {
    state.score = { ...state.score, server: 'opponent', points: { player: points, opponent: 0 } };
    state.startPoint(1000);
    opponent.stepPhase(1 / 60, 3000);
    for (let now = 3000; now < 6000 && state.ball.bounces === 0 && state.faults === 0; now += 1000 / 60) state.stepBall(1 / 60, now);
    expect(state.faults).toBe(0);
    expect(state.ball.bounces).toBe(1);
  } finally {
    game.dispose();
  }
});

it('tosses into the simulation after a long pause in rendering', () => {
  const { game, state } = match();
  const timing = state as unknown as { lastSimulationTimeMs: number; lastWallTimeMs: number; wallToSimulationOffsetMs: number };
  const clock = vi.spyOn(performance, 'now').mockReturnValue(11_000);
  try {
    timing.lastSimulationTimeMs = 1000;
    timing.lastWallTimeMs = 11_000;
    timing.wallToSimulationOffsetMs = -10_000;
    state.startPoint(1000);
    game.setTossHand(undefined);
    game.setTossHand('left');
    state.stepBall(1 / 60, 1017);
    expect(state.ball.velocity.y).toBeGreaterThan(0);
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});

it('throws at once when the free hand rises, and only the racket hand strikes', () => {
  const { game, state } = match();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const swing = (hand: 'left' | 'right') => state.resolveSwing({ hand, side: 'forehand', power01: 0.5, verticalSpeed: 0, contactY: 0, peakTimestampMs: performance.now() });
  try {
    state.startPoint(1000);
    clock.mockReturnValue(1300);
    game.setTossHand('left'); // already up when the serve began: does not count
    game.setTossHand(undefined);
    game.setTossHand('right'); // the racket arm never throws
    swing('right');
    expect(state.phase.kind).toBe('player-serve');
    game.setTossHand('left');
    clock.mockReturnValue(2500); // 1.2 s later, as recorded: the ball is still there to be struck
    state.stepBall(1 / 60, 2500);
    swing('left');
    expect(state.phase.kind).toBe('player-serve');
    swing('right');
    expect(state.phase.kind).toBe('rally');
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});


it('opens with the warm-up and starts the match once it is done', () => {
  const huds: { banner?: { title: string } }[] = [];
  const travels: number[] = [];
  const racketHands: ('left' | 'right')[] = [];
  const game = new TennisGame(document.createElement('canvas'), (hud) => huds.push(hud), undefined, {
    tutorial: true,
    onRacketHand: (hand) => racketHands.push(hand),
    onStrokeTravel: (travel) => travels.push(travel),
  });
  const state = game as unknown as { phase: { kind: string }; publishHud(): void };
  const swing = (side: 'forehand' | 'backhand') => game.onAction({ type: 'swing', id: 1, timestampMs: 0, confidence: 1, trackingState: 'tracked', source: 'cv', hand: 'right', side, power01: 0.5, travel: 3, contactY: 0, verticalSpeed: 0 });
  try {
    state.publishHud();
    expect(huds.at(-1)?.banner?.title).toBe('Dê 3 raquetadas');
    for (const side of ['forehand', 'forehand', 'forehand', 'backhand', 'backhand'] as const) swing(side);
    for (let i = 0; i < 4; i += 1) {
      game.setTossHand(undefined);
      game.setTossHand('left');
      if (i >= 2) swing('forehand');
    }
    expect(state.phase.kind).toBe('point-over');
    expect(travels).toEqual([1.6, 1.9]);
    expect(racketHands).toEqual(['right']);
  } finally {
    game.dispose();
  }
});

it('seeds a left racket hand for the opening toss and strike', () => {
  const game = new TennisGame(document.createElement('canvas'), () => {}, undefined, { initialRacketHand: 'left' });
  const state = game as unknown as ReturnType<typeof match>['state'];
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  try {
    state.startPoint(1000);
    clock.mockReturnValue(1300);
    game.setTossHand(undefined);
    game.setTossHand('right');
    state.stepBall(1 / 60, 1300);
    expect(state.ball.velocity.y).toBeGreaterThan(0);
    state.resolveSwing({ hand: 'left', side: 'forehand', power01: 0.5, verticalSpeed: 0, contactY: 0, peakTimestampMs: 1300 });
    expect(state.phase.kind).toBe('rally');
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});

it('reports the racket hand learned from an accepted return', () => {
  const learned: ('left' | 'right')[] = [];
  const game = new TennisGame(document.createElement('canvas'), () => {}, undefined, { onRacketHand: (hand) => learned.push(hand) });
  const state = game as unknown as ReturnType<typeof match>['state'];
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1200);
  try {
    const incoming = createBall({ x: 0, y: 1, z: 6 }, { x: 0, y: 1, z: 5 }, 'opponent');
    state.phase = { kind: 'rally' };
    state.ball = incoming;
    state.tape = [{ tMs: 1000, ball: incoming }];
    state.resolveSwing({ hand: 'left', side: 'forehand', power01: 0.5, verticalSpeed: 0, contactY: 0, peakTimestampMs: 1000 });
    expect(state.ball.lastHitter).toBe('player');
    expect(learned).toEqual(['left']);
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});

it('defers assistance while a stroke is pending, and the confirmed stroke controls the return', () => {
  const { game, state } = match();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const help = state as unknown as { helpWithMotion(now: number): void };
  try {
    const incoming = createBall({ x: 0, y: 0.9, z: 7.2 + 8 * 0.2 }, { x: 0, y: 1, z: 8 }, 'opponent');
    state.phase = { kind: 'rally' };
    state.ball = incoming;
    state.tape = [{ tMs: 700, ball: createBall({ x: 0, y: 0.9, z: 7.2 - 8 * 0.1 }, { x: 0, y: 1, z: 8 }, 'opponent') }];
    game.setArmMotions([{ hand: 'right', sideways: 1 }]);
    game.setSwingTracking({
      scaleReady: true,
      wrists: [
        { hand: 'right', tracked: true, pending: true, arbitrating: false },
        { hand: 'left', tracked: true, pending: false, arbitrating: false },
      ],
    });

    help.helpWithMotion(1000);
    expect(state.ball.lastHitter).toBe('opponent');

    state.resolveSwing({ hand: 'right', side: 'forehand', power01: 0.9, verticalSpeed: 0, contactY: 0, peakTimestampMs: 800 });
    expect(state.ball.lastHitter).toBe('player');
    expect(Math.abs(state.ball.velocity.z)).toBeGreaterThan(17);
    help.helpWithMotion(1000);
    expect(Math.abs(state.ball.velocity.z)).toBeGreaterThan(17);
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});

it('keeps a deferred assist at its original contact time through the second bounce', () => {
  const { game, state } = match();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1190);
  const help = state as unknown as { helpWithMotion(now: number): void };
  try {
    // First bounce behind the contact plane; the second bounce happens 245 ms after the plane.
    const atPlane = {
      ...createBall({ x: 0, y: 0.4408775, z: 7.2 }, { x: 0, y: -0.599, z: 6.8 }, 'opponent'),
      bounces: 1,
    };
    state.phase = { kind: 'rally' };
    state.ball = advanceBall(atPlane, 0.19);
    state.tape = [{ tMs: 999, ball: atPlane }];
    game.setArmMotions([{ hand: 'right', sideways: 1 }]);
    game.setSwingTracking({
      scaleReady: true,
      wrists: [
        { hand: 'right', tracked: true, pending: true, arbitrating: false },
        { hand: 'left', tracked: true, pending: false, arbitrating: false },
      ],
    });
    help.helpWithMotion(1190);
    expect(state.ball.lastHitter).toBe('opponent');

    for (let step = 1; step <= 4; step += 1) {
      const now = 1190 + step * 1000 / 60;
      clock.mockReturnValue(now);
      state.stepBall(1 / 60, now);
    }
    expect(state.pendingPoint).toBeDefined();
    const deadAt = state.pendingPoint!.deadAt;
    expect(deadAt).toBeCloseTo(1245, 3);

    clock.mockReturnValue(1550);
    game.setSwingTracking({
      scaleReady: true,
      wrists: [
        { hand: 'right', tracked: true, pending: false, arbitrating: false },
        { hand: 'left', tracked: true, pending: false, arbitrating: false },
      ],
    });
    state.resolveSwing({ hand: 'right', side: 'forehand', power01: 0.9, verticalSpeed: 0, contactY: 0, peakTimestampMs: deadAt + 1 });
    expect(state.ball.lastHitter).toBe('opponent');

    help.helpWithMotion(1550);
    expect(state.ball.lastHitter).toBe('player');
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});

it('uses assistance after a pending stroke clears without confirming', () => {
  const { game, state } = match();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const help = state as unknown as { helpWithMotion(now: number): void };
  try {
    const incoming = createBall({ x: 0, y: 0.9, z: 7.2 + 8 * 0.2 }, { x: 0, y: 1, z: 8 }, 'opponent');
    state.phase = { kind: 'rally' };
    state.ball = incoming;
    state.tape = [{ tMs: 700, ball: createBall({ x: 0, y: 0.9, z: 7.2 - 8 * 0.1 }, { x: 0, y: 1, z: 8 }, 'opponent') }];
    game.setArmMotions([{ hand: 'right', sideways: 1 }]);
    game.setSwingTracking({
      scaleReady: true,
      wrists: [
        { hand: 'right', tracked: true, pending: true, arbitrating: false },
        { hand: 'left', tracked: true, pending: false, arbitrating: false },
      ],
    });
    help.helpWithMotion(1000);
    expect(state.ball.lastHitter).toBe('opponent');

    game.setSwingTracking({
      scaleReady: true,
      wrists: [
        { hand: 'right', tracked: true, pending: false, arbitrating: false },
        { hand: 'left', tracked: true, pending: false, arbitrating: false },
      ],
    });
    help.helpWithMotion(1000);
    expect(state.ball.lastHitter).toBe('player');
    expect(Math.abs(state.ball.velocity.z)).toBeLessThan(17);
  } finally {
    clock.mockRestore();
    game.dispose();
  }
});

it('returns an arriving ball on plain arm movement when no stroke was read, and not without it', () => {
  for (const moved of [true, false]) {
    const { game, state } = match();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const help = state as unknown as { helpWithMotion(now: number): void };
    try {
      const incoming = createBall({ x: 0, y: 0.9, z: 7.2 + 8 * 0.2 }, { x: 0, y: 1, z: 8 }, 'opponent');
      state.phase = { kind: 'rally' };
      state.ball = incoming;
      state.tape = [{ tMs: 700, ball: createBall({ x: 0, y: 0.9, z: 7.2 - 8 * 0.1 }, { x: 0, y: 1, z: 8 }, 'opponent') }];
      if (moved) game.setArmMotions([{ hand: 'right', sideways: 1 }]);
      help.helpWithMotion(1000);
      expect(state.ball.lastHitter).toBe(moved ? 'player' : 'opponent');
    } finally {
      clock.mockRestore();
      game.dispose();
    }
  }
});
