import type { SportKey } from './progression';
import type { KeyValueStorage } from './progressStore';

const STORAGE_KEY = 'wii-web-sports.missions.v1';
const MAX_STORED_DAYS = 14;

type MissionData = {
  version: 1;
  days: Record<string, string[]>;
};

const emptyData = (): MissionData => ({ version: 1, days: {} });

/** Completion-only mission repository. Progress itself is live state; only the unlock is persisted. */
export class MissionStore {
  private memory = emptyData();
  private storageFailed = false;

  constructor(private readonly storage?: KeyValueStorage) {}

  isCompleted(dateIso: string, sport: SportKey, missionId: string): boolean {
    return (this.read().days[this.key(dateIso, sport)] ?? []).includes(missionId);
  }

  complete(dateIso: string, sport: SportKey, missionId: string): boolean {
    const data = this.read();
    const key = this.key(dateIso, sport);
    const completed = data.days[key] ?? [];
    if (completed.includes(missionId)) return false;
    const days: Record<string, string[]> = { ...data.days, [key]: [...completed, missionId] };
    const keys = Object.keys(days).sort().reverse();
    for (const oldKey of keys.slice(MAX_STORED_DAYS)) delete days[oldKey];
    this.write({ version: 1, days });
    return true;
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
}

export function createBrowserMissionStore(): MissionStore {
  try {
    return new MissionStore(window.localStorage);
  } catch {
    return new MissionStore();
  }
}
