import { DEFAULT_BALLISTICS, type BallState } from './ballistics';
import type { PlayerSide } from './tennisScore';

export const COURT_HALF_WIDTH = 3.5;
export const BASELINE_Z = 9.5;
export const SERVICE_LINE_Z = 5.1;
export const LINE_WIDTH = 0.07;
export const NET_HEIGHT = 0.9;
export const NET_HALF_WIDTH = 4.7;

export function serviceSide(points: Readonly<Record<PlayerSide, number>>): 1 | -1 {
  return (points.player + points.opponent) % 2 === 0 ? 1 : -1;
}

export function groundImpact(ball: BallState) {
  const { gravity, groundY } = DEFAULT_BALLISTICS;
  const { position, velocity } = ball;
  const seconds = (velocity.y + Math.sqrt(Math.max(0, velocity.y ** 2 + 2 * gravity * (position.y - groundY)))) / gravity;
  return { seconds, x: position.x + velocity.x * seconds, z: position.z + velocity.z * seconds };
}

export function legalLanding(x: number, z: number, hitter: PlayerSide, serveSide?: 1 | -1): boolean {
  const halfLine = LINE_WIDTH / 2;
  const depth = z * (hitter === 'player' ? -1 : 1);
  return depth > 0
    && depth <= (serveSide === undefined ? BASELINE_Z : SERVICE_LINE_Z) + halfLine
    && Math.abs(x) <= COURT_HALF_WIDTH + halfLine
    && (serveSide === undefined || x * serveSide * (hitter === 'player' ? 1 : -1) <= halfLine);
}
