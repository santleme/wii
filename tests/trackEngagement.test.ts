import { describe, expect, it } from 'vitest';
import { trackMissionValue, trackRunXp } from '../src/games/track/trackEngagement';

describe('track engagement metrics', () => {
  it('converts the final run score to xp by dividing by ten and rounding down', () => {
    expect(trackRunXp(0)).toBe(0);
    expect(trackRunXp(799)).toBe(79);
    expect(trackRunXp(800)).toBe(80);
    expect(trackRunXp(Number.NaN)).toBe(0);
    expect(trackRunXp(-100)).toBe(0);
  });

  it('reads score and combo mission values from the run high-watermarks', () => {
    const sample = { score: 950, bestCombo: 4 };
    expect(trackMissionValue('score', sample)).toBe(950);
    expect(trackMissionValue('combo', sample)).toBe(4);
  });

  it('ignores mission metrics owned by other sports', () => {
    expect(trackMissionValue('rally', { score: 950, bestCombo: 4 })).toBe(0);
  });
});
