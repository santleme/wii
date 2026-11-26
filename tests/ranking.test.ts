import { describe, expect, it } from 'vitest';
import { highestRankedScore, parseRanking, rankRun } from '../src/games/track/ranking';

describe('personal ranking', () => {
  it('places the run among the previous ones', () => {
    expect(rankRun([500, 100], 300)).toEqual({ points: 300, ranking: [500, 300, 100], position: 2 });
  });

  it('keeps only the top five and marks a run that missed it', () => {
    expect(rankRun([500, 400, 300, 200, 100], 50)).toEqual({ points: 50, ranking: [500, 400, 300, 200, 100], position: undefined });
  });

  it('ignores corrupted storage', () => {
    expect(parseRanking(null)).toEqual([]);
    expect(parseRanking('oops')).toEqual([]);
    expect(parseRanking('{"a":1}')).toEqual([]);
    expect(parseRanking('[10,"x",null,5]')).toEqual([10, 5]);
  });

  it('finds the highest legacy score even if stored ranking order is malformed', () => {
    expect(parseRanking('[300,1200,500]')).toEqual([300, 1200, 500]);
    expect(highestRankedScore([300, 1200, 500])).toBe(1200);
  });
});
