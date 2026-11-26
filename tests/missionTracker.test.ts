import { describe, expect, it } from 'vitest';
import { MISSION_XP, type DailyMission } from '../src/games/engagement/missions';
import { MissionStore } from '../src/games/engagement/missionStore';
import { MissionTracker } from '../src/games/engagement/missionTracker';
import { ProgressStore, type KeyValueStorage } from '../src/games/engagement/progressStore';
import { SerialMissionCompletionLock } from './helpers/missionCompletionLock';

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class ReentrantStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  onNextRead?: () => void;

  getItem(key: string): string | null {
    const observed = this.values.get(key) ?? null;
    const hook = this.onNextRead;
    this.onNextRead = undefined;
    hook?.();
    return observed;
  }

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
  it('keeps the high-watermark progress and completes only when the target is reached', async () => {
    const tracker = new MissionTracker(new MissionStore(new MemoryStorage(), new SerialMissionCompletionLock()), '2026-11-25', mission);
    expect(tracker.update(40)).toBe(false);
    expect(tracker.progress01()).toBe(0.4);
    expect(tracker.update(20)).toBe(false);
    expect(tracker.progress01()).toBe(0.4);
    await expect(tracker.update(100)).resolves.toBe(true);
    expect(tracker.progress01()).toBe(1);
    expect(tracker.label()).toBe('✓ Marque 100 pontos em uma run · 100/100');
  });

  it('reports completion only once per tracker and for a tracker reloaded from the same day', async () => {
    const backing = new MemoryStorage();
    const lock = new SerialMissionCompletionLock();
    const store = new MissionStore(backing, lock);
    const tracker = new MissionTracker(store, '2026-11-25', mission);
    await expect(tracker.update(100)).resolves.toBe(true);
    expect(tracker.update(100)).toBe(false);

    const reloaded = new MissionTracker(new MissionStore(backing, lock), '2026-11-25', mission);
    expect(reloaded.isCompleted).toBe(true);
    expect(reloaded.update(100)).toBe(false);
  });

  it('resetValue starts a new attempt without reopening a completed mission', async () => {
    const backing = new MemoryStorage();
    const tracker = new MissionTracker(new MissionStore(backing, new SerialMissionCompletionLock()), '2026-11-25', mission);
    await expect(tracker.update(100)).resolves.toBe(true);
    tracker.resetValue();
    expect(tracker.currentValue).toBe(0);
    expect(tracker.update(100)).toBe(false);
    expect(tracker.progress01()).toBe(1);
  });

  it('grants the mission xp only once when a later attempt reloads the same day', async () => {
    const missionBacking = new MemoryStorage();
    const progressBacking = new MemoryStorage();
    const progressStore = new ProgressStore(progressBacking);
    const lock = new SerialMissionCompletionLock();
    const awardIfCompleted = async (tracker: MissionTracker, value: number) => {
      if (await tracker.update(value)) await progressStore.addXp('track', MISSION_XP);
    };

    await awardIfCompleted(new MissionTracker(new MissionStore(missionBacking, lock), '2026-11-25', mission), 100);
    await awardIfCompleted(new MissionTracker(new MissionStore(missionBacking, lock), '2026-11-25', mission), 100);

    expect(progressStore.load('track').xp).toBe(MISSION_XP);
  });

  it('serializes two stale trackers that interleave between completion read and write', async () => {
    const missionBacking = new ReentrantStorage();
    const lock = new SerialMissionCompletionLock();
    const progressStore = new ProgressStore();
    const firstTab = new MissionTracker(new MissionStore(missionBacking, lock), '2026-11-25', mission);
    const secondTab = new MissionTracker(new MissionStore(missionBacking, lock), '2026-11-25', mission);
    let secondClaim: boolean | Promise<boolean> = false;
    missionBacking.onNextRead = () => { secondClaim = secondTab.update(100); };

    const firstClaim = firstTab.update(100);
    expect(typeof firstClaim).not.toBe('boolean');
    const firstAwarded = await firstClaim;
    const secondAwarded = await secondClaim;
    if (firstAwarded) await progressStore.addXp('track', MISSION_XP);
    if (secondAwarded) await progressStore.addXp('track', MISSION_XP);

    expect(progressStore.load('track').xp).toBe(MISSION_XP);
    expect([firstAwarded, secondAwarded]).toEqual([true, false]);
    expect(lock.requestedNames).toHaveLength(2);
    expect(secondTab.isCompleted).toBe(true);
  });

  it('ignores malformed samples instead of corrupting progress', () => {
    const tracker = new MissionTracker(new MissionStore(new MemoryStorage(), new SerialMissionCompletionLock()), '2026-11-25', mission);
    tracker.update(Number.NaN);
    tracker.update(-50);
    expect(tracker.currentValue).toBe(0);
    expect(tracker.progress01()).toBe(0);
  });
});
