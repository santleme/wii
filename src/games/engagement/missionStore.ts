import type { SportKey } from './progression';
import type { KeyValueStorage } from './progressStore';

const STORAGE_KEY = 'wii-web-sports.missions.v1';
const MAX_STORED_DAYS = 14;
const COMPLETION_LOCK_NAME = 'wii-web-sports.mission-completion.v1';

export interface MissionCompletionLock {
  request<T>(name: string, callback: () => T): Promise<T>;
}

type MissionData = {
  version: 1;
  days: Record<string, string[]>;
};

const emptyData = (): MissionData => ({ version: 1, days: {} });

/**
 * Completion-only mission repository. Progress itself is live state; only the unlock is persisted.
 * Persistent claims require an origin-wide lock so a read/check/write cannot race across tabs.
 */
export class MissionStore {
  private memory = emptyData();
  private storageFailed = false;

  constructor(
    private readonly storage?: KeyValueStorage,
    private readonly completionLock?: MissionCompletionLock,
  ) {}

  isCompleted(dateIso: string, sport: SportKey, missionId: string): boolean {
    return (this.read().days[this.key(dateIso, sport)] ?? []).includes(missionId);
  }

  async complete(dateIso: string, sport: SportKey, missionId: string): Promise<boolean> {
    if (!this.storage || this.storageFailed) return this.completeInMemory(dateIso, sport, missionId);

    if (!this.completionLock) {
      this.enableMemoryFallback();
      return this.completeInMemory(dateIso, sport, missionId);
    }

    try {
      return await this.completionLock.request(COMPLETION_LOCK_NAME, () => (
        this.completeWithCurrentData(dateIso, sport, missionId)
      ));
    } catch {
      // Without the origin-wide lock, keep gameplay working with this document's memory copy.
      this.enableMemoryFallback();
      return this.completeInMemory(dateIso, sport, missionId);
    }
  }

  private completeWithCurrentData(dateIso: string, sport: SportKey, missionId: string): boolean {
    const data = this.read();
    const key = this.key(dateIso, sport);
    const completed = data.days[key] ?? [];
    if (completed.includes(missionId)) return false;
    this.write(this.withCompletion(data, key, missionId));
    return true;
  }

  private completeInMemory(dateIso: string, sport: SportKey, missionId: string): boolean {
    const key = this.key(dateIso, sport);
    const completed = this.memory.days[key] ?? [];
    if (completed.includes(missionId)) return false;
    this.memory = this.withCompletion(this.memory, key, missionId);
    return true;
  }

  private withCompletion(data: MissionData, key: string, missionId: string): MissionData {
    const days: Record<string, string[]> = { ...data.days, [key]: [...(data.days[key] ?? []), missionId] };
    const keys = Object.keys(days).sort().reverse();
    for (const oldKey of keys.slice(MAX_STORED_DAYS)) delete days[oldKey];
    return { version: 1, days };
  }

  private key(dateIso: string, sport: SportKey): string {
    return `${dateIso}:${sport}`;
  }

  private read(): MissionData {
    if (!this.storage || this.storageFailed) return this.memory;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return emptyData();
      const parsed = JSON.parse(raw) as Partial<MissionData>;
      if (parsed.version !== 1 || typeof parsed.days !== 'object' || parsed.days === null) return emptyData();
      const days: Record<string, string[]> = {};
      for (const [day, missions] of Object.entries(parsed.days)) {
        if (Array.isArray(missions)) days[day] = missions.filter((mission): mission is string => typeof mission === 'string');
      }
      return { version: 1, days };
    } catch {
      this.storageFailed = true;
      return this.memory;
    }
  }

  private write(data: MissionData): void {
    if (!this.storage || this.storageFailed) {
      this.memory = data;
      return;
    }
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      this.storageFailed = true;
      this.memory = data;
    }
  }

  private enableMemoryFallback(): void {
    if (this.storageFailed) return;
    this.memory = this.read();
    this.storageFailed = true;
  }
}

export function createBrowserMissionStore(): MissionStore {
  let storage: KeyValueStorage | undefined;
  let completionLock: MissionCompletionLock | undefined;

  try {
    storage = window.localStorage;
  } catch { /* blocked storage keeps mission completion in this document's memory */ }

  try {
    const lockManager = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (lockManager) {
      completionLock = {
        request: (name, callback) => lockManager.request(name, () => callback()),
      };
    }
  } catch { /* unavailable Web Locks use the same per-document memory fallback */ }

  return new MissionStore(storage, completionLock);
}
