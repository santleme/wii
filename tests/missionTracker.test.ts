import { describe, expect, it } from 'vitest';
import { MISSION_XP, type DailyMission } from '../src/games/engagement/missions';
import { MissionStore } from '../src/games/engagement/missionStore';
import { MissionTracker } from '../src/games/engagement/missionTracker';
import { ProgressStore, type KeyValueStorage } from '../src/games/engagement/progressStore';

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const mission: DailyMission = {
  id: '2026-11-25:track:0',
  sport: 'track',
  metric: 'score',
  target: 100,
  text: 'Marque 100 pontos em uma run',
};

describe('mission tracker', () => {
  it('keeps the high-watermark progress and completes only when the target is reached', () => {
    const tracker = new MissionTracker(new MissionStore(new MemoryStorage()), '2026-11-25', mission);
    expect(tracker.update(40)).toBe(false);
    expect(tracker.progress01()).toBe(0.4);
    expect(tracker.update(20)).toBe(false);
    expect(tracker.progress01()).toBe(0.4);
    expect(tracker.update(100)).toBe(true);
    expect(tracker.progress01()).toBe(1);
    expect(tracker.label()).toBe('✓ Marque 100 pontos em uma run · 100/100');
  });

  it('reports completion only once per tracker and for a tracker reloaded from the same day', () => {
    const backing = new MemoryStorage();
    const store = new MissionStore(backing);
    const tracker = new MissionTracker(store, '2026-11-25', mission);
    expect(tracker.update(100)).toBe(true);
    expect(tracker.update(100)).toBe(false);

    const reloaded = new MissionTracker(new MissionStore(backing), '2026-11-25', mission);
    expect(reloaded.isCompleted).toBe(true);
    expect(reloaded.update(100)).toBe(false);
  });

  it('resetValue starts a new attempt without reopening a completed mission', () => {
    const backing = new MemoryStorage();
    const tracker = new MissionTracker(new MissionStore(backing), '2026-11-25', mission);
    expect(tracker.update(100)).toBe(true);
    tracker.resetValue();
    expect(tracker.currentValue).toBe(0);
    expect(tracker.update(100)).toBe(false);
    expect(tracker.progress01()).toBe(1);
  });

  it('grants the mission xp only once when a later attempt reloads the same day', () => {
    const missionBacking = new MemoryStorage();
    const progressBacking = new MemoryStorage();
    const progressStore = new ProgressStore(progressBacking);
    const awardIfCompleted = (tracker: MissionTracker, value: number) => {
      if (tracker.update(value)) progressStore.addXp('track', MISSION_XP);
    };

    awardIfCompleted(new MissionTracker(new MissionStore(missionBacking), '2026-11-25', mission), 100);
    awardIfCompleted(new MissionTracker(new MissionStore(missionBacking), '2026-11-25', mission), 100);

    expect(progressStore.load('track').xp).toBe(MISSION_XP);
  });

  it('only grants mission xp once when open tabs race from stale trackers', () => {
    const missionBacking = new MemoryStorage();
    const progressStore = new ProgressStore();
    const firstTab = new MissionTracker(new MissionStore(missionBacking), '2026-11-25', mission);
    const secondTab = new MissionTracker(new MissionStore(missionBacking), '2026-11-25', mission);

    if (firstTab.update(100)) progressStore.addXp('track', MISSION_XP);
    if (secondTab.update(100)) progressStore.addXp('track', MISSION_XP);

    expect(progressStore.load('track').xp).toBe(MISSION_XP);
    expect(secondTab.isCompleted).toBe(true);
  });

  it('ignores malformed samples instead of corrupting progress', () => {
    const tracker = new MissionTracker(new MissionStore(new MemoryStorage()), '2026-11-25', mission);
    tracker.update(Number.NaN);
    tracker.update(-50);
    expect(tracker.currentValue).toBe(0);
    expect(tracker.progress01()).toBe(0);
  });
});
