import { describe, expect, it } from 'vitest';
import { hash32, mulberry32 } from '../src/games/engagement/seededRandom';

describe('seeded random', () => {
  it('hashes the same input deterministically and distinguishes nearby seeds', () => {
    expect(hash32('2026-11-25:track')).toBe(hash32('2026-11-25:track'));
    expect(hash32('2026-11-25:track')).not.toBe(hash32('2026-11-26:track'));
  });

  it('repeats the same sequence for the same seed and keeps values in [0, 1)', () => {
    const first = mulberry32(42);
    const second = mulberry32(42);
    const sequence = [first(), first(), first(), first()];
    expect(sequence).toEqual([second(), second(), second(), second()]);
    for (const value of sequence) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
