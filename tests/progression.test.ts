import { describe, expect, it } from 'vitest';
import { addSportXp, emptyProgress, progressionFor, recordSportResult } from '../src/games/engagement/progression';
import { ProgressStore, type KeyValueStorage } from '../src/games/engagement/progressStore';

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('sport progression', () => {
  it('starts at novice with progress toward bronze', () => {
    expect(progressionFor(0)).toMatchObject({ rank: 'NOVATO', progress01: 0, xpToNextRank: 100 });
    expect(progressionFor(50)).toMatchObject({ rank: 'NOVATO', progress01: 0.5, xpToNextRank: 50 });
  });

  it('crosses rank boundaries using total xp, not per-session score', () => {
    expect(progressionFor(100)).toMatchObject({ rank: 'BRONZE', progress01: 0 });
    expect(progressionFor(699)).toMatchObject({ rank: 'PRATA' });
    expect(progressionFor(700)).toMatchObject({ rank: 'OURO' });
  });

  it('records best score, plays and xp without mutating the prior progress', () => {
    const before = { bestScore: 400, plays: 2, xp: 90 };
    const result = recordSportResult(before, 500, 20);
    expect(result.isRecord).toBe(true);
    expect(result.rankUp).toBe(true);
    expect(result.progress).toEqual({ bestScore: 500, plays: 3, xp: 110 });
    expect(before).toEqual({ bestScore: 400, plays: 2, xp: 90 });
  });

  it('does not lower the best score or count malformed xp', () => {
    const result = recordSportResult({ bestScore: 400, plays: 2, xp: 90 }, 300, Number.NaN);
    expect(result.progress).toEqual({ bestScore: 400, plays: 3, xp: 90 });
    expect(result.isRecord).toBe(false);
  });


  it('grants mission xp without counting a play or changing the best score', () => {
    const before = { bestScore: 400, plays: 2, xp: 90 };
    const result = addSportXp(before, 25);
    expect(result.progress).toEqual({ bestScore: 400, plays: 2, xp: 115 });
    expect(result.rankUp).toBe(true);
    expect(before).toEqual({ bestScore: 400, plays: 2, xp: 90 });
  });
});

describe('progress storage', () => {
  it('persists independent sport progress in the backing storage', () => {
    const backing = new MemoryStorage();
    const store = new ProgressStore(backing);
    store.record('track', 800, 80);
    store.record('tennis', 3, 120);
    const reloaded = new ProgressStore(backing);
    expect(reloaded.load('track')).toEqual({ bestScore: 800, plays: 1, xp: 80 });
    expect(reloaded.load('tennis')).toEqual({ bestScore: 3, plays: 1, xp: 120 });
  });


  it('persists xp-only rewards through the backing storage', () => {
    const backing = new MemoryStorage();
    const store = new ProgressStore(backing);
    store.record('track', 800, 80);
    store.addXp('track', 25);
    const reloaded = new ProgressStore(backing);
    expect(reloaded.load('track')).toEqual({ bestScore: 800, plays: 1, xp: 105 });
  });

  it('falls back to empty progress for corrupt storage', () => {
    const backing = new MemoryStorage();
    backing.setItem('wii-web-sports.progress.v1', '{not json');
    const store = new ProgressStore(backing);
    expect(store.load('track')).toEqual(emptyProgress());
  });



  it('keeps recording in memory when the backing storage rejects writes', () => {
    const failing: KeyValueStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
    };
    const store = new ProgressStore(failing);
    store.record('track', 100, 10);
    store.record('track', 250, 20);
    expect(store.load('track')).toEqual({ bestScore: 250, plays: 2, xp: 30 });
  });
  it('keeps in-memory progress when no storage is available', () => {
    const store = new ProgressStore();
    store.record('track', 100, 10);
    expect(store.load('track')).toEqual({ bestScore: 100, plays: 1, xp: 10 });
  });

});
