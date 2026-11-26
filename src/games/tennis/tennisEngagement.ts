import type { MissionMetric } from '../engagement/missions';

export interface TennisMissionSample {
  /** Live arcade performance score for the current match. */
  readonly performance: number;
  /** Best exchange count reached in the current match, including the rally in flight. */
  readonly bestRally: number;
  readonly won: boolean;
}

export function tennisMissionValue(metric: MissionMetric, sample: TennisMissionSample): number {
  if (metric === 'performance') return sample.performance;
  if (metric === 'rally') return sample.bestRally;
  if (metric === 'win') return sample.won ? 1 : 0;
  return 0;
}
