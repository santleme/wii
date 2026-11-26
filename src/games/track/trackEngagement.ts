import type { MissionMetric } from '../engagement/missions';
import type { ProgressStore } from '../engagement/progressStore';
import type { SportProgress } from '../engagement/progression';

export interface TrackMissionSample {
  /** Highest score reached in this run. */
  readonly score: number;
  /** Best hurdle clear streak reached in this run. */
  readonly bestCombo: number;
}

export interface TrackProgressSnapshot {
  readonly progress: SportProgress;
  readonly legacyBestScore: number;
  /** The saved progress best with the legacy Track ranking used as a display/record floor. */
  readonly recordBestScore: number;
}

/** Reads Track progress without importing the old Track-only score into shared sports storage. */
export function loadTrackProgress(store: Pick<ProgressStore, 'load'>, legacyBestScore: number): TrackProgressSnapshot {
  const progress = store.load('track');
  const legacy = cleanScore(legacyBestScore);
  return { progress, legacyBestScore: legacy, recordBestScore: trackRecordBest(progress.bestScore, legacy) };
}

/** The legacy leaderboard remains a Track-only floor until a later run beats it. */
export function trackRecordBest(progressBestScore: number, legacyBestScore: number): number {
  return Math.max(cleanScore(progressBestScore), cleanScore(legacyBestScore));
}

export function isTrackRecord(score: number, recordBestScore: number): boolean {
  return cleanScore(score) > cleanScore(recordBestScore);
}

/** Persistent track XP is one tenth of the run's final score, rounded down. */
export function trackRunXp(finalScore: number): number {
  const score = Number.isFinite(finalScore) ? Math.max(0, finalScore) : 0;
  return Math.floor(score / 10);
}

export function trackMissionValue(metric: MissionMetric, sample: TrackMissionSample): number {
  if (metric === 'score') return sample.score;
  if (metric === 'combo') return sample.bestCombo;
  return 0;
}

/** Uses the run's peak so a later penalty cannot make a passed record look unreachable. */
export function trackRecordChase(bestScore: number, runPeak: number): string | undefined {
  if (!Number.isFinite(bestScore) || bestScore <= 0) return undefined;
  const gap = bestScore - Math.max(0, Number.isFinite(runPeak) ? runPeak : 0);
  return gap >= 0 ? `FALTAM ${gap + 1} P/ RECORDE` : 'RITMO DE RECORDE';
}

function cleanScore(score: number): number {
  return Number.isFinite(score) && score > 0 ? score : 0;
}
