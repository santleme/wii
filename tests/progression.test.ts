import { describe, expect, it } from 'vitest';
import { addSportXp, emptyProgress, progressionFor, recordSportResult } from '../src/games/engagement/progression';
import { ProgressStore, type KeyValueStorage, type ProgressMutationLock } from '../src/games/engagement/progressStore';
import { MissionStore } from '../src/games/engagement/missionStore';
import { MissionTracker } from '../src/games/engagement/missionTracker';
import { SerialMissionCompletionLock } from './helpers/missionCompletionLock';

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  failNextRemoval = false;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void {
    if (this.failNextRemoval) {
      this.failNextRemoval = false;
      throw new Error('interrupted cleanup');
    }
    this.values.delete(key);
  }
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
}

class InterleavingStorage implements KeyValueStorage {
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
  removeItem(key: string): void { this.values.delete(key); }
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
}

class DeferredProgressLock implements ProgressMutationLock {
  private release?: () => void;

  request<T>(_name: string, callback: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      this.release = () => {
        try { resolve(callback()); }
        catch (error) { reject(error); }
      };
    });
  }

  releaseNext(): void {
    const release = this.release;
    this.release = undefined;
    release?.();
  }
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
  it('persists independent sport progress in the backing storage', async () => {
    const backing = new MemoryStorage();
    const lock = new SerialMissionCompletionLock();
    const store = new ProgressStore(backing, lock);
    await store.record('track', 800, 80);
    await store.record('tennis', 3, 120);
    const reloaded = new ProgressStore(backing);
    expect(reloaded.load('track')).toEqual({ bestScore: 800, plays: 1, xp: 80 });
    expect(reloaded.load('tennis')).toEqual({ bestScore: 3, plays: 1, xp: 120 });
  });


  it('persists xp-only rewards through the backing storage', async () => {
    const backing = new MemoryStorage();
    const store = new ProgressStore(backing, new SerialMissionCompletionLock());
    await store.record('track', 800, 80);
    await store.addXp('track', 25);
    const reloaded = new ProgressStore(backing);
    expect(reloaded.load('track')).toEqual({ bestScore: 800, plays: 1, xp: 105 });
  });

  it('falls back to empty progress for corrupt storage', () => {
    const backing = new MemoryStorage();
    backing.setItem('wii-web-sports.progress.v1', '{not json');
    const store = new ProgressStore(backing);
    expect(store.load('track')).toEqual(emptyProgress());
  });



  it('keeps recording in memory when the backing storage rejects writes', async () => {
    const failing: KeyValueStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
    };
    const store = new ProgressStore(failing, new SerialMissionCompletionLock());
    await store.record('track', 100, 10);
    await store.record('track', 250, 20);
    expect(store.load('track')).toEqual({ bestScore: 250, plays: 2, xp: 30 });
  });
  it('keeps in-memory progress when no storage is available', async () => {
    const store = new ProgressStore();
    await store.record('track', 100, 10);
    expect(store.load('track')).toEqual({ bestScore: 100, plays: 1, xp: 10 });
  });

  it('keeps mission XP and a concurrent match record in the same snapshot', async () => {
    const backing = new InterleavingStorage();
    const lock = new SerialMissionCompletionLock();
    const missionStore = new ProgressStore(backing, lock);
    const matchStore = new ProgressStore(backing, lock);
    backing.setItem('wii-web-sports.progress.v1', JSON.stringify({
      version: 1,
      sports: { tennis: { bestScore: 100, plays: 1, xp: 100 } },
    }));
    let matchRecord: ReturnType<typeof matchStore.record> | undefined;
    backing.onNextRead = () => { matchRecord = matchStore.record('tennis', 500, 50); };

    const missionReward = await missionStore.addXp('tennis', 25);
    expect(matchRecord).toBeDefined();
    await matchRecord;

    expect(missionReward.progress.xp).toBe(125);
    expect(missionStore.load('tennis')).toEqual({ bestScore: 500, plays: 2, xp: 175 });
  });

  it('recovers a finished round queued before its progress lock was acquired', async () => {
    const backing = new MemoryStorage();
    const delayedLock = new DeferredProgressLock();
    const closingDocument = new ProgressStore(backing, delayedLock);
    void closingDocument.record('track', 800, 80);

    expect(closingDocument.load('track')).toEqual({ bestScore: 800, plays: 1, xp: 80 });

    const reloaded = new ProgressStore(backing, new SerialMissionCompletionLock());
    await reloaded.recoverPendingOperations();
    const persisted = JSON.parse(backing.getItem('wii-web-sports.progress.v1') ?? '{}');
    expect(persisted.sports.track).toEqual({ bestScore: 800, plays: 1, xp: 80 });
    expect(Object.keys(persisted.appliedOperations)).toHaveLength(1);
    const remainingKeys = Array.from({ length: backing.length }, (_, index) => backing.key(index));
    expect(remainingKeys.filter((key) => key?.startsWith('wii-web-sports.progress-op.v1:'))).toEqual([]);
    expect(new ProgressStore(backing).load('track')).toEqual({ bestScore: 800, plays: 1, xp: 80 });
  });

  it('does not apply a recovered round twice if interruption happens after the snapshot write', async () => {
    const backing = new MemoryStorage();
    backing.failNextRemoval = true;
    const firstDocument = new ProgressStore(backing, new SerialMissionCompletionLock());

    await firstDocument.record('tennis', 500, 50);

    const reloaded = new ProgressStore(backing, new SerialMissionCompletionLock());
    await reloaded.recoverPendingOperations();
    await reloaded.recoverPendingOperations();
    expect(reloaded.load('tennis')).toEqual({ bestScore: 500, plays: 1, xp: 50 });
  });

  it('commits daily mission completion and its XP in one progress snapshot', async () => {
    const backing = new MemoryStorage();
    const progress = new ProgressStore(backing, new SerialMissionCompletionLock());
    const missions = new MissionStore(undefined, undefined, progress);
    const mission = { id: 'mission', sport: 'track' as const, metric: 'score' as const, target: 100, text: 'Marque 100 pontos' };
    const tracker = new MissionTracker(missions, '2026-11-26', mission, 25);

    await expect(tracker.update(100)).resolves.toBe(true);

    const reloadedProgress = new ProgressStore(backing);
    const reloadedMissions = new MissionStore(undefined, undefined, reloadedProgress);
    expect(reloadedMissions.isCompleted('2026-11-26', 'track', 'mission')).toBe(true);
    expect(reloadedProgress.load('track')).toEqual({ bestScore: 0, plays: 0, xp: 25 });
    const reloadedTracker = new MissionTracker(reloadedMissions, '2026-11-26', mission, 25);
    expect(reloadedTracker.update(100)).toBe(false);
    expect(reloadedProgress.load('track').xp).toBe(25);
  });

  it('recovers a mission claim and XP queued before its progress lock was acquired', async () => {
    const backing = new MemoryStorage();
    const delayedLock = new DeferredProgressLock();
    const closingProgress = new ProgressStore(backing, delayedLock);
    const closingMissions = new MissionStore(undefined, undefined, closingProgress);
    void closingMissions.complete('2026-11-26', 'tennis', 'mission', 25);

    const reloadedProgress = new ProgressStore(backing, new SerialMissionCompletionLock());
    const reloadedMissions = new MissionStore(undefined, undefined, reloadedProgress);
    expect(reloadedMissions.isCompleted('2026-11-26', 'tennis', 'mission')).toBe(true);
    expect(reloadedProgress.load('tennis').xp).toBe(25);

    await reloadedProgress.recoverPendingOperations();
    await reloadedProgress.recoverPendingOperations();
    const persisted = JSON.parse(backing.getItem('wii-web-sports.progress.v1') ?? '{}');
    expect(persisted.sports.tennis).toEqual({ bestScore: 0, plays: 0, xp: 25 });
    expect(persisted.missions['2026-11-26:tennis']).toEqual(['mission']);
    const remainingKeys = Array.from({ length: backing.length }, (_, index) => backing.key(index));
    expect(remainingKeys.filter((key) => key?.startsWith('wii-web-sports.progress-op.v1:'))).toEqual([]);
    expect(reloadedProgress.load('tennis').xp).toBe(25);
  });

});
