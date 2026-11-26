import type { MissionMetric } from '../engagement/missions';

export interface TennisMissionSample {
  /** Live arcade performance score for the current match. */
  readonly performance: number;
  /** Best exchange count reached in the current match, including the rally in flight. */
  readonly bestRally: number;
  readonly won: boolean;
}

/** Counts each hit in a point; an opponent serve starts the count at one. */
export class RallyTracker {
  private exchanges = 0;

  get current(): number {
    return this.exchanges;
  }

  opponentServeStarted(): void {
    this.exchanges = 1;
  }

  recordHit(): void {
    this.exchanges += 1;
  }

  finishPoint(): number {
    const exchanges = this.exchanges;
    this.exchanges = 0;
    return exchanges;
  }

  reset(): void {
    this.exchanges = 0;
  }
}

export function tennisMissionValue(metric: MissionMetric, sample: TennisMissionSample): number {
  if (metric === 'performance') return sample.performance;
  if (metric === 'rally') return sample.bestRally;
  if (metric === 'win') return sample.won ? 1 : 0;
  return 0;
}
