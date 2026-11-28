import { describe, expect, it } from 'vitest';
import { IntensityMeter, type Body } from '../src/kinematics/intensity';

/** Arms swinging up and down fast while the torso stays put: the movement of someone
 *  cheering, not of someone running in place. */
function wavingBody(t: number): Body {
  const phase = Math.sin(t / 90);
  return { head: 0.3, shoulders: 0.5, width: 0.25, x: 0, leftWrist: 0.5 + phase * 0.2, rightWrist: 0.5 - phase * 0.2 };
}

function runningBody(t: number): Body {
  const phase = Math.sin(t / 120);
  return { head: 0.3 + phase * 0.03, shoulders: 0.5 + phase * 0.03, width: 0.25, x: 0, leftWrist: 0.5 + phase * 0.15, rightWrist: 0.5 - phase * 0.15 };
}

describe('intensity bounce gate', () => {
  it('scores nothing for fast arm movement without the torso-bounce verdict', () => {
    const meter = new IntensityMeter();
    let peak = 0;
    for (let t = 0; t <= 5000; t += 50) peak = Math.max(peak, meter.update(t, wavingBody(t), false));
    expect(peak).toBe(0);
  });

  it('scores real whole-body movement when the bounce verdict confirms running', () => {
    const meter = new IntensityMeter();
    let peak = 0;
    for (let t = 0; t <= 5000; t += 50) peak = Math.max(peak, meter.update(t, runningBody(t), true));
    expect(peak).toBeGreaterThan(0.3);
  });

  it('fades through the normal release when the gate closes mid-run instead of cutting hard', () => {
    const meter = new IntensityMeter();
    for (let t = 0; t <= 4000; t += 50) meter.update(t, runningBody(t), true);
    const before = meter.update(4000, runningBody(4000), true);
    expect(before).toBeGreaterThan(0.2);
    // The frame right after the gate closes still carries almost all of the level…
    const justAfter = meter.update(4050, runningBody(4050), false);
    expect(justAfter).toBeGreaterThan(before * 0.9);
    // …and it keeps fading smoothly rather than dropping to zero at once.
    const later = meter.update(4350, runningBody(4350), false);
    expect(later).toBeGreaterThan(0.01);
    expect(later).toBeLessThan(justAfter);
    let level = later;
    for (let t = 4400; t <= 8200; t += 50) {
      const next = meter.update(t, runningBody(t), false);
      expect(next).toBeLessThanOrEqual(level + 1e-9);
      level = next;
    }
    expect(level).toBeLessThan(0.01);
  });
});
