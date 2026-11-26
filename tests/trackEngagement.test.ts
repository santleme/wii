import { describe, expect, it } from 'vitest';
import { isTrackRecord, loadTrackProgress, trackMissionValue, trackRecordBest, trackRecordChase, trackRunXp } from '../src/games/track/trackEngagement';
import { ProgressStore, type KeyValueStorage } from '../src/games/engagement/progressStore';

class InterleavingStorage implements KeyValueStorage {
  value: string;
  writes = 0;
  private raceOnNextRead = false;

  constructor(initial: string, private readonly concurrentValue: string) {
    this.value = initial;
  }

  getItem(): string {
    const observed = this.value;
    if (this.raceOnNextRead) {
      this.raceOnNextRead = false;
      this.value = this.concurrentValue;
    }
    return observed;
  }

  setItem(_key: string, value: string): void {
    this.writes += 1;
    this.value = value;
  }

  interleaveAfterNextRead(): void {
    this.raceOnNextRead = true;
  }
}

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

  it('keeps a surpassed record marked as reachable after the live score drops', () => {
    expect(trackRecordChase(1200, 1250)).toBe('RITMO DE RECORDE');
    expect(trackRecordChase(1200, 1100)).toBe('FALTAM 101 P/ RECORDE');
    expect(trackRecordChase(0, 1250)).toBeUndefined();
  });

  it('uses a legacy Track score as a floor for record chase and record awards', () => {
    const recordBestScore = trackRecordBest(900, 1200);

    expect(recordBestScore).toBe(1200);
    expect(trackRecordChase(recordBestScore, 300)).toBe('FALTAM 901 P/ RECORDE');
    expect(isTrackRecord(300, recordBestScore)).toBe(false);
    expect(isTrackRecord(1201, recordBestScore)).toBe(true);
  });

  it('does not overwrite a newer Tennis snapshot while loading the legacy Track floor', () => {
    const initial = JSON.stringify({
      version: 1,
      sports: {
        track: { bestScore: 500, plays: 2, xp: 80 },
        tennis: { bestScore: 4, plays: 1, xp: 100 },
      },
    });
    const newerTennis = JSON.stringify({
      version: 1,
      sports: {
        track: { bestScore: 500, plays: 2, xp: 80 },
        tennis: { bestScore: 7, plays: 2, xp: 160 },
      },
    });
    const storage = new InterleavingStorage(initial, newerTennis);
    const store = new ProgressStore(storage);
    storage.interleaveAfterNextRead();

    const snapshot = loadTrackProgress(store, 1200);

    expect(snapshot.progress).toEqual({ bestScore: 500, plays: 2, xp: 80 });
    expect(snapshot.recordBestScore).toBe(1200);
    expect(storage.writes).toBe(0);
    expect(storage.value).toBe(newerTennis);
  });
});
