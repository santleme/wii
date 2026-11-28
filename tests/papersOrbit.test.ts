import { describe, expect, it } from 'vitest';
import { orbitRadii } from '../src/pages/papersOrbit';

describe('paper orbit bounds', () => {
  it('reserves space for the largest card and its interaction halo', () => {
    const { x, y } = orbitRadii(320, 600, 160, 80);
    expect(x + 160 * 1.03 / 2 + 4).toBeLessThanOrEqual(160);
    expect(y + 80 * 1.03 / 2 + 6).toBeLessThanOrEqual(300);
  });

  it('never returns a negative radius when the space is too small', () => {
    expect(orbitRadii(80, 40, 120, 80)).toEqual({ x: 0, y: 0 });
  });
});
