import type { Award } from './trackScore';

export interface Feedback { id: number; kind: 'hit' | 'clear' | 'coin' | 'milestone'; text: string }

export const SHAKE_DURATION_S = 0.3;
const SHAKE_AMPLITUDE = 0.18;

export function awardText({ points, multiplier, perfect }: Award): string {
  return [`+${points}`, perfect ? 'PERFECT' : '', multiplier > 1 ? `×${multiplier}` : ''].filter(Boolean).join(' · ');
}

/** Camera offset that decays to rest as `remaining` runs out. */
export function shakeOffset(remaining: number): { x: number; y: number } {
  const strength = SHAKE_AMPLITUDE * Math.max(0, remaining / SHAKE_DURATION_S);
  return { x: Math.sin(remaining * 90) * strength, y: Math.cos(remaining * 70) * strength * 0.6 };
}
