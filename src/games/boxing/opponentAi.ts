/**
 * Pure boxing opponent AI — no DOM, no Three.js, no Math.random, no clocks.
 *
 * The opponent cycles guard -> windup -> recover -> guard, with at most one transition
 * per `stepOpponent` call. Time and `rng` (a `() => number` in [0, 1)) are injected,
 * and rolls are consumed in a fixed order:
 * - `createOpponentAi`: (1) guard duration.
 * - guard -> windup: (1) hand, (2) windup duration, (3) attack kind, (4) target height.
 * - windup -> recover: none.
 * - recover -> guard: (1) guard duration.
 * - a step without a transition: none.
 *
 * Punches are adjudicated at their past peak time, so `openingAt` looks back through
 * `previous`. One step of history is enough because every phase is measured from the
 * step that started it and lasts longer than MAX_PUNCH_LOOKBACK_MS: that window never
 * spans two transitions. There is deliberately no reaction to being hit, so punches
 * cannot stunlock the opponent.
 */

import type { Hand, PunchKind, PunchTargetZone } from '../../cv/protocol';

/** Lateral position of the player: left, center, right. */
export type Zone = -1 | 0 | 1;
export type { Hand };

export type OpponentPhase =
  | { readonly kind: 'guard'; readonly untilMs: number }
  | { readonly kind: 'windup'; readonly hand: Hand; readonly targetZone: Zone; readonly impactAtMs: number; readonly attackKind: Exclude<PunchKind, 'unknown'>; readonly target: Exclude<PunchTargetZone, 'unknown'> }
  | { readonly kind: 'recover'; readonly untilMs: number };

export interface OpponentAiState {
  /** 0..1; higher guards shorter, winds up faster and recovers sooner. */
  readonly skill: number;
  readonly phase: OpponentPhase;
  readonly previous?: OpponentPhase;
  readonly phaseStartedMs: number;
}

export interface OpponentAttack {
  readonly hand: Hand;
  readonly targetZone: Zone;
  readonly impactAtMs: number;
  readonly attackKind: Exclude<PunchKind, 'unknown'>;
  readonly target: Exclude<PunchTargetZone, 'unknown'>;
}

export interface OpponentStep {
  readonly state: OpponentAiState;
  readonly attack?: OpponentAttack;
}

export const DEFAULT_SKILL = 0.5;
/** Delay after impact before an attack is resolved, to absorb pose latency. */
export const IMPACT_GRACE_MS = 150;
/** Oldest punch time, relative to now, that `openingAt` is guaranteed to answer correctly. */
export const MAX_PUNCH_LOOKBACK_MS = 450;
export const WINDUP_MIN_MS = 600;
export const WINDUP_MAX_MS = 900;
const WINDUP_JITTER_MS = 100;
/** Shortest guard at skill 0 / skill 1, before jitter. */
const GUARD_SLOW_MS = 900;
const GUARD_FAST_MS = 500;
const GUARD_JITTER_MS = 800;
const RECOVER_SLOW_MS = 800;
const RECOVER_FAST_MS = 500;

const lerp = (from: number, to: number, t: number): number => from + (to - from) * t;

const guardPhase = (nowMs: number, skill: number, rng: () => number): OpponentPhase => ({
  kind: 'guard',
  untilMs: nowMs + lerp(GUARD_SLOW_MS, GUARD_FAST_MS, skill) + rng() * GUARD_JITTER_MS,
});

const enter = (state: OpponentAiState, phase: OpponentPhase, nowMs: number): OpponentAiState =>
  Object.freeze({
    skill: state.skill,
    phase: Object.freeze(phase),
    previous: state.phase,
    phaseStartedMs: nowMs,
  });

/** `skill` is clamped to 0..1; a non-finite value falls back to DEFAULT_SKILL. */
export function createOpponentAi(nowMs: number, rng: () => number, skill = DEFAULT_SKILL): OpponentAiState {
  const clamped = Number.isFinite(skill) ? Math.min(1, Math.max(0, skill)) : DEFAULT_SKILL;
  return Object.freeze({
    skill: clamped,
    phase: Object.freeze(guardPhase(nowMs, clamped, rng)),
    phaseStartedMs: nowMs,
  });
}

/**
 * Advances the cycle. A windup aims at the zone the player occupies when it starts.
 * `attack` is returned exactly once per windup, on the first step at or after
 * `impactAtMs + IMPACT_GRACE_MS`; the caller collects the player's zones over
 * [impactAtMs, impactAtMs + IMPACT_GRACE_MS] and judges them with `isDodged`.
 */
export interface OpponentObservation {
  readonly inRange: boolean;
  readonly playerGuarding: boolean;
  readonly style: 'rookie' | 'aggressive' | 'technical';
  /** Confirmed outcomes only, bounded to recent attacks by the caller. */
  readonly habits?: { readonly samples: number; readonly slips: number; readonly ducks: number };
}

export function stepOpponent(state: OpponentAiState, nowMs: number, playerZone: Zone, rng: () => number, observation?: OpponentObservation): OpponentStep {
  const { phase, skill } = state;
  switch (phase.kind) {
    case 'guard': {
      if (nowMs < phase.untilMs || observation?.inRange === false) return { state };
      const hand: Hand = rng() < 0.5 ? 'left' : 'right';
      // Skill takes up to 200 ms off and jitter up to 100 ms, so the result stays in range.
      const durationMs =
        WINDUP_MAX_MS - skill * (WINDUP_MAX_MS - WINDUP_MIN_MS - WINDUP_JITTER_MS) - rng() * WINDUP_JITTER_MS;
      const kindRoll = rng();
      // A pattern must be repeated before it influences the next legal action. Exploration
      // remains possible: the smallest action share is 10%, even for a strong pattern.
      const habits = observation?.habits;
      const slip = habits && habits.samples >= 3 ? habits.slips / habits.samples : 0;
      const duck = habits && habits.samples >= 3 ? habits.ducks / habits.samples : 0;
      const baseStraight = observation?.style === 'technical' ? 0.65 : observation?.style === 'aggressive' ? 0.35 : 0.5;
      const straightThreshold = Math.max(0.1, baseStraight - 0.2 * Math.max(slip, duck));
      const hookShare = Math.min(0.8 - straightThreshold, 0.3 + 0.3 * slip);
      const attackKind = kindRoll < straightThreshold ? 'straight' : kindRoll < straightThreshold + hookShare ? 'hook' : 'uppercut';
      // The player's guard protects both heights equally; do not pretend body targets bypass it.
      const headChance = observation?.style === 'aggressive' ? 0.8 : 0.7;
      const target = rng() < headChance ? 'head' : 'body';
      return {
        state: enter(state, { kind: 'windup', hand, targetZone: playerZone, impactAtMs: nowMs + durationMs, attackKind, target }, nowMs),
      };
    }
    case 'windup': {
      if (nowMs < phase.impactAtMs + IMPACT_GRACE_MS) return { state };
      const { hand, targetZone, impactAtMs, attackKind, target } = phase;
      const untilMs = nowMs + lerp(RECOVER_SLOW_MS, RECOVER_FAST_MS, skill);
      return {
        state: enter(state, { kind: 'recover', untilMs }, nowMs),
        attack: { hand, targetZone, impactAtMs, attackKind, target },
      };
    }
    case 'recover': {
      if (nowMs < phase.untilMs) return { state };
      return { state: enter(state, guardPhase(nowMs, skill, rng), nowMs) };
    }
  }
}

/** Whether a punch peaking at `atMs` finds the opponent exposed (winding up or recovering). */
export function openingAt(state: OpponentAiState, atMs: number): 'open' | 'guard' {
  const phase = atMs < state.phaseStartedMs ? (state.previous ?? state.phase) : state.phase;
  return phase.kind === 'guard' ? 'guard' : 'open';
}

/** True if any sample shows the player outside `targetZone`; no samples means not dodged. */
export function isDodged(targetZone: Zone, zonesDuringImpact: readonly Zone[]): boolean {
  return zonesDuringImpact.some((zone) => zone !== targetZone);
}

/**
 * The defense matrix, kept deliberately small and memorable:
 * - straight to the head: slip or duck;
 * - straight to the body: neither slip nor duck — step back out of range or guard;
 * - hook: duck (a slip does not move the head out of the arc);
 * - uppercut: slip — ducking into it never helps;
 * - anything else must be guarded or stepped out of range.
 */
export function isDodgedTyped(
  attack: Pick<OpponentAttack, 'attackKind' | 'target' | 'targetZone'>,
  zonesDuringImpact: readonly Zone[],
  duckedDuringImpact: readonly boolean[],
): boolean {
  const slipped = isDodged(attack.targetZone, zonesDuringImpact);
  const ducked = duckedDuringImpact.some(Boolean);
  switch (attack.attackKind) {
    case 'straight':
      if (attack.target === 'body') return false;
      return slipped || ducked;
    case 'hook':
      return ducked;
    case 'uppercut':
      return slipped;
  }
}
