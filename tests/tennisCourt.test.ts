import { expect, it } from 'vitest';
import { BASELINE_Z, COURT_HALF_WIDTH, groundImpact, legalLanding, LINE_WIDTH, serviceSide } from '../src/games/tennis/court';
import { createBall } from '../src/games/tennis/ballistics';

it('counts the painted line but rejects the doubles alley and the wrong half', () => {
  expect(legalLanding(COURT_HALF_WIDTH + LINE_WIDTH / 2, -BASELINE_Z, 'player')).toBe(true);
  expect(legalLanding(4, -BASELINE_Z, 'player')).toBe(false);
  expect(legalLanding(1, BASELINE_Z, 'player')).toBe(false);
});

it('alternates the diagonal from the server perspective', () => {
  expect(serviceSide({ player: 0, opponent: 0 })).toBe(1);
  expect(serviceSide({ player: 2, opponent: 1 })).toBe(-1);
  expect(legalLanding(-2, -4, 'player', 1)).toBe(true);
  expect(legalLanding(2, -4, 'player', 1)).toBe(false);
  expect(legalLanding(2, -4, 'player', -1)).toBe(true);
  expect(legalLanding(2, 4, 'opponent', 1)).toBe(true);
  expect(legalLanding(2, 7, 'opponent', 1)).toBe(false);
});

it('judges at impact before post-bounce motion crosses a line', () => {
  const ball = createBall({ x: 3.4, y: 0.06, z: -6 }, { x: 5, y: -4, z: 0 }, 'player');
  const impact = groundImpact(ball);
  expect(impact.seconds).toBeLessThan(1 / 60);
  expect(legalLanding(impact.x, impact.z, 'player')).toBe(true);
});
