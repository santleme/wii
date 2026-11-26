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

type ProgressData = {
  version: 1;
  sports: Partial<Record<SportKey, SportProgress>>;
};

function emptyData(): ProgressData {
  return { version: 1, sports: {} };
}

/**
 * Small local progression repository. It degrades to in-memory progress when storage is absent
 * or blocked, so gameplay never depends on persistence being available.
 */
export class ProgressStore {
  private memory = emptyData();
  private storageFailed = false;

  constructor(private readonly storage?: KeyValueStorage) {}

  load(sport: SportKey): SportProgress {
    return normalizeProgress(this.read().sports[sport] ?? emptyProgress());
  }

  /** Imports a score from an older leaderboard without counting a play or awarding XP. */
  ensureBestScore(sport: SportKey, score: number): SportProgress {
    const data = this.read();
    const current = normalizeProgress(data.sports[sport] ?? emptyProgress());
    const progress = { ...current, bestScore: Math.max(current.bestScore, cleanScore(score)) };
    if (progress.bestScore !== current.bestScore) {
      this.write({ version: 1, sports: { ...data.sports, [sport]: progress } });
    }
    return progress;
  }

  record(sport: SportKey, score: number, xpEarned: number): ProgressRecordResult {
    const data = this.read();
    const result = recordSportResult(normalizeProgress(data.sports[sport] ?? emptyProgress()), score, xpEarned);
    const next: ProgressData = { version: 1, sports: { ...data.sports, [sport]: result.progress } };
    this.write(next);
    return result;
  }


  addXp(sport: SportKey, xpEarned: number): XpRecordResult {
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

function cleanScore(score: number): number {
  return Number.isFinite(score) && score > 0 ? score : 0;
}

export function createBrowserProgressStore(): ProgressStore {
  try {
    return new ProgressStore(window.localStorage);
  } catch {
    return new ProgressStore();
  }
}
