import type { MissionMetric } from '../engagement/missions';

export interface TrackMissionSample {
  /** Highest score reached in this run. */
  readonly score: number;
  /** Best hurdle clear streak reached in this run. */
  readonly bestCombo: number;
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
