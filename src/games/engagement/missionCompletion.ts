import type { SportKey } from './progression';

type CachedCompletion = {
  key: string;
  pending: boolean;
  promise: Promise<boolean>;
};

/** Uses the full daily-session identity so a repeated mission ID on a later date is distinct. */
export function missionCompletionKey(dateIso: string, sport: SportKey, missionId: string): string {
  return `${dateIso}:${sport}:${missionId}`;
}

/** Shares an in-flight claim and returns false after that mission has already settled. */
export class MissionCompletionCache {
  private current?: CachedCompletion;

  clear(): void {
    this.current = undefined;
  }

  run(key: string, start: () => false | Promise<boolean>): false | Promise<boolean> {
    if (this.current?.key === key) return this.current.pending ? this.current.promise : false;
    this.current = undefined;

    const completion = start();
    if (completion === false) return false;

    const current: CachedCompletion = { key, pending: true, promise: Promise.resolve(false) };
    current.promise = completion.then(
      (claimed) => {
        current.pending = false;
        return claimed;
      },
      () => {
        current.pending = false;
        return false;
      },
    );
    this.current = current;
    return current.promise;
  }
}

/** Persists claimed XP even if its game has unmounted; only live engines may notify the player. */
export function applyMissionReward(
  completion: Promise<boolean>,
  grantReward: () => void | Promise<void>,
  notify: () => void,
  isActive: () => boolean,
): Promise<boolean> {
  return completion.then(async (claimed) => {
    if (!claimed) return false;
    await grantReward();
    if (isActive()) notify();
    return true;
  }, () => false);
}
