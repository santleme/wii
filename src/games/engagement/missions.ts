import type { SportKey } from './progression';
import { hash32 } from './seededRandom';

export const MISSION_XP = 25;

export type MissionMetric = 'score' | 'combo' | 'performance' | 'rally' | 'win';

export interface DailyMission {
  readonly id: string;
  readonly sport: SportKey;
  readonly metric: MissionMetric;
  readonly target: number;
  readonly text: string;
}

interface MissionTemplate {
  readonly metric: MissionMetric;
  readonly target: number;
  readonly text: string;
}

const MISSION_POOLS: Record<SportKey, readonly MissionTemplate[]> = {
  track: [
    { metric: 'score', target: 800, text: 'Marque 800 pontos em uma run' },
    { metric: 'score', target: 1400, text: 'Marque 1400 pontos em uma run' },
    { metric: 'combo', target: 3, text: 'Encadeie 3 barreiras sem bater' },
    { metric: 'combo', target: 5, text: 'Encadeie 5 barreiras sem bater' },
  ],
  tennis: [
    { metric: 'performance', target: 140, text: 'Alcance 140 de desempenho' },
    { metric: 'performance', target: 220, text: 'Alcance 220 de desempenho' },
    { metric: 'rally', target: 4, text: 'Faça um rally de 4 trocas' },
    { metric: 'rally', target: 6, text: 'Faça um rally de 6 trocas' },
    { metric: 'win', target: 1, text: 'Vença uma partida' },
  ],
};


/** Local calendar date in the same ISO shape used as the mission seed. */
export function localDateIso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Deterministic mission for an ISO date (`yyyy-mm-dd`) and sport. No server and no streak:
 * everyone gets the same optional challenge that day, and missing it costs nothing.
 */
export function dailyMissionFor(sport: SportKey, dateIso: string): DailyMission {
  const pool = MISSION_POOLS[sport];
  const index = hash32(`${dateIso}:${sport}`) % pool.length;
  const template = pool[index]!;
  return { id: `${dateIso}:${sport}:${index}`, sport, ...template };
}

export function missionProgress01(value: number, target: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(target) || target <= 0) return 0;
  return Math.min(1, Math.max(0, value / target));
}
