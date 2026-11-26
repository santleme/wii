import {
  emptyProgress,
  addSportXp,
  normalizeProgress,
  recordSportResult,
  type ProgressRecordResult,
  type XpRecordResult,
  type SportKey,
  type SportProgress,
} from './progression';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'wii-web-sports.progress.v1';
const MUTATION_LOCK_NAME = 'wii-web-sports.progress-mutation.v1';

export interface ProgressMutationLock {
  request<T>(name: string, callback: () => T): Promise<T>;
}

type ProgressData = {
  version: 1;
  sports: Partial<Record<SportKey, SportProgress>>;
};

function emptyData(): ProgressData {
  return { version: 1, sports: {} };
}

/**
 * Small local progression repository. Mutations use an origin lock when available and degrade
 * to synchronous storage or document memory when coordination or persistence is unavailable.
 */
export class ProgressStore {
  private memory = emptyData();
  private storageFailed = false;

  constructor(
    private readonly storage?: KeyValueStorage,
    private readonly mutationLock?: ProgressMutationLock,
  ) {}

  load(sport: SportKey): SportProgress {
    return normalizeProgress(this.read().sports[sport] ?? emptyProgress());
  }

  async record(sport: SportKey, score: number, xpEarned: number): Promise<ProgressRecordResult> {
    if (!this.storage || this.storageFailed || !this.mutationLock) {
      return this.recordWithCurrentData(sport, score, xpEarned);
    }

    try {
      return await this.mutationLock.request(MUTATION_LOCK_NAME, () => (
        this.recordWithCurrentData(sport, score, xpEarned)
      ));
    } catch {
      return this.recordWithCurrentData(sport, score, xpEarned);
    }
  }

  private recordWithCurrentData(sport: SportKey, score: number, xpEarned: number): ProgressRecordResult {
    const data = this.read();
    const result = recordSportResult(normalizeProgress(data.sports[sport] ?? emptyProgress()), score, xpEarned);
    const next: ProgressData = { version: 1, sports: { ...data.sports, [sport]: result.progress } };
    this.write(next);
    return result;
  }


  async addXp(sport: SportKey, xpEarned: number): Promise<XpRecordResult> {
    if (!this.storage || this.storageFailed || !this.mutationLock) {
      return this.addXpWithCurrentData(sport, xpEarned);
    }

    try {
      return await this.mutationLock.request(MUTATION_LOCK_NAME, () => (
        this.addXpWithCurrentData(sport, xpEarned)
      ));
    } catch {
      return this.addXpWithCurrentData(sport, xpEarned);
    }
  }

  private addXpWithCurrentData(sport: SportKey, xpEarned: number): XpRecordResult {
    const data = this.read();
    const result = addSportXp(normalizeProgress(data.sports[sport] ?? emptyProgress()), xpEarned);
    const next: ProgressData = { version: 1, sports: { ...data.sports, [sport]: result.progress } };
    this.write(next);
    return result;
  }

  private read(): ProgressData {
    if (!this.storage || this.storageFailed) return this.memory;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return emptyData();
      const parsed = JSON.parse(raw) as Partial<ProgressData>;
      if (parsed.version !== 1 || typeof parsed.sports !== 'object' || parsed.sports === null) return emptyData();
      return {
        version: 1,
        sports: {
          track: parsed.sports.track ? normalizeProgress(parsed.sports.track) : undefined,
          tennis: parsed.sports.tennis ? normalizeProgress(parsed.sports.tennis) : undefined,
        },
      };
    } catch {
      this.storageFailed = true;
      return this.memory;
    }
  }

  private write(data: ProgressData): void {
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

export function createBrowserProgressStore(): ProgressStore {
  let storage: KeyValueStorage | undefined;
  let mutationLock: ProgressMutationLock | undefined;

  try {
    storage = window.localStorage;
  } catch { /* blocked storage keeps progress in this document's memory */ }

  try {
    const lockManager = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (lockManager) {
      mutationLock = {
        request: (name, callback) => lockManager.request(name, () => callback()),
      };
    }
  } catch { /* unavailable Web Locks use the synchronous durable fallback */ }

  return new ProgressStore(storage, mutationLock);
}
