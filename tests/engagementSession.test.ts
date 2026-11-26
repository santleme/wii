import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBrowserEngagementStores } from '../src/games/engagement/browserStores';
import { DailyMissionSession } from '../src/games/engagement/dailyMissionSession';
import { MissionStore } from '../src/games/engagement/missionStore';
import type { KeyValueStorage } from '../src/games/engagement/progressStore';
import { SerialMissionCompletionLock } from './helpers/missionCompletionLock';

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

afterEach(() => vi.unstubAllGlobals());

describe('engagement session lifetime', () => {
  it('keeps progress and completed missions when an engine is recreated without storage', async () => {
    const blockedStorage: KeyValueStorage = {
      getItem: () => { throw new Error('storage blocked'); },
      setItem: () => { throw new Error('storage blocked'); },
    };
    vi.stubGlobal('window', { get localStorage() { return blockedStorage; } });

    const firstEngineStores = getBrowserEngagementStores();
    await firstEngineStores.progress.record('track', 800, 80);
    await firstEngineStores.missions.complete('2026-11-25', 'track', 'mission-1');

    const restartedEngineStores = getBrowserEngagementStores();
    expect(restartedEngineStores).toBe(firstEngineStores);
    expect(restartedEngineStores.progress.load('track')).toEqual({ bestScore: 800, plays: 1, xp: 80 });
    expect(restartedEngineStores.missions.isCompleted('2026-11-25', 'track', 'mission-1')).toBe(true);
  });

  it('keeps the current mission through a same-day rematch and rolls over at midnight', async () => {
    const session = new DailyMissionSession(new MissionStore(new MemoryStorage(), new SerialMissionCompletionLock()), 'tennis', '2026-11-25');
    const yesterday = session.mission;
    await expect(session.tracker.update(yesterday.target)).resolves.toBe(true);

    session.startAttempt('2026-11-25');
    expect(session.mission).toBe(yesterday);
    expect(session.tracker.isCompleted).toBe(true);
    expect(session.tracker.currentValue).toBe(0);

    session.startAttempt('2026-11-26');
    expect(session.mission.id.startsWith('2026-11-26:tennis:')).toBe(true);
    expect(session.mission.id).not.toBe(yesterday.id);
    expect(session.tracker.isCompleted).toBe(false);
  });
});
