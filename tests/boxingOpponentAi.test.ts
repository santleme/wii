import { describe, expect, it } from 'vitest';
import {
  createOpponentAi,
  DEFAULT_SKILL,
  IMPACT_GRACE_MS,
  isDodged,
  isDodgedTyped,
  MAX_PUNCH_LOOKBACK_MS,
  type OpponentAiState,
  openingAt,
  stepOpponent,
  WINDUP_MAX_MS,
  WINDUP_MIN_MS,
  type Zone,
} from '../src/games/boxing/opponentAi';

/** rng that yields the given values in order and fails on an unexpected extra roll. */
const sequenceRng = (values: number[]): (() => number) => {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error('unexpected rng roll');
    index += 1;
    return value;
  };
};

const constantRng = (value: number) => () => value;
const noRng = sequenceRng([]);

const guardEnd = (state: OpponentAiState): number => {
  if (state.phase.kind === 'windup') throw new Error('expected a timed phase');
  return state.phase.untilMs;
};

const startWindup = (skill: number, roll: number, zone: Zone = 0) => {
  const guard = createOpponentAi(0, constantRng(0), skill);
  const at = guardEnd(guard);
  const { state } = stepOpponent(guard, at, zone, constantRng(roll));
  if (state.phase.kind !== 'windup') throw new Error('expected windup');
  return { state, at, phase: state.phase };
};

describe('boxing opponent AI', () => {
  it('starts guarding with a clamped skill and one rng roll', () => {
    const state = createOpponentAi(1_000, sequenceRng([0.5]));
    expect(state.skill).toBe(DEFAULT_SKILL);
    expect(state.phase).toEqual({ kind: 'guard', untilMs: 2_100 });
    expect(state.phaseStartedMs).toBe(1_000);
    expect(state.previous).toBeUndefined();
    expect(createOpponentAi(0, constantRng(0), 4).skill).toBe(1);
    expect(createOpponentAi(0, constantRng(0), -1).skill).toBe(0);
    expect(createOpponentAi(0, constantRng(0), Number.NaN).skill).toBe(DEFAULT_SKILL);
  });

  it('holds a phase without consuming rolls until its time is up', () => {
    const guard = createOpponentAi(0, constantRng(0));
    expect(stepOpponent(guard, guardEnd(guard) - 1, 0, noRng)).toEqual({ state: guard });
  });

  it('rolls hand, duration, kind and target in order and targets the zone at windup start', () => {
    const guard = createOpponentAi(0, constantRng(0), 0);
    const at = guardEnd(guard);
    const { state, attack } = stepOpponent(guard, at, -1, sequenceRng([0.2, 0.5, 0.6, 0.9]));
    expect(attack).toBeUndefined();
    expect(state.phase).toEqual({ kind: 'windup', hand: 'left', targetZone: -1, impactAtMs: at + 850, attackKind: 'hook', target: 'body' });
    expect(state.previous).toBe(guard.phase);
    expect(state.phaseStartedMs).toBe(at);
    expect(guard.phase.kind).toBe('guard');
    expect(stepOpponent(guard, at, 1, sequenceRng([0.7, 0, 0.1, 0.1])).state.phase).toMatchObject({
      hand: 'right',
      targetZone: 1,
      attackKind: 'straight',
      target: 'head',
    });
    expect(stepOpponent(guard, at, 1, sequenceRng([0.7, 0, 0.9, 0.1])).state.phase).toMatchObject({
      attackKind: 'uppercut',
    });
  });

  it('keeps windups within range and shorter with more skill', () => {
    const duration = (skill: number, roll: number) => {
      const { at, phase } = startWindup(skill, roll);
      return phase.impactAtMs - at;
    };
    expect(duration(0, 0)).toBe(WINDUP_MAX_MS);
    expect(duration(1, 0.999999)).toBeCloseTo(WINDUP_MIN_MS, 2);
    expect(duration(1, 0.5)).toBeLessThan(duration(0, 0.5));
  });

  it('returns the attack exactly once, a grace period after impact', () => {
    const { state, phase } = startWindup(0.5, 0.2, 1);
    const resolveAt = phase.impactAtMs + IMPACT_GRACE_MS;
    // Moving after the windup started does not retarget it, and nothing resolves early.
    expect(stepOpponent(state, resolveAt - 1, -1, noRng)).toEqual({ state });
    const resolved = stepOpponent(state, resolveAt, -1, noRng);
    expect(resolved.attack).toEqual({ hand: 'left', targetZone: 1, impactAtMs: phase.impactAtMs, attackKind: 'straight', target: 'head' });
    expect(resolved.state.phase.kind).toBe('recover');
    expect(stepOpponent(resolved.state, resolveAt, -1, noRng).attack).toBeUndefined();
  });

  it('still resolves a windup once after a long stall, one transition per step', () => {
    const { state } = startWindup(0.5, 0.2);
    const late = stepOpponent(state, 60_000, 0, noRng);
    expect(late.attack).toBeDefined();
    expect(late.state.phase.kind).toBe('recover');
    expect(late.state.phaseStartedMs).toBe(60_000);
  });

  it('cycles from recover back to guard with one roll', () => {
    const { state, phase } = startWindup(0, 0);
    const recover = stepOpponent(state, phase.impactAtMs + IMPACT_GRACE_MS, 0, noRng).state;
    const guard = stepOpponent(recover, guardEnd(recover), 0, sequenceRng([0.25])).state;
    expect(guard.phase).toEqual({ kind: 'guard', untilMs: guardEnd(recover) + 1_100 });
    expect(guard.previous).toBe(recover.phase);
  });

  it('makes every phase outlast the punch lookback, even at the shortest rolls', () => {
    let state = createOpponentAi(0, constantRng(0), 1);
    for (let i = 0; i < 6; i += 1) {
      const end = state.phase.kind === 'windup' ? state.phase.impactAtMs + IMPACT_GRACE_MS : state.phase.untilMs;
      expect(end - state.phaseStartedMs).toBeGreaterThan(MAX_PUNCH_LOOKBACK_MS);
      state = stepOpponent(state, end, 0, constantRng(0)).state;
    }
  });

  it('is guarded in guard and open in windup and recover', () => {
    const guard = createOpponentAi(0, constantRng(0));
    expect(openingAt(guard, 0)).toBe('guard');
    expect(openingAt(guard, -100)).toBe('guard');
    const { state, at, phase } = startWindup(0.5, 0);
    expect(openingAt(state, at)).toBe('open');
    const resolveAt = phase.impactAtMs + IMPACT_GRACE_MS;
    expect(openingAt(stepOpponent(state, resolveAt, 0, noRng).state, resolveAt)).toBe('open');
  });

  it('adjudicates a past punch against the phase at that time', () => {
    const { state, at, phase } = startWindup(0.5, 0);
    expect(openingAt(state, at - 1)).toBe('guard');

    const resolveAt = phase.impactAtMs + IMPACT_GRACE_MS;
    const recover = stepOpponent(state, resolveAt, 0, noRng).state;
    expect(openingAt(recover, resolveAt - MAX_PUNCH_LOOKBACK_MS)).toBe('open');

    const guardAt = guardEnd(recover);
    const guard = stepOpponent(recover, guardAt, 0, constantRng(0)).state;
    expect(openingAt(guard, guardAt - 1)).toBe('open');
    expect(openingAt(guard, guardAt)).toBe('guard');
  });

  it('counts a dodge when any impact sample is out of the target zone', () => {
    expect(isDodged(0, [])).toBe(false);
    expect(isDodged(0, [0, 0, 0])).toBe(false);
    expect(isDodged(0, [0, 1, 0])).toBe(true);
    expect(isDodged(-1, [1])).toBe(true);
  });
});

describe('isDodgedTyped defense matrix', () => {
  const attack = (attackKind: 'straight' | 'hook' | 'uppercut', target: 'head' | 'body') => ({ attackKind, target, targetZone: 0 as const });
  const slipped = [1, 1] as const;
  const held = [0, 0] as const;

  it('straight to the head is slipped or ducked', () => {
    expect(isDodgedTyped(attack('straight', 'head'), [...slipped], [false])).toBe(true);
    expect(isDodgedTyped(attack('straight', 'head'), [...held], [true])).toBe(true);
    expect(isDodgedTyped(attack('straight', 'head'), [...held], [false])).toBe(false);
  });

  it('straight to the body is neither slipped nor ducked — only range or guard', () => {
    expect(isDodgedTyped(attack('straight', 'body'), [...slipped], [false])).toBe(false);
    expect(isDodgedTyped(attack('straight', 'body'), [...held], [true])).toBe(false);
  });

  it('hook is ducked but never slipped', () => {
    expect(isDodgedTyped(attack('hook', 'head'), [...held], [true])).toBe(true);
    expect(isDodgedTyped(attack('hook', 'head'), [...slipped], [false])).toBe(false);
  });

  it('uppercut is slipped but ducking into it never helps', () => {
    expect(isDodgedTyped(attack('uppercut', 'head'), [...slipped], [false])).toBe(true);
    expect(isDodgedTyped(attack('uppercut', 'head'), [...held], [true])).toBe(false);
    expect(isDodgedTyped(attack('uppercut', 'body'), [...slipped], [true])).toBe(true);
  });

  it('a duck anywhere inside the impact window counts', () => {
    expect(isDodgedTyped(attack('hook', 'head'), [...held], [false, true, false])).toBe(true);
  });
});

describe('contextual boxing decisions', () => {
  it('waits until the observed opponent is in range', () => {
    const state = createOpponentAi(0, () => 0);
    expect(stepOpponent(state, guardEnd(state), 0, noRng, { inRange: false, playerGuarding: false, style: 'technical' }).state).toBe(state);
  });

  it('uses repeated reliable defense patterns while retaining variety', () => {
    const state = createOpponentAi(0, () => 0);
    const decide = (habits: { samples: number; slips: number; ducks: number }) =>
      stepOpponent(state, guardEnd(state), 0, sequenceRng([0, 0, 0.73, 0.5]), {
        inRange: true, playerGuarding: true, style: 'aggressive', habits,
      }).state.phase;
    expect(decide({ samples: 1, slips: 1, ducks: 0 })).toMatchObject({ attackKind: 'uppercut' });
    expect(decide({ samples: 4, slips: 4, ducks: 0 })).toMatchObject({ attackKind: 'hook' });
  });
});
