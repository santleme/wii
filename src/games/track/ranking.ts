export const RANKING_SIZE = 5;

export interface RunResult {
  points: number;
  ranking: number[];
  /** 1-based place of this run in the ranking; absent when it did not make the cut. */
  position?: number;
}

export function rankRun(previous: readonly number[], points: number): RunResult {
  const sorted = [...previous, points].sort((a, b) => b - a);
  const place = sorted.indexOf(points);
  return { points, ranking: sorted.slice(0, RANKING_SIZE), position: place < RANKING_SIZE ? place + 1 : undefined };
}

/** Reads a stored ranking, treating anything malformed as empty. */
export function parseRanking(raw: string | null): number[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((n): n is number => Number.isFinite(n)).slice(0, RANKING_SIZE) : [];
  } catch {
    return [];
  }
}

export function highestRankedScore(ranking: readonly number[]): number {
  return ranking.reduce((highest, score) => Number.isFinite(score) ? Math.max(highest, score) : highest, 0);
}
