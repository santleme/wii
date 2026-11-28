import { describe, expect, it } from 'vitest';
import { createCrystalField, crystalHeight, impulseCrystal, stepCrystal, updateCrystalBase } from '../src/components/crystalField';

describe('crystal field', () => {
  it('generates a deterministic, varying surface', () => {
    expect(crystalHeight(0.2, -0.4, 3)).toBe(crystalHeight(0.2, -0.4, 3));
    expect(crystalHeight(0.2, -0.4, 3)).not.toBe(crystalHeight(-0.4, 0.2, 3));
  });

  it('propagates an impulse and returns toward the base', () => {
    const field = createCrystalField(21, 21);
    updateCrystalBase(field, 0);
    field.heights.set(field.baseHeights);
    const center = 10 * field.cols + 10;
    const neighbor = center + 1;
    impulseCrystal(field, 10, 10, -2, 1);
    for (let i = 0; i < 30; i++) stepCrystal(field, 1 / 60);
    expect(Math.abs(field.heights[neighbor] - field.baseHeights[neighbor])).toBeGreaterThan(0.001);
    for (let i = 0; i < 500; i++) stepCrystal(field, 1 / 60);
    expect(Math.abs(field.heights[center] - field.baseHeights[center])).toBeLessThan(0.001);
  });

  it('clamps long frames and bounds repeated impulses', () => {
    const a = createCrystalField(8, 8);
    const b = createCrystalField(8, 8);
    for (let i = 0; i < 100; i++) { impulseCrystal(a, 4, 4, -10, 2); impulseCrystal(b, 4, 4, -10, 2); }
    stepCrystal(a, 3);
    stepCrystal(b, 0.033);
    expect(a.heights).toEqual(b.heights);
    expect(Math.abs(a.heights[36])).toBeLessThan(1);
  });
});
