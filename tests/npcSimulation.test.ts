import { describe, expect, it } from 'vitest';
import { Race, type Goal } from '../src/games/athletics/race';
import { createOpponentAi, stepOpponent, type OpponentObservation } from '../src/games/boxing/opponentAi';
import { chooseOpponentTarget } from '../src/games/tennis/opponentAi';

/** A reproducible sequence per scenario; separate streams keep paired comparisons aligned. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function firstBoxingAttack(seed: number, style: OpponentObservation['style'], guarding: boolean) {
  const rng = seeded(seed);
  const state = createOpponentAi(0, rng, 0.5);
  if (state.phase.kind !== 'guard') throw new Error('expected guard');
  const { state: next } = stepOpponent(state, state.phase.untilMs, 0, rng, {
    inRange: true, playerGuarding: guarding, style,
  });
  if (next.phase.kind !== 'windup') throw new Error('expected windup');
  return next.phase;
}

describe('reproducible NPC scenarios', () => {
  it('samples 100 seeds per distance within the fixed-pace baseline envelope', () => {
    const baseline: Record<Goal, number[]> = {
      100: [20.200, 17.833, 15.976],
      200: [41.020, 36.141, 32.313],
      400: [89.718, 78.962, 70.522],
    };
    for (const goal of [100, 200, 400] as const) {
      const samples: number[][] = [[], [], []];
      for (let seed = 1; seed <= 100; seed += 1) {
        const race = new Race(goal, seeded(seed));
        race.phase = 'racing';
        for (let i = 0; i < 120 * 60 && race.rivals.some((rival) => rival.finishS === undefined); i += 1) race.step(1 / 60);
        race.rivals.forEach((rival, i) => {
          expect(rival.finishS).toBeDefined();
          samples[i]!.push(rival.finishS!);
        });
      }
      for (const [index, times] of samples.entries()) {
        const mean = times.reduce((sum, value) => sum + value, 0) / times.length;
        expect(mean).toBeGreaterThan(baseline[goal][index]! * 0.9);
        expect(mean).toBeLessThan(baseline[goal][index]! * 1.1);
        expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(0);
      }
    }
  });

  it('uses the open side in 100 paired tennis situations without aiming outside the singles court', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const left = chooseOpponentTarget(-2, 0, 0.2, 0.6, seeded(seed));
      const right = chooseOpponentTarget(2, 0, 0.2, 0.6, seeded(seed));
      expect(left.x).toBeGreaterThan(0);
      expect(right.x).toBeLessThan(0);
      for (const shot of [left, right]) {
        expect(Math.abs(shot.x)).toBeLessThan(3.5);
        expect(shot.flightSeconds).toBeGreaterThan(0);
      }
    }
  });

  it('treats both guard states fairly and gives profiles distinct tendencies across 100 paired boxing seeds', () => {
    let bodyGuarded = 0;
    let bodyOpen = 0;
    let technicalStraights = 0;
    let aggressiveStraights = 0;
    for (let seed = 1; seed <= 100; seed += 1) {
      if (firstBoxingAttack(seed, 'technical', true).target === 'body') bodyGuarded += 1;
      if (firstBoxingAttack(seed, 'technical', false).target === 'body') bodyOpen += 1;
      if (firstBoxingAttack(seed, 'technical', false).attackKind === 'straight') technicalStraights += 1;
      if (firstBoxingAttack(seed, 'aggressive', false).attackKind === 'straight') aggressiveStraights += 1;
    }
    expect(bodyGuarded).toBe(bodyOpen);
    expect(technicalStraights).toBeGreaterThan(aggressiveStraights);
  });
});
