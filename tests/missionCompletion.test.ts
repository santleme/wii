import { describe, expect, it } from 'vitest';
import { applyMissionReward, MissionCompletionCache, missionCompletionKey } from '../src/games/engagement/missionCompletion';
import { MissionStore } from '../src/games/engagement/missionStore';
import { MissionTracker } from '../src/games/engagement/missionTracker';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('mission completion callbacks', () => {
  it('shares only pending claims and allows the same mission ID on a new date', async () => {
    const cache = new MissionCompletionCache();
    const firstClaim = deferred<boolean>();
    const firstKey = missionCompletionKey('2026-11-25', 'tennis', 'same-id');
    const secondKey = missionCompletionKey('2026-11-26', 'tennis', 'same-id');
    let starts = 0;

    const pending = cache.run(firstKey, () => { starts += 1; return firstClaim.promise; });
    const samePending = cache.run(firstKey, () => { starts += 1; return Promise.resolve(true); });
    expect(samePending).toBe(pending);
    expect(starts).toBe(1);

    firstClaim.resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(cache.run(firstKey, () => { starts += 1; return Promise.resolve(true); })).toBe(false);

    const nextDay = cache.run(secondKey, () => { starts += 1; return Promise.resolve(true); });
    expect(nextDay).not.toBe(false);
    await expect(nextDay).resolves.toBe(true);
    expect(starts).toBe(2);
  });

  it('does not report an earlier successful claim as a new match-end completion', async () => {
    const cache = new MissionCompletionCache();
    const key = missionCompletionKey('2026-11-25', 'tennis', 'daily-win');
    const mission = { id: 'daily-win', sport: 'tennis' as const, metric: 'win' as const, target: 1, text: 'Win' };
    const tracker = new MissionTracker(new MissionStore(), '2026-11-25', mission);
    const claim = cache.run(key, () => tracker.update(1));

    await expect(claim).resolves.toBe(true);
    tracker.resetValue();
    cache.clear(); // Tennis starts a rematch, but this day's mission is already complete.
    expect(cache.run(key, () => tracker.update(1))).toBe(false);
  });

  it('persists a claimed reward after disposal but suppresses stale notifications', async () => {
    const claim = deferred<boolean>();
    let disposed = false;
    let persistedXp = 0;
    let notifications = 0;

    const result = applyMissionReward(
      claim.promise,
      () => { persistedXp += 25; },
      () => { notifications += 1; },
      () => !disposed,
    );
    disposed = true;
    claim.resolve(true);

    await expect(result).resolves.toBe(true);
    expect(persistedXp).toBe(25);
    expect(notifications).toBe(0);
  });
});
