import { describe, expect, it } from 'vitest';
import {
  adaptOpponentSkill,
  createOpponentAi,
  decideReturn,
  DEFAULT_OPPONENT_AI_CONFIG,
  returnChance,
} from '../src/games/tennis/opponentAi';

/** rng that yields the given values in order and keeps repeating the last one. */
const sequenceRng = (values: number[]): (() => number) => {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)]!;
    index += 1;
    return value;
  };
};

const constantRng = (value: number): (() => number) => {
  return () => value;
};

describe('opponent AI', () => {
  describe('returnChance', () => {
    it('combines skill, generosity and incoming-ball quality linearly', () => {
      const state = createOpponentAi(0.5);
      expect(returnChance(state, 0)).toBeCloseTo(0.85, 10);
      expect(returnChance(state, 1)).toBeCloseTo(0.35, 10);
      expect(returnChance(state, 0.5)).toBeCloseTo(0.6, 10);
    });

    it('is clamped to a probability', () => {
      for (const skill of [0, 0.3, 0.6, 0.9, 1]) {
        for (const quality of [0, 0.5, 1]) {
          const chance = returnChance({ skill }, quality);
          expect(chance).toBeGreaterThanOrEqual(0);
          expect(chance).toBeLessThanOrEqual(1);
        }
      }
      expect(returnChance({ skill: 1 }, 0)).toBe(1);
      expect(returnChance({ skill: 0 }, 1)).toBe(0);
    });

    it('never increases when the incoming ball gets harder', () => {
      const state = createOpponentAi(0.6);
      const qualities = [0, 0.25, 0.5, 0.75, 1];
      const chances = qualities.map((quality) => returnChance(state, quality));
      for (let i = 1; i < chances.length; i += 1) {
        expect(chances[i]!).toBeLessThanOrEqual(chances[i - 1]!);
      }
    });
  });

  describe('decideReturn', () => {
    it('returns whenever the roll lands under the chance and not otherwise', () => {
      const state = createOpponentAi(0.5); // chance 0.85 on a quality-0 ball
      expect(decideReturn(state, 0, sequenceRng([0.84, 0.5, 0.5])).kind).toBe('return');
      expect(decideReturn(state, 0, sequenceRng([0.85, 0.5, 0.5])).kind).toBe('no-return');
      expect(decideReturn(state, 0, sequenceRng([0.99, 0.5, 0.5])).kind).toBe('no-return');
    });

    it('exposes the chance in both outcomes', () => {
      const state = createOpponentAi(0.5);
      const returned = decideReturn(state, 0, constantRng(0));
      const missed = decideReturn(state, 0, constantRng(0.99));
      expect(returned.returnChance).toBeCloseTo(0.85, 10);
      expect(missed.returnChance).toBeCloseTo(0.85, 10);
    });

    it('consumes exactly one rng roll on a no-return and three on a return', () => {
      const state = createOpponentAi(0.5);
      let rolls = 0;
      const countingRng = () => {
        rolls += 1;
        return 0;
      };
      decideReturn(state, 0, countingRng);
      expect(rolls).toBe(3);
      rolls = 0;
      decideReturn(state, 0.999, countingRng); // chance ≈ 0.35 → roll 0 keeps returning
      expect(rolls).toBe(3);
      rolls = 0;
      decideReturn(state, 1, () => {
        rolls += 1;
        return 0.9; // chance 0.35 → no-return on the first roll
      });
      expect(rolls).toBe(1);
    });

    it('keeps the return plan inside the court and the flight-time range', () => {
      const config = DEFAULT_OPPONENT_AI_CONFIG;
      const state = createOpponentAi(0.5);
      // Extreme jitter values in both directions.
      for (const jitter of [0, 0.5, 0.9999]) {
        const decision = decideReturn(state, 0, sequenceRng([0, jitter, jitter]));
        if (decision.kind !== 'return') throw new Error('expected return');
        expect(Math.abs(decision.targetX)).toBeLessThanOrEqual(config.courtHalfWidth - config.targetMargin);
        expect(decision.targetZ).toBeGreaterThanOrEqual(config.shallowTargetZ);
        expect(decision.targetZ).toBeLessThanOrEqual(config.deepTargetZ);
        expect(decision.flightTimeSeconds).toBeGreaterThanOrEqual(config.fastFlightSeconds);
        expect(decision.flightTimeSeconds).toBeLessThanOrEqual(config.slowFlightSeconds);
      }
    });

    it('is deterministic for the same rng sequence', () => {
      const state = createOpponentAi(0.62);
      const first = decideReturn(state, 0.4, sequenceRng([0.3, 0.7, 0.2]));
      const second = decideReturn(state, 0.4, sequenceRng([0.3, 0.7, 0.2]));
      expect(first).toEqual(second);
    });

    it('places the ball wider at higher skill for the same jitter', () => {
      const low = createOpponentAi(0.3);
      const high = createOpponentAi(0.9);
      const widthAt = (opponent: typeof low) => {
        const decision = decideReturn(opponent, 0, sequenceRng([0, 0.9999, 0.5]));
        if (decision.kind !== 'return') throw new Error('expected return');
        return Math.abs(decision.targetX);
      };
      expect(widthAt(high)).toBeGreaterThan(widthAt(low));
    });

    it('hits faster balls at higher skill', () => {
      const flightAt = (skill: number) => {
        const decision = decideReturn(createOpponentAi(skill), 0, sequenceRng([0, 0.5, 0.5]));
        if (decision.kind !== 'return') throw new Error('expected return');
        return decision.flightTimeSeconds;
      };
      expect(flightAt(0.9)).toBeLessThan(flightAt(0.3));
    });

    it('aims low-skill returns close to the centre for a gentle opening', () => {
      const gentle = decideReturn(createOpponentAi(0.3), 0, sequenceRng([0, 0.9999, 0.5]));
      if (gentle.kind !== 'return') throw new Error('expected return');
      // Even the most extreme jitter cannot reach the sideline at minimum width scale.
      expect(Math.abs(gentle.targetX)).toBeLessThan(DEFAULT_OPPONENT_AI_CONFIG.courtHalfWidth / 2);
    });
  });

  describe('adaptOpponentSkill', () => {
    it('raises skill when the player wins a point and lowers it when the opponent does', () => {
      const state = createOpponentAi(0.5);
      expect(adaptOpponentSkill(state, 'player').skill).toBeCloseTo(0.55, 10);
      expect(adaptOpponentSkill(state, 'opponent').skill).toBeCloseTo(0.45, 10);
      expect(state.skill).toBe(0.5); // input untouched
    });

    it('clamps skill inside the configured limits', () => {
      const config = DEFAULT_OPPONENT_AI_CONFIG;
      let state = createOpponentAi(config.maxSkill);
      for (let i = 0; i < 5; i += 1) state = adaptOpponentSkill(state, 'player');
      expect(state.skill).toBe(config.maxSkill);
      state = createOpponentAi(config.minSkill);
      for (let i = 0; i < 5; i += 1) state = adaptOpponentSkill(state, 'opponent');
      expect(state.skill).toBe(config.minSkill);
    });

    it('clamps the initial skill as well', () => {
      expect(createOpponentAi(2).skill).toBe(DEFAULT_OPPONENT_AI_CONFIG.maxSkill);
      expect(createOpponentAi(-1).skill).toBe(DEFAULT_OPPONENT_AI_CONFIG.minSkill);
    });
  });
});

it('requires the opponent to be within lateral racket reach', async () => {
  const { opponentCanReach } = await import('../src/games/tennis/opponentAi');
  expect(opponentCanReach(0, 1.15, 1.15)).toBe(true);
  expect(opponentCanReach(0, 1.16, 1.15)).toBe(false);
});
