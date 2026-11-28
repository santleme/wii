import { describe, expect, it } from 'vitest';
import { IntensityMeter } from '../src/kinematics/intensity';

const WIDTH = 0.2;
/** Arms swinging in opposition `hz` times a second, `armSw` shoulder widths each way, and a head bounce. */
function level({ hz = 0, armSw = 0, bounceSw = 0, hands = true, jitterSw = 0 }) {
  const meter = new IntensityMeter();
  let value = 0, seed = 1;
  const noise = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return (seed / 4294967296 - 0.5) * 2 * jitterSw * WIDTH; };
  for (let t = 0; t <= 5000; t += 33) {
    const swing = armSw * WIDTH * Math.sin((2 * Math.PI * hz * t) / 1000);
    const y = bounceSw * WIDTH * Math.sin((2 * Math.PI * hz * 2 * t) / 1000);
    value = meter.update(t, {
      head: 0.3 + y + noise(), shoulders: 0.5 + y, width: WIDTH, x: 0,
      leftWrist: hands ? 0.8 + y + swing + noise() : Number.NaN, rightWrist: hands ? 0.8 + y - swing + noise() : Number.NaN,
    });
  }
  return value;
}

it('adds the torso lateral speed to the effort while the gate is open', () => {
  const meter = new IntensityMeter();
  const body = (t: number, lateralAmplitude: number) => ({
    head: 0.3, shoulders: 0.5, width: WIDTH, x: lateralAmplitude * Math.sin((2 * Math.PI * 2 * t) / 1000), leftWrist: 0.8, rightWrist: 0.8,
  });
  let still = 0;
  for (let t = 0; t <= 3000; t += 33) still = meter.update(t, body(t, 0), true);
  const meter2 = new IntensityMeter();
  let swaying = 0;
  for (let t = 0; t <= 3000; t += 33) swaying = meter2.update(t, body(t, 0.1), true);
  expect(swaying).toBeGreaterThan(still + 0.05);
});

describe('running intensity', () => {
  it('is zero standing still, even with landmark jitter', () => {
    expect(level({})).toBe(0);
    expect(level({ jitterSw: 0.01 })).toBe(0);
  });

  it('grows with the pace of the arms', () => {
    const [slow, middle, fast] = [0.8, 1.4, 2].map((hz) => level({ hz, armSw: 0.5 }));
    expect(middle).toBeGreaterThan(slow! + 0.1);
    expect(fast).toBeGreaterThan(middle! + 0.1);
    expect(fast).toBeLessThan(1);
  });

  it('grows with the size of the movement, and still counts compact arms', () => {
    const [compact, wide] = [0.2, 0.6].map((armSw) => level({ hz: 1.4, armSw }));
    expect(compact).toBeGreaterThan(0.05);
    expect(wide).toBeGreaterThan(compact! + 0.2);
  });

  it('reads the body when the hands are out of view', () => {
    expect(level({ hz: 1.4, bounceSw: 0.12, hands: false })).toBeGreaterThan(0.3);
  });

  it('keeps detecting a compact run with or without quiet hands in view', () => {
    const options = { hz: 1.4, bounceSw: 0.12 };
    expect(level(options)).toBeCloseTo(level({ ...options, hands: false }));
  });

  it('discards old speed when stationary frames return after a tracking gap', () => {
    const meter = new IntensityMeter();
    const still = { head: 0.3, shoulders: 0.5, width: WIDTH, x: 0, leftWrist: 0.8, rightWrist: 0.8 };
    let effort = 0;
    for (let t = 0; t <= 3000; t += 20) {
      const swing = 0.15 * Math.sin(t / 90);
      effort = meter.update(t, { ...still, leftWrist: still.leftWrist + swing, rightWrist: still.rightWrist - swing });
    }
    expect(effort).toBeGreaterThan(0.5);

    const fading = meter.update(3300);
    expect(meter.update(3600, still)).toBeLessThan(fading);
    expect(meter.sampleAtMs).toBe(3000);
    expect(meter.update(3633, still)).toBe(0);
    expect(meter.sampleAtMs).toBe(3633);
  });

  it('fades instead of dropping when the player cannot be read', () => {
    const meter = new IntensityMeter();
    let value = 0;
    for (let t = 0; t <= 4000; t += 33) {
      const swing = 0.1 * Math.sin((2 * Math.PI * 1.4 * t) / 1000);
      value = meter.update(t, { head: 0.3, shoulders: 0.5, width: WIDTH, x: 0, leftWrist: 0.8 + swing, rightWrist: 0.8 - swing });
    }
    const after = meter.update(4200);
    expect(after).toBeGreaterThan(value * 0.6);
    expect(after).toBeLessThan(value);
  });
});
