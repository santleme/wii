import { describe, expect, it } from 'vitest';
import { tennisMissionValue } from '../src/games/tennis/tennisEngagement';

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
});
