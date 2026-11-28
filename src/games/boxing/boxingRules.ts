/**
 * Pure boxing match rules — no DOM, no Three.js, no timers.
 *
 * Three timed rounds; HP carries across rounds. A KO ends the match at once, otherwise
 * the side with more HP when the last round expires wins (equal HP is a draw). A
 * punch into the opponent's guard is fully blocked unless it is a counter, which also hits
 * harder. A dodged opponent punch does nothing; a guarded one does a tenth of its damage.
 *
 * States are immutable snapshots: transitions return fresh frozen objects and never
 * mutate their input. Once `winner` is set every transition is a no-op, except
 * `applyLatePunch` on a match decided by the clock.
 */

export type BoxingSide = 'player' | 'opponent';
export type BoxingWinner = BoxingSide | 'draw';
export type BoxingOpening = 'open' | 'guard';
export type PlayerPunchKind = 'unknown' | 'straight' | 'hook' | 'uppercut';
export type PlayerPunchTarget = 'unknown' | 'head' | 'body';

export const MAX_HP = 100;
export const ROUND_COUNT = 3;
export const ROUND_MS = 60_000;
/** Damage of an unblocked player punch at power 0 / power 1. */
export const PLAYER_MIN_DAMAGE = 4;
export const PLAYER_MAX_DAMAGE = 12;
export const OPPONENT_DAMAGE = 10;
export const COUNTER_MULTIPLIER = 1.5;
/** Share of an opponent punch that still gets through the player's guard. */
export const GUARDED_DAMAGE_RATIO = 0.1;

export interface BoxingState {
  readonly playerHp: number;
  readonly opponentHp: number;
  /** 1-based round number. */
  readonly round: number;
  readonly roundMsLeft: number;
  readonly winner?: BoxingWinner;
}

export interface PunchResult {
  readonly state: BoxingState;
  /** HP actually removed by this punch. */
  readonly damage: number;
  /** True on the exact punch that knocked the target out. */
  readonly ko: boolean;
}

export interface TickResult {
  readonly state: BoxingState;
  /** True on the exact tick that expired a round. */
  readonly roundEnded: boolean;
  /** True on the exact tick that expired the last round. */
  readonly matchEnded: boolean;
}

export function createBoxing(): BoxingState {
  return Object.freeze({ playerHp: MAX_HP, opponentHp: MAX_HP, round: 1, roundMsLeft: ROUND_MS });
}

function punch(state: BoxingState, attacker: BoxingSide, rawDamage: number): PunchResult {
  const targetHp = attacker === 'player' ? state.opponentHp : state.playerHp;
  const damage = Math.min(targetHp, rawDamage);
  if (state.winner || damage <= 0) return { state, damage: 0, ko: false };

  const hp = targetHp - damage;
  const ko = hp === 0;
  const next: BoxingState = Object.freeze({
    ...state,
    ...(attacker === 'player' ? { opponentHp: hp } : { playerHp: hp }),
    ...(ko ? { winner: attacker } : {}),
  });
  return { state: next, damage, ko };
}

/** Uppercut commitment bonus when the opponent is open. */
export const UPPERCUT_OPEN_MULTIPLIER = 1.25;
/** A hook's arc partially bypasses a high guard. */
export const HOOK_GUARD_PENETRATION = 0.5;
/** Body punches cost less HP but the high guard does not protect the body at all. */
export const BODY_DAMAGE_MULTIPLIER = 0.75;

/**
 * `power01` is clamped to 0..1; a non-finite power counts as 0 (weakest punch). A `counter`
 * goes through the guard. Type and target modulate risk/reward without creating impossible
 * punches, and anything unrecognized degrades to the generic straight-to-the-head behavior:
 * - uppercut into an opening hits harder;
 * - hook partially penetrates the guard;
 * - body punches do reduced damage, but the high guard never blocks them.
 */
export function applyPlayerPunch(
  state: BoxingState,
  power01: number,
  opening: BoxingOpening,
  counter = false,
  kind: PlayerPunchKind = 'unknown',
  target: PlayerPunchTarget = 'unknown',
): PunchResult {
  const power = Number.isFinite(power01) ? Math.min(1, Math.max(0, power01)) : 0;
  let damage = Math.round(PLAYER_MIN_DAMAGE + (PLAYER_MAX_DAMAGE - PLAYER_MIN_DAMAGE) * power);
  if (kind === 'uppercut' && opening === 'open') damage = Math.round(damage * UPPERCUT_OPEN_MULTIPLIER);
  if (target === 'body') damage = Math.max(1, Math.round(damage * BODY_DAMAGE_MULTIPLIER));
  if (counter) return punch(state, 'player', Math.round(damage * COUNTER_MULTIPLIER));
  if (opening !== 'guard') return punch(state, 'player', damage);
  if (target === 'body') return punch(state, 'player', damage);
  if (kind === 'hook') return punch(state, 'player', Math.round(damage * HOOK_GUARD_PENETRATION));
  return punch(state, 'player', 0);
}

/** The winner on time: more HP, equal is a draw. */
function decide({ playerHp, opponentHp }: BoxingState): BoxingWinner {
  return playerHp === opponentHp ? 'draw' : playerHp > opponentHp ? 'player' : 'opponent';
}

/**
 * A player punch thrown before a bell but confirmed after it. On a match the clock already
 * decided, it can knock out or change the decision; a knockout is never reopened.
 */
export function applyLatePunch(
  state: BoxingState, power01: number, opening: BoxingOpening, counter = false,
  kind: PlayerPunchKind = 'unknown', target: PlayerPunchTarget = 'unknown',
): PunchResult {
  const onTime = state.winner !== undefined && state.roundMsLeft === 0 && state.playerHp > 0 && state.opponentHp > 0;
  if (!onTime) return applyPlayerPunch(state, power01, opening, counter, kind, target);
  const { winner: _decision, ...open } = state;
  const result = applyPlayerPunch(open, power01, opening, counter, kind, target);
  if (result.ko) return result;
  return { ...result, state: Object.freeze({ ...result.state, winner: decide(result.state) }) };
}

export function applyOpponentPunch(
  state: BoxingState,
  { dodged, guarded = false }: { dodged: boolean; guarded?: boolean },
): PunchResult {
  const damage = guarded ? Math.round(OPPONENT_DAMAGE * GUARDED_DAMAGE_RATIO) : OPPONENT_DAMAGE;
  return punch(state, 'opponent', dodged ? 0 : damage);
}

/**
 * Advances the round clock. Non-finite or non-positive `dtMs` is ignored. A single
 * tick ends at most one round; time past the bell is dropped.
 */
export function tickRound(state: BoxingState, dtMs: number): TickResult {
  if (state.winner || !Number.isFinite(dtMs) || dtMs <= 0) {
    return { state, roundEnded: false, matchEnded: false };
  }

  const roundMsLeft = state.roundMsLeft - dtMs;
  if (roundMsLeft > 0) {
    return { state: Object.freeze({ ...state, roundMsLeft }), roundEnded: false, matchEnded: false };
  }

  if (state.round < ROUND_COUNT) {
    const next = Object.freeze({ ...state, round: state.round + 1, roundMsLeft: ROUND_MS });
    return { state: next, roundEnded: true, matchEnded: false };
  }

  return { state: Object.freeze({ ...state, roundMsLeft: 0, winner: decide(state) }), roundEnded: true, matchEnded: true };
}
