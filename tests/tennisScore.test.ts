import { describe, expect, it } from 'vitest';
import {
  awardPoint,
  createScore,
  gameStatus,
  matchPerformance,
  matchXp,
  pointLabels,
  type PlayerSide,
  type TennisScoreState,
} from '../src/games/tennis/tennisScore';

const playPoints = (state: TennisScoreState, sides: PlayerSide[]): TennisScoreState =>
  sides.reduce((current, side) => awardPoint(current, side).state, state);

const straightGame = (side: PlayerSide): PlayerSide[] => [side, side, side, side];

describe('tennis score', () => {
  it('starts at 0-0 with the player serving and no match winner', () => {
    const state = createScore();
    expect(state.points).toEqual({ player: 0, opponent: 0 });
    expect(state.games).toEqual({ player: 0, opponent: 0 });
    expect(state.server).toBe('player');
    expect(state.matchWinner).toBeNull();
    expect(pointLabels(state)).toEqual({ player: '0', opponent: '0' });
  });

  it('counts points as 15/30/40 within a game', () => {
    const state = playPoints(createScore(), ['player', 'player', 'player']);
    expect(pointLabels(state)).toEqual({ player: '40', opponent: '0' });
    const mixed = playPoints(createScore(), ['player', 'opponent', 'player', 'opponent']);
    expect(pointLabels(mixed)).toEqual({ player: '30', opponent: '30' });
    expect(gameStatus(mixed)).toBe('in-progress');
  });

  it('wins a game at 4 points with a margin of 2 and resets the points', () => {
    let result = awardPoint(playPoints(createScore(), ['player', 'player', 'player']), 'player');
    expect(result.gameWonBy).toBe('player');
    expect(result.state.games).toEqual({ player: 1, opponent: 0 });
    expect(result.state.points).toEqual({ player: 0, opponent: 0 });

    // 4-2 is a win (margin of 2 without deuce).
    const fourTwo = playPoints(createScore(), ['player', 'opponent', 'player', 'opponent', 'player']);
    result = awardPoint(fourTwo, 'player');
    expect(result.gameWonBy).toBe('player');

    // 4-3 is never a win: the margin is only one.
    const advantage = playPoints(createScore(), [
      'player',
      'opponent',
      'player',
      'opponent',
      'player',
      'opponent',
      'player',
    ]);
    expect(advantage.points).toEqual({ player: 4, opponent: 3 });
    expect(awardPoint(advantage, 'opponent').gameWonBy).toBeNull();
  });

  it('alternates the server every game', () => {
    let state = createScore();
    state = playPoints(state, straightGame('player'));
    expect(state.server).toBe('opponent');
    state = playPoints(state, straightGame('opponent'));
    expect(state.server).toBe('player');
  });

  it('honours a custom first server', () => {
    const state = playPoints(createScore('opponent'), straightGame('player'));
    expect(createScore('opponent').server).toBe('opponent');
    expect(state.server).toBe('player');
  });

  it('scores deuce and advantage once both sides reach 40', () => {
    // 3-3: deuce, both labels read 40.
    const deuce = playPoints(createScore(), ['player', 'opponent', 'player', 'opponent', 'player', 'opponent']);
    expect(deuce.points).toEqual({ player: 3, opponent: 3 });
    expect(gameStatus(deuce)).toBe('deuce');
    expect(pointLabels(deuce)).toEqual({ player: '40', opponent: '40' });

    // 4-3: advantage, then back to deuce at 4-4.
    const advantage = awardPoint(deuce, 'player').state;
    expect(gameStatus(advantage)).toBe('advantage-player');
    expect(pointLabels(advantage)).toEqual({ player: 'AD', opponent: '40' });
    const deuceAgain = awardPoint(advantage, 'opponent').state;
    expect(gameStatus(deuceAgain)).toBe('deuce');
    expect(pointLabels(deuceAgain)).toEqual({ player: '40', opponent: '40' });

    // Advantage converts to a game only with the second consecutive point.
    const almostGame = awardPoint(deuceAgain, 'opponent');
    expect(almostGame.gameWonBy).toBeNull();
    expect(gameStatus(almostGame.state)).toBe('advantage-opponent');
    const game = awardPoint(almostGame.state, 'opponent');
    expect(game.gameWonBy).toBe('opponent');
  });

  it('ends the match when a side reaches 2 games', () => {
    const state = playPoints(createScore(), [...straightGame('player'), ...straightGame('player')]);
    expect(state.games).toEqual({ player: 2, opponent: 0 });
    expect(state.matchWinner).toBe('player');
  });

  it('ends the match at 2-1 as well and reports the winning point', () => {
    let state = createScore();
    state = playPoints(state, straightGame('player'));
    state = playPoints(state, straightGame('opponent'));
    expect(state.matchWinner).toBeNull();
    state = playPoints(state, ['player', 'player', 'player']);
    const final = awardPoint(state, 'player');
    expect(final.matchWonBy).toBe('player');
    expect(final.state.games).toEqual({ player: 2, opponent: 1 });
    expect(final.state.matchWinner).toBe('player');
  });

  it('ignores points after the match is over, returning the identical state', () => {
    const state = playPoints(createScore(), [...straightGame('player'), ...straightGame('player')]);
    const after = awardPoint(state, 'opponent');
    expect(after.state).toBe(state);
    expect(after.gameWonBy).toBeNull();
    expect(after.matchWonBy).toBeNull();
  });

  it('never mutates the state it is given', () => {
    const before = playPoints(createScore(), ['player', 'opponent', 'player']);
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown;
    awardPoint(before, 'opponent');
    awardPoint(before, 'player');
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot);
  });
});

describe('match performance progression', () => {
  it('explains the score as points, games, win bonus and best-rally bonus', () => {
    expect(matchPerformance({ pointsWon: 8, gamesWon: 2, won: true, bestRally: 6 })).toBe(8 * 10 + 2 * 40 + 100 + 6 * 2);
    expect(matchPerformance({ pointsWon: 8, gamesWon: 1, won: false, bestRally: 6 })).toBe(8 * 10 + 40 + 6 * 2);
  });

  it('sanitizes malformed inputs and keeps xp positive but proportional', () => {
    expect(matchPerformance({ pointsWon: -3, gamesWon: Number.NaN, won: false, bestRally: 2.8 })).toBe(4);
    expect(matchXp(0)).toBe(5);
    expect(matchXp(100)).toBe(25);
    expect(matchXp(Number.NaN)).toBe(5);
  });
});
