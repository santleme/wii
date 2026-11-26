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
import type { MissionProgressBackend } from './missionStore';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
  key?(index: number): string | null;
  readonly length?: number;
}

const STORAGE_KEY = 'wii-web-sports.progress.v1';
const LEGACY_MISSION_STORAGE_KEY = 'wii-web-sports.missions.v1';
const PENDING_OPERATION_PREFIX = 'wii-web-sports.progress-op.v1:';
const MUTATION_LOCK_NAME = 'wii-web-sports.progress-mutation.v1';
const MAX_RECENT_OPERATION_RESULTS = 128;

export interface ProgressMutationLock {
  request<T>(name: string, callback: () => T): Promise<T>;
}

type ProgressData = {
  version: 1;
  sports: Partial<Record<SportKey, SportProgress>>;
  missions: Record<string, string[]>;
  appliedOperations: Record<string, ProgressRecordResult | XpRecordResult | boolean>;
};

type PendingOperation = {
  id: string;
  sport: SportKey;
  createdAt: number;
} & (
  | { kind: 'record'; score: number; xpEarned: number }
  | { kind: 'xp'; xpEarned: number }
  | { kind: 'mission'; dateIso: string; missionId: string; xpEarned: number }
);

type PendingOperationResult = ProgressRecordResult | XpRecordResult | boolean;

function emptyData(): ProgressData {
  return { version: 1, sports: {}, missions: {}, appliedOperations: {} };
}

function isSportKey(value: unknown): value is SportKey {
  return value === 'track' || value === 'tennis';
}

function cleanCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function createOperationId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function missionDayKey(dateIso: string, sport: SportKey): string {
  return `${dateIso}:${sport}`;
}

/**
 * Local progression repository. Finished results first enter unique durable queue keys, then
 * apply under an origin lock. Mission completion and its XP share one progress snapshot.
 */
export class ProgressStore implements MissionProgressBackend {
  private memory = emptyData();
  private storageFailed = false;

  constructor(
    private readonly storage?: KeyValueStorage,
    private readonly mutationLock?: ProgressMutationLock,
  ) {}

  load(sport: SportKey): SportProgress {
    const data = this.read();
    let progress = normalizeProgress(data.sports[sport] ?? emptyProgress());
    for (const operation of this.readPendingOperations()) {
      if (operation.sport !== sport || data.appliedOperations[operation.id] !== undefined) continue;
      progress = this.previewPendingValue(progress, operation);
    }
    return progress;
  }

  async record(sport: SportKey, score: number, xpEarned: number): Promise<ProgressRecordResult> {
    if (!this.storage || this.storageFailed) return this.recordWithCurrentData(sport, score, xpEarned);

    const operation: PendingOperation = {
      id: createOperationId(),
      kind: 'record',
      sport,
      score: cleanCount(score),
      xpEarned: cleanCount(xpEarned),
      createdAt: Date.now(),
    };
    if (!this.enqueue(operation)) return this.recordWithCurrentData(sport, score, xpEarned);

    const result = await this.withMutationLock(() => this.processPendingOperations(operation.id));
    if (result && typeof result === 'object' && 'isRecord' in result) return result;
    // The receipt may have aged out while another tab held the lock. The operation is already
    // durable and must not be replayed as a second play just to reconstruct its UI result.
    return recordSportResult(this.load(sport), score, xpEarned);
  }

  async addXp(sport: SportKey, xpEarned: number): Promise<XpRecordResult> {
    if (!this.storage || this.storageFailed) return this.addXpWithCurrentData(sport, xpEarned);

    const operation: PendingOperation = {
      id: createOperationId(),
      kind: 'xp',
      sport,
      xpEarned: cleanCount(xpEarned),
      createdAt: Date.now(),
    };
    if (!this.enqueue(operation)) return this.addXpWithCurrentData(sport, xpEarned);

    const result = await this.withMutationLock(() => this.processPendingOperations(operation.id));
    if (result && typeof result === 'object' && !('isRecord' in result)) return result;
    return addSportXp(this.load(sport), xpEarned);
  }

  isMissionCompleted(dateIso: string, sport: SportKey, missionId: string): boolean {
    const data = this.read();
    if ((data.missions[missionDayKey(dateIso, sport)] ?? []).includes(missionId)) return true;
    return this.readPendingOperations().some((operation) => (
      operation.kind === 'mission'
      && operation.dateIso === dateIso
      && operation.sport === sport
      && operation.missionId === missionId
      && data.appliedOperations[operation.id] === undefined
    ));
  }

  async completeMission(dateIso: string, sport: SportKey, missionId: string, rewardXp: number): Promise<boolean> {
    if (this.isMissionCompleted(dateIso, sport, missionId)) return false;
    if (!this.storage || this.storageFailed) {
      return this.completeMissionWithCurrentData(dateIso, sport, missionId, rewardXp);
    }

    const operation: PendingOperation = {
      id: `mission-${createOperationId()}`,
      kind: 'mission',
      dateIso,
      sport,
      missionId,
      xpEarned: cleanCount(rewardXp),
      createdAt: Date.now(),
    };
    if (!this.enqueue(operation)) {
      return this.completeMissionWithCurrentData(dateIso, sport, missionId, rewardXp);
    }

    return (await this.withMutationLock(() => this.processPendingOperations(operation.id))) === true;
  }

  /** Replays results queued by a document that closed while waiting for the origin lock. */
  async recoverPendingOperations(): Promise<void> {
    await this.withMutationLock(() => {
      this.processPendingOperations();
    });
  }

  private async withMutationLock<T>(callback: () => T): Promise<T> {
    if (!this.storage || this.storageFailed || !this.mutationLock) {
      this.processPendingOperations();
      return callback();
    }

    try {
      return await this.mutationLock.request(MUTATION_LOCK_NAME, () => {
        this.processPendingOperations();
        return callback();
      });
    } catch {
      // Storage remains usable if Web Locks fail; this synchronous fallback cannot coordinate
      // another browsing context, but it still applies the queued operation exactly once here.
      this.processPendingOperations();
      return callback();
    }
  }

  private recordWithCurrentData(sport: SportKey, score: number, xpEarned: number): ProgressRecordResult {
    const data = this.read();
    const result = recordSportResult(normalizeProgress(data.sports[sport] ?? emptyProgress()), score, xpEarned);
    const next: ProgressData = { ...data, sports: { ...data.sports, [sport]: result.progress } };
    this.write(next);
    return result;
  }

  private addXpWithCurrentData(sport: SportKey, xpEarned: number): XpRecordResult {
    const data = this.read();
    const result = addSportXp(normalizeProgress(data.sports[sport] ?? emptyProgress()), xpEarned);
    const next: ProgressData = { ...data, sports: { ...data.sports, [sport]: result.progress } };
    this.write(next);
    return result;
  }

  private completeMissionWithCurrentData(
    dateIso: string,
    sport: SportKey,
    missionId: string,
    rewardXp: number,
  ): boolean {
    const data = this.read();
    const key = missionDayKey(dateIso, sport);
    const completed = data.missions[key] ?? [];
    if (completed.includes(missionId)) return false;

    const reward = addSportXp(normalizeProgress(data.sports[sport] ?? emptyProgress()), rewardXp);
    const missions = { ...data.missions, [key]: [...completed, missionId] };
    for (const oldKey of Object.keys(missions).sort().reverse().slice(14)) delete missions[oldKey];

    this.write({
      ...data,
      sports: { ...data.sports, [sport]: reward.progress },
      missions,
    });
    return true;
  }

  private applyPendingValue(progress: SportProgress, operation: Exclude<PendingOperation, { kind: 'mission' }>): ProgressRecordResult | XpRecordResult {
    return operation.kind === 'record'
      ? recordSportResult(progress, operation.score, operation.xpEarned)
      : addSportXp(progress, operation.xpEarned);
  }

  private previewPendingValue(progress: SportProgress, operation: PendingOperation): SportProgress {
    if (operation.kind === 'record') return recordSportResult(progress, operation.score, operation.xpEarned).progress;
    return addSportXp(progress, operation.xpEarned).progress;
  }

  private processPendingOperations(currentId?: string): PendingOperationResult | undefined {
    const operations = this.readPendingOperations(currentId);
    let currentResult = currentId ? this.read().appliedOperations[currentId] : undefined;

    for (const operation of operations) {
      const data = this.read();
      const existing = data.appliedOperations[operation.id];
      if (existing !== undefined) {
        this.removePending(operation.id);
        if (operation.id === currentId) currentResult = existing;
        continue;
      }

      let next = data;
      let result: PendingOperationResult;
      if (operation.kind === 'mission') {
        const dayKey = missionDayKey(operation.dateIso, operation.sport);
        const completed = data.missions[dayKey] ?? [];
        if (completed.includes(operation.missionId)) {
          result = false;
        } else {
          const previous = normalizeProgress(data.sports[operation.sport] ?? emptyProgress());
          const reward = addSportXp(previous, operation.xpEarned);
          const missions = { ...data.missions, [dayKey]: [...completed, operation.missionId] };
          for (const oldKey of Object.keys(missions).sort().reverse().slice(14)) delete missions[oldKey];
          next = { ...data, sports: { ...data.sports, [operation.sport]: reward.progress }, missions };
          result = true;
        }
      } else {
        const previous = normalizeProgress(data.sports[operation.sport] ?? emptyProgress());
        const applied = this.applyPendingValue(previous, operation);
        next = { ...data, sports: { ...data.sports, [operation.sport]: applied.progress } };
        result = applied;
      }

      const appliedOperations = this.keepRecentResults(data.appliedOperations, operation.id, result);
      const persisted = this.write({ ...next, appliedOperations });
      if (persisted) this.removePending(operation.id);
      if (operation.id === currentId) currentResult = result;
    }

    return currentResult;
  }

  private keepRecentResults(
    previous: ProgressData['appliedOperations'],
    id: string,
    result: PendingOperationResult,
  ): ProgressData['appliedOperations'] {
    const next = { ...previous, [id]: result };
    const pendingIds = new Set(this.pendingOperationIds());
    pendingIds.add(id);
    const ids = Object.keys(next);
    const retained = new Set(ids.slice(-MAX_RECENT_OPERATION_RESULTS));
    for (const pendingId of pendingIds) retained.add(pendingId);
    for (const previousId of ids) {
      if (!retained.has(previousId)) delete next[previousId];
    }
    return next;
  }

  private enqueue(operation: PendingOperation): boolean {
    try {
      this.storage!.setItem(this.pendingKey(operation.id), JSON.stringify(operation));
      return true;
    } catch {
      const latest = this.read();
      this.storageFailed = true;
      this.memory = latest;
      return false;
    }
  }

  private readPendingOperations(additionalId?: string): PendingOperation[] {
    if (!this.storage || this.storageFailed) return [];
    try {
      const operations: PendingOperation[] = [];
      if (this.storage.length !== undefined && this.storage.key) {
        for (let index = 0; index < this.storage.length; index += 1) {
          const key = this.storage.key(index);
          if (!key?.startsWith(PENDING_OPERATION_PREFIX)) continue;
          const id = key.slice(PENDING_OPERATION_PREFIX.length);
          const raw = this.storage.getItem(key);
          const operation = raw ? this.parsePendingOperation(id, raw) : undefined;
          if (operation) operations.push(operation);
        }
      }

      if (additionalId && !operations.some((operation) => operation.id === additionalId)) {
        const raw = this.storage.getItem(this.pendingKey(additionalId));
        const operation = raw ? this.parsePendingOperation(additionalId, raw) : undefined;
        if (operation) operations.push(operation);
      }

      // Preserve storage enumeration order for operations created in the same clock tick.
      // A random UUID tie-breaker can reorder a just-enqueued mission reward behind a later
      // result, making the receipt returned to the mission UI include unrelated XP.
      return operations.sort((left, right) => left.createdAt - right.createdAt);
    } catch {
      return [];
    }
  }

  private parsePendingOperation(id: string, raw: string): PendingOperation | undefined {
    let operation: Partial<PendingOperation>;
    try { operation = JSON.parse(raw) as Partial<PendingOperation>; }
    catch {
      this.removePending(id);
      return undefined;
    }
    if (
      operation.id !== id
      || !isSportKey(operation.sport)
      || typeof operation.createdAt !== 'number'
      || (operation.kind !== 'record' && operation.kind !== 'xp' && operation.kind !== 'mission')
      || typeof operation.xpEarned !== 'number'
      || (operation.kind === 'record' && typeof operation.score !== 'number')
      || (operation.kind === 'mission' && (typeof operation.dateIso !== 'string' || typeof operation.missionId !== 'string'))
    ) {
      this.removePending(id);
      return undefined;
    }
    return operation as PendingOperation;
  }

  private pendingOperationIds(): string[] {
    if (!this.storage || this.storageFailed || this.storage.length === undefined || !this.storage.key) return [];
    try {
      const ids: string[] = [];
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (key?.startsWith(PENDING_OPERATION_PREFIX)) ids.push(key.slice(PENDING_OPERATION_PREFIX.length));
      }
      return ids;
    } catch {
      return [];
    }
  }

  private pendingKey(id: string): string {
    return `${PENDING_OPERATION_PREFIX}${id}`;
  }

  private removePending(id: string): void {
    try {
      this.storage?.removeItem?.(this.pendingKey(id));
    } catch { /* the saved operation receipt prevents a repeated write on the next attempt */ }
  }

  private read(): ProgressData {
    if (!this.storage || this.storageFailed) return this.memory;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) as Partial<ProgressData> : undefined;
      const missions = this.normalizeMissionDays(parsed?.missions);
      this.mergeMissionDays(missions, this.readLegacyMissionDays());
      if (parsed?.version !== 1 || typeof parsed.sports !== 'object' || parsed.sports === null) {
        return { ...emptyData(), missions };
      }

      const appliedOperations: ProgressData['appliedOperations'] = {};
      if (parsed.appliedOperations && typeof parsed.appliedOperations === 'object') {
        for (const [id, result] of Object.entries(parsed.appliedOperations)) {
          if (this.isOperationResult(result)) appliedOperations[id] = result;
        }
      }
      return {
        version: 1,
        sports: {
          track: parsed.sports.track ? normalizeProgress(parsed.sports.track) : undefined,
          tennis: parsed.sports.tennis ? normalizeProgress(parsed.sports.tennis) : undefined,
        },
        missions,
        appliedOperations,
      };
    } catch {
      this.storageFailed = true;
      return this.memory;
    }
  }

  private readLegacyMissionDays(): Record<string, string[]> {
    try {
      const raw = this.storage?.getItem(LEGACY_MISSION_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as { version?: unknown; days?: unknown };
      if (parsed.version !== 1) return {};
      return this.normalizeMissionDays(parsed.days);
    } catch {
      return {};
    }
  }

  private isOperationResult(value: unknown): value is PendingOperationResult {
    if (typeof value === 'boolean') return true;
    if (!value || typeof value !== 'object') return false;
    const result = value as Partial<ProgressRecordResult & XpRecordResult>;
    return Boolean(
      result.progress
      && typeof result.progress === 'object'
      && result.before
      && result.after
      && typeof result.xpEarned === 'number'
      && typeof result.rankUp === 'boolean'
      && (!('isRecord' in result) || typeof result.isRecord === 'boolean'),
    );
  }

  private normalizeMissionDays(value: unknown): Record<string, string[]> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const days: Record<string, string[]> = {};
    for (const [day, missions] of Object.entries(value)) {
      if (Array.isArray(missions)) days[day] = missions.filter((mission): mission is string => typeof mission === 'string');
    }
    return days;
  }

  private mergeMissionDays(target: Record<string, string[]>, source: Record<string, string[]>): void {
    for (const [day, missionIds] of Object.entries(source)) {
      target[day] = [...new Set([...(target[day] ?? []), ...missionIds])];
    }
  }

  private write(data: ProgressData): boolean {
    this.memory = data;
    if (!this.storage || this.storageFailed) return false;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch {
      this.storageFailed = true;
      return false;
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
  } catch { /* unavailable Web Locks use synchronous writes and durable operation keys */ }

  const store = new ProgressStore(storage, mutationLock);
  void store.recoverPendingOperations();
  return store;
}
