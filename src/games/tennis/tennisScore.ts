/**
 * Pure tennis scoring state machine — no DOM, no Three.js, no timers.
 *
 * MVP rules (see docs/design-tenis.md §3.3): a game is won by the first side to reach
 * 4 points with a margin of 2 — the classic 15/30/40/deuce/advantage progression falls
 * out of that rule. Games alternate the server and the match is a plain best-of-3
 * (first to 2 games; no tie-break, no service box).
 *
 * States are immutable snapshots: transitions return fresh frozen objects and never
 * mutate their input, so callers can hold onto a state before a point and compare.
 */

export type PlayerSide = 'player' | 'opponent';
export type PointLabel = '0' | '15' | '30' | '40' | 'AD';
export type GameStatus = 'in-progress' | 'deuce' | 'advantage-player' | 'advantage-opponent';

export const POINTS_TO_WIN_GAME = 4;
export const GAME_POINT_MARGIN = 2;
export const GAMES_TO_WIN_MATCH = 2;

export interface TennisScoreState {
  /** Raw point counts of the current game; 3-3 is deuce, ahead by one from there is advantage. */
  readonly points: Readonly<Record<PlayerSide, number>>;
  readonly games: Readonly<Record<PlayerSide, number>>;
  /** Server of the current game; flips every time a game ends. */
  readonly server: PlayerSide;
  readonly matchWinner: PlayerSide | null;
}

export interface PointResult {
  readonly state: TennisScoreState;
  /** Set on the exact point that closed a game, null otherwise. */
  readonly gameWonBy: PlayerSide | null;
  /** Set on the exact point that closed the match, null otherwise. */
  readonly matchWonBy: PlayerSide | null;
}

const other = (side: PlayerSide): PlayerSide => (side === 'player' ? 'opponent' : 'player');

const freezeState = (state: TennisScoreState): TennisScoreState => {
  Object.freeze(state.points);
  Object.freeze(state.games);
  return Object.freeze(state);
};

export function createScore(firstServer: PlayerSide = 'player'): TennisScoreState {
  return freezeState({
    points: { player: 0, opponent: 0 },
    games: { player: 0, opponent: 0 },
    server: firstServer,
    matchWinner: null,
  });
}

export function awardPoint(state: TennisScoreState, side: PlayerSide): PointResult {
  if (state.matchWinner) return { state, gameWonBy: null, matchWonBy: null };

  const points = { ...state.points, [side]: state.points[side] + 1 };
  const margin = points[side] - points[other(side)];
  const gameWon = points[side] >= POINTS_TO_WIN_GAME && margin >= GAME_POINT_MARGIN;
  if (!gameWon) {
    return { state: freezeState({ ...state, points }), gameWonBy: null, matchWonBy: null };
  }

  const games = { ...state.games, [side]: state.games[side] + 1 };
  const matchWon = games[side] >= GAMES_TO_WIN_MATCH;
  const next = freezeState({
    points: { player: 0, opponent: 0 },
    games,
    server: other(state.server),
    matchWinner: matchWon ? side : null,
  });
  return { state: next, gameWonBy: side, matchWonBy: matchWon ? side : null };
}

const NUMERIC_LABELS: readonly PointLabel[] = ['0', '15', '30', '40'];

/**
 * Display labels for the current game. Deuce reads 40-40 (as in broadcast tennis);
 * the side ahead by one past deuce reads AD.
 */
export function pointLabels(state: TennisScoreState): Readonly<Record<PlayerSide, PointLabel>> {
  const player = state.points.player;
  const opponent = state.points.opponent;
  if (player >= 3 && opponent >= 3) {
    if (player === opponent) return { player: '40', opponent: '40' };
    return player > opponent ? { player: 'AD', opponent: '40' } : { player: '40', opponent: 'AD' };
  }
  return {
    player: NUMERIC_LABELS[Math.min(player, 3)]!,
    opponent: NUMERIC_LABELS[Math.min(opponent, 3)]!,
  };
}

export function gameStatus(state: TennisScoreState): GameStatus {
  const player = state.points.player;
  const opponent = state.points.opponent;
  if (player >= 3 && opponent >= 3) {
    if (player === opponent) return 'deuce';
    return player > opponent ? 'advantage-player' : 'advantage-opponent';
  }
  return 'in-progress';
}

export interface MatchPerformanceInput {
  readonly pointsWon: number;
  readonly gamesWon: number;
  readonly won: boolean;
  readonly bestRally: number;
}

/**
 * Arcade performance score for one match. Points are the base unit, games and the win matter
 * more, and the best rally gets a small bonus so a long exchange is visible even in a defeat.
 */
export function matchPerformance(input: MatchPerformanceInput): number {
  const cleanCount = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
  const points = cleanCount(input.pointsWon);
  const games = cleanCount(input.gamesWon);
  const rally = cleanCount(input.bestRally);
  return points * 10 + games * 40 + (input.won ? 100 : 0) + rally * 2;
}

/** Persistent XP is participation plus mastery: about a quarter of the match performance. */
export function matchXp(performance: number): number {
  const clean = Number.isFinite(performance) ? Math.max(0, performance) : 0;
  return Math.max(5, Math.round(clean / 4));
}
