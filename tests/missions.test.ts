import { describe, expect, it } from 'vitest';
import { dailyMissionFor, localDateIso, missionProgress01 } from '../src/games/engagement/missions';
import { MissionStore } from '../src/games/engagement/missionStore';
import type { KeyValueStorage } from '../src/games/engagement/progressStore';
import type { SportKey } from '../src/games/engagement/progression';
import { SerialMissionCompletionLock } from './helpers/missionCompletionLock';

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe('daily missions', () => {
  it('is deterministic for the same date and sport without coupling the sports', () => {
    expect(dailyMissionFor('track', '2026-11-25')).toEqual(dailyMissionFor('track', '2026-11-25'));
    expect(dailyMissionFor('tennis', '2026-11-25')).toEqual(dailyMissionFor('tennis', '2026-11-25'));
    expect(dailyMissionFor('track', '2026-11-25').id).not.toBe(dailyMissionFor('tennis', '2026-11-25').id);
  });


  it('formats the local calendar date as the yyyy-mm-dd seed', () => {
    expect(localDateIso(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('rotates missions across a week instead of pinning one fixed goal', () => {
    for (const sport of ['track', 'tennis'] as SportKey[]) {
      const texts = new Set(Array.from({ length: 14 }, (_, index) => dailyMissionFor(sport, `2026-11-${String(index + 1).padStart(2, '0')}`).text));
      expect(texts.size).toBeGreaterThan(1);
    }
  });

  it('clamps live progress and rejects malformed values', () => {
    expect(missionProgress01(0, 10)).toBe(0);
    expect(missionProgress01(5, 10)).toBe(0.5);
    expect(missionProgress01(12, 10)).toBe(1);
    expect(missionProgress01(Number.NaN, 10)).toBe(0);
    expect(missionProgress01(5, 0)).toBe(0);
  });
});

describe('mission completion storage', () => {
  it('persists completion independently by date and sport', async () => {
    const backing = new MemoryStorage();
    const lock = new SerialMissionCompletionLock();
    const store = new MissionStore(backing, lock);
    const mission = dailyMissionFor('track', '2026-11-25');
    await store.complete('2026-11-25', 'track', mission.id);
    const reloaded = new MissionStore(backing, lock);
    expect(reloaded.isCompleted('2026-11-25', 'track', mission.id)).toBe(true);
    expect(reloaded.isCompleted('2026-11-25', 'tennis', mission.id)).toBe(false);
    expect(reloaded.isCompleted('2026-11-26', 'track', mission.id)).toBe(false);
  });

  it('is idempotent and survives a storage write failure in memory', async () => {
    const failing: KeyValueStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
    };
    const store = new MissionStore(failing, new SerialMissionCompletionLock());
    await store.complete('2026-11-25', 'track', 'mission');
    await store.complete('2026-11-25', 'track', 'mission');
    expect(store.isCompleted('2026-11-25', 'track', 'mission')).toBe(true);
  });

  it('drops corrupt backing data instead of crashing gameplay', () => {
    const backing = new MemoryStorage();
    backing.setItem('wii-web-sports.missions.v1', '{bad');
    const store = new MissionStore(backing);
    expect(store.isCompleted('2026-11-25', 'track', 'mission')).toBe(false);
  });

  it('persists sequential completion when origin-wide locks are unavailable', async () => {
    const backing = new MemoryStorage();
    const store = new MissionStore(backing);

    await expect(store.complete('2026-11-25', 'track', 'mission')).resolves.toBe(true);

    expect(store.isCompleted('2026-11-25', 'track', 'mission')).toBe(true);
    const reloaded = new MissionStore(backing);
    expect(reloaded.isCompleted('2026-11-25', 'track', 'mission')).toBe(true);
    await expect(reloaded.complete('2026-11-25', 'track', 'mission')).resolves.toBe(false);
  });
});
