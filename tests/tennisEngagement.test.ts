import { describe, expect, it } from 'vitest';
import { RallyTracker, tennisMissionValue } from '../src/games/tennis/tennisEngagement';

describe('tennis engagement metrics', () => {
  it('reads performance, rally and win mission values from the match sample', () => {
    const sample = { performance: 180, bestRally: 5, won: true };
    expect(tennisMissionValue('performance', sample)).toBe(180);
    expect(tennisMissionValue('rally', sample)).toBe(5);
    expect(tennisMissionValue('win', sample)).toBe(1);
    expect(tennisMissionValue('win', { ...sample, won: false })).toBe(0);
  });

  it('ignores mission metrics owned by track', () => {
    expect(tennisMissionValue('combo', { performance: 180, bestRally: 5, won: true })).toBe(0);
  });

  it('counts a rally from either serve and resets its count at the point boundary', () => {
    const fromPlayerServe = new RallyTracker();
    fromPlayerServe.recordHit();
    fromPlayerServe.recordHit();
    expect(fromPlayerServe.current).toBe(2);
    expect(fromPlayerServe.finishPoint()).toBe(2);
    expect(fromPlayerServe.current).toBe(0);

    const fromOpponentServe = new RallyTracker();
    fromOpponentServe.opponentServeStarted();
    fromOpponentServe.recordHit();
    fromOpponentServe.recordHit();
    expect(fromOpponentServe.current).toBe(3);
    expect(fromOpponentServe.finishPoint()).toBe(3);
    expect(fromOpponentServe.finishPoint()).toBe(0);
  });
});
