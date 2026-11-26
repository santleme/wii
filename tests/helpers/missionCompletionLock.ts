import type { MissionCompletionLock } from '../../src/games/engagement/missionStore';

/** Deterministic origin-wide lock test double: queued callbacks run one at a time. */
export class SerialMissionCompletionLock implements MissionCompletionLock {
  readonly requestedNames: string[] = [];
  private tail = Promise.resolve();

  request<T>(name: string, callback: () => T): Promise<T> {
    this.requestedNames.push(name);
    const result = this.tail.then(callback);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
