export type SportKey = 'track' | 'tennis';

export interface SportProgress {
  bestScore: number;
  plays: number;
  xp: number;
}

export interface ProgressionStatus {
  xp: number;
  rankIndex: number;
  rank: string;
  /** Progress inside the current rank; 1 when the top rank has been reached. */
  progress01: number;
  xpIntoRank: number;
  xpToNextRank: number;
}


export interface XpRecordResult {
  progress: SportProgress;
  before: ProgressionStatus;
  after: ProgressionStatus;
  rankUp: boolean;
  xpEarned: number;
}

export interface ProgressRecordResult {
  progress: SportProgress;
  before: ProgressionStatus;
  after: ProgressionStatus;
  isRecord: boolean;
  rankUp: boolean;
  xpEarned: number;
}

export const PROGRESS_RANKS = [
  { rank: 'NOVATO', xp: 0 },
  { rank: 'BRONZE', xp: 100 },
  { rank: 'PRATA', xp: 300 },
  { rank: 'OURO', xp: 700 },
  { rank: 'PLATINA', xp: 1500 },
  { rank: 'DIAMANTE', xp: 3000 },
  { rank: 'ELITE', xp: 6000 },
] as const;

function cleanNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function emptyProgress(): SportProgress {
  return { bestScore: 0, plays: 0, xp: 0 };
}

export function normalizeProgress(value: Partial<SportProgress> | undefined): SportProgress {
  return {
    bestScore: cleanNumber(value?.bestScore ?? 0),
    plays: Math.floor(cleanNumber(value?.plays ?? 0)),
    xp: Math.floor(cleanNumber(value?.xp ?? 0)),
  };
}

export function progressionFor(xpInput: number): ProgressionStatus {
  const xp = Math.floor(cleanNumber(xpInput));
  let rankIndex = 0;
  for (let index = 0; index < PROGRESS_RANKS.length; index += 1) {
    if (xp >= PROGRESS_RANKS[index]!.xp) rankIndex = index;
  }
  const current = PROGRESS_RANKS[rankIndex]!;
  const next = PROGRESS_RANKS[rankIndex + 1];
  if (!next) {
    return { xp, rankIndex, rank: current.rank, progress01: 1, xpIntoRank: xp - current.xp, xpToNextRank: 0 };
  }
  const span = next.xp - current.xp;
  const xpIntoRank = xp - current.xp;
  return {
    xp,
    rankIndex,
    rank: current.rank,
    progress01: Math.min(1, xpIntoRank / span),
    xpIntoRank,
    xpToNextRank: Math.max(0, next.xp - xp),
  };
}

export function recordSportResult(progressInput: SportProgress, scoreInput: number, xpInput: number): ProgressRecordResult {
  const previous = normalizeProgress(progressInput);
  const score = Math.floor(cleanNumber(scoreInput));
  const xpEarned = Math.floor(cleanNumber(xpInput));
  const before = progressionFor(previous.xp);
  const progress = {
    bestScore: Math.max(previous.bestScore, score),
    plays: previous.plays + 1,
    xp: previous.xp + xpEarned,
  };
  const after = progressionFor(progress.xp);
  return {
    progress,
    before,
    after,
    isRecord: score > previous.bestScore,
    rankUp: after.rankIndex > before.rankIndex,
    xpEarned,
  };
}

/** Grants XP without counting another play or touching the sport's best score. */
export function addSportXp(progressInput: SportProgress, xpInput: number): XpRecordResult {
  const previous = normalizeProgress(progressInput);
  const xpEarned = Math.floor(cleanNumber(xpInput));
  const before = progressionFor(previous.xp);
  const progress = { ...previous, xp: previous.xp + xpEarned };
  const after = progressionFor(progress.xp);
  return { progress, before, after, rankUp: after.rankIndex > before.rankIndex, xpEarned };
}
