import { describe, expect, it } from 'vitest';
import { adjudicationDt, applySprint, applyStep, easeSpeed, gaitFor, type Gait, nextPace, type Pace, stumble } from '../src/games/track/gait';
import type { CadenceResult } from '../src/kinematics/cadenceTracker';
import { poseWithHipBounce } from './fixtures/syntheticPose';
import { cadenceHarness } from './fixtures/torsoHarness';

const START = 500;
const STOP = 8000;
const TORSO = 0.4; // fixture torso height in image units

/**
 * Bounces the torso vertically at `spm` steps per minute from START to STOP, then stands still.
 * Running and marching both bounce the torso once per step, so the bounce frequency IS the
 * step frequency. Amplitude is in torso heights — 0.04 is a modest in-place bounce.
 */
function bounce(spm: number, amplitude = 0.04): (CadenceResult & { time: number })[] {
  const { feed } = cadenceHarness();
  const hz = spm / 60;
  return Array.from({ length: 320 }, (_, frame) => {
    const time = frame * 33;
    const active = time >= START && time <= STOP;
    const units = active ? amplitude * Math.sin((2 * Math.PI * hz * (time - START)) / 1000) : 0;
    return { time, ...feed(poseWithHipBounce(time, units * TORSO)) };
  });
}

/** Feeds scheduled bounce segments: each { from, until, spm } bounces at that rate; gaps stand still. */
function drive(feed: (snapshot: ReturnType<typeof poseWithHipBounce>) => CadenceResult, schedule: { from: number; until: number; spm: number }[], endMs: number) {
  const results: (CadenceResult & { time: number })[] = [];
  for (let time = 0; time <= endMs; time += 33) {
    const segment = schedule.find((s) => time >= s.from && time <= s.until);
    const units = segment ? 0.04 * Math.sin((2 * Math.PI * (segment.spm / 60) * (time - segment.from)) / 1000) : 0;
    results.push({ time, ...feed(poseWithHipBounce(time, units * TORSO)) });
  }
  return results;
}

describe('pace from torso vertical oscillation', () => {
  it.each([40, 60, 90, 110, 130, 160, 190])('keeps moving without dropouts at %i steps per minute', (spm) => {
    const steady = bounce(spm).filter((r) => r.time > 3000 && r.time <= STOP);
    expect(steady.filter((r) => r.speed01 === 0)).toHaveLength(0);
    for (const r of steady) expect(Math.abs(r.cadenceSpm - spm) / spm).toBeLessThan(0.15);
  });

  it('goes faster the faster the player bounces', () => {
    const speeds = [60, 90, 120, 150, 180].map((spm) => bounce(spm).find((r) => r.time > 6000)!.speed01);
    expect(speeds).toEqual([...speeds].sort((a, b) => a - b));
    expect(new Set(speeds).size).toBe(speeds.length);
  });

  it.each([60, 110, 180])('stops soon after the player stops at %i steps per minute', (spm) => {
    expect(bounce(spm).filter((r) => r.time > STOP + 1700).every((r) => r.speed01 === 0)).toBe(true);
  });

  it('stops and stays stopped when post-exercise sway and jitter follow the bounce', () => {
    const { feed } = cadenceHarness();
    const hz = 150 / 60;
    const results = Array.from({ length: 400 }, (_, frame) => {
      const time = frame * 33;
      let units = 0;
      if (time >= START && time <= STOP) {
        units = 0.04 * Math.sin((2 * Math.PI * hz * (time - START)) / 1000);
      } else if (time > STOP) {
        // After stopping, the player sways and breathes hard: slow vertical sway (~0.8 Hz,
        // semi ~5 mm) plus fast estimator jitter, deterministic but aperiodic.
        units = 0.005 * Math.sin((2 * Math.PI * 0.8 * (time - STOP)) / 1000) + 0.003 * Math.sin(frame * 1.7);
      }
      return { time, ...feed(poseWithHipBounce(time, units * TORSO)) };
    });
    // The stop deadline is ~1.6 periods (~640 ms at 150 spm); even with margin, motion must be
    // over 1.5 s after the bounce ends and must NOT restart: noise crossings in the amplitude
    // decay window are not steps.
    const tail = results.filter((r) => r.time > STOP + 1500);
    expect(tail.length).toBeGreaterThan(50);
    for (const r of tail) expect(r.speed01, `phantom motion at t=${r.time}`).toBe(0);
  });

  it('does not move when standing still, even with small noise-like jitter', () => {
    const { feed } = cadenceHarness();
    const results = Array.from({ length: 300 }, (_, i) => {
      const jitter = 0.004 * Math.sin(i * 1.7) + 0.003 * Math.sin(i * 0.31);
      return feed(poseWithHipBounce(i * 33, jitter * TORSO));
    });
    expect(Math.max(...results.map((r) => r.speed01))).toBe(0);
    expect(Math.max(...results.map((r) => r.cadenceSpm))).toBe(0);
  });

  it('does not move for a single isolated bounce', () => {
    const { feed } = cadenceHarness();
    const speeds = Array.from({ length: 120 }, (_, i) => {
      const t = i * 33;
      const units = t > 1000 && t < 1400 ? 0.05 * Math.sin((Math.PI * (t - 1000)) / 400) : 0;
      return feed(poseWithHipBounce(t, units * TORSO)).speed01;
    });
    expect(Math.max(...speeds)).toBe(0);
  });

  it('still detects a small-amplitude slow march (0.02 torso)', () => {
    const steady = bounce(100, 0.02).filter((r) => r.time > 3000 && r.time <= STOP);
    expect(steady.filter((r) => r.speed01 === 0).length).toBeLessThan(steady.length * 0.2);
    const active = steady.filter((r) => r.cadenceSpm > 0);
    for (const r of active) expect(Math.abs(r.cadenceSpm - 100) / 100).toBeLessThan(0.25);
  });

  it('keeps counting at high-amplitude bounce (0.09 torso semi-amplitude, literature high tail)', () => {
    const steady = bounce(170, 0.09).filter((r) => r.time > 3000 && r.time <= STOP);
    expect(steady.filter((r) => r.speed01 === 0)).toHaveLength(0);
    for (const r of steady) expect(Math.abs(r.cadenceSpm - 170) / 170).toBeLessThan(0.15);
  });

  it('alternates step sides', () => {
    const steps = bounce(150).filter((r) => r.step);
    expect(steps.some((r) => r.step === 'left')).toBe(true);
    expect(steps.some((r) => r.step === 'right')).toBe(true);
  });

  it('works at 15 fps', () => {
    const { feed } = cadenceHarness();
    const hz = 150 / 60;
    const results = Array.from({ length: 200 }, (_, frame) => {
      const time = frame * 66;
      const active = time >= START && time <= STOP;
      const units = active ? 0.04 * Math.sin((2 * Math.PI * hz * (time - START)) / 1000) : 0;
      return { time, ...feed(poseWithHipBounce(time, units * TORSO)) };
    });
    const steady = results.filter((r) => r.time > 3000 && r.time <= STOP);
    expect(steady.filter((r) => r.speed01 === 0).length).toBeLessThan(steady.length * 0.2);
  });

  it('re-measures pace on a late step instead of resurrecting the old cadence', () => {
    const { feed } = cadenceHarness();
    const results = drive(feed, [{ from: 500, until: 4500, spm: 150 }], 5300);
    expect(results.filter((r) => r.time > 3000 && r.time <= 4500).at(-1)!.speed01).toBeGreaterThan(0);
    // After the stop deadline the speed falls to zero...
    expect(results.at(-1)!.speed01).toBe(0);
    // ...and one isolated bounce pair well past the deadline only measures its own slow interval.
    const late = drive(feed, [{ from: 5400, until: 7000, spm: 70 }], 9000);
    const settled = late.filter((r) => r.time > 7500);
    expect(settled.every((r) => r.cadenceSpm < 110)).toBe(true);
    expect(settled.some((r) => r.speed01 > 0)).toBe(true);
  });

  it('keeps moving through a direct run-to-walk transition', () => {
    const { feed } = cadenceHarness();
    const results = drive(feed, [{ from: 500, until: 3000, spm: 182 }, { from: 3100, until: 12000, spm: 91 }], 12000);
    const settled = results.filter((r) => r.time > 5000);
    expect(settled.filter((r) => r.speed01 === 0).length).toBeLessThan(settled.length * 0.15);
    const cadence = results.at(-1)!.cadenceSpm;
    expect(cadence).toBeGreaterThan(60);
    expect(cadence).toBeLessThan(120);
  });

  it.each([[0, 'idle'], [90, 'walk'], [120, 'walk'], [160, 'run'], [190, 'run']] as const)('reads %i steps per minute as %s', (spm, gait) => {
    const speed = spm === 0 ? 0 : bounce(spm).find((r) => r.time > 6000)!.speed01;
    expect(gaitFor(speed, 'idle')).toBe(gait);
  });

  it('does not flicker between walking and running near the transition', () => {
    let gait: Gait = 'run';
    for (const speed of [0.56, 0.52, 0.56, 0.52]) gait = gaitFor(speed, gait);
    expect(gait).toBe('run');
    expect(gaitFor(0.45, gait)).toBe('walk');
  });

  it('cycles stopped, walking and running on distinct key presses', () => {
    expect(nextPace(0)).toBe(0.3);
    expect(nextPace(0.3)).toBe(0.8);
    expect(nextPace(0.8)).toBe(0);
    expect(nextPace(0.64)).toBe(0);
  });
});

describe('pace ownership between camera and keyboard', () => {
  const still = { speed01: 0, cadenceSpm: 0 };
  const press = (pace: Pace): Pace => ({ owner: 'keyboard', speed01: nextPace(pace.speed01), cadenceSpm: 0 });

  it('lets the camera stop a run it is pacing', () => {
    const pace = applySprint({ owner: 'camera', speed01: 0.8, cadenceSpm: 160 }, still);
    expect(pace).toEqual({ owner: 'camera', speed01: 0, cadenceSpm: 0 });
  });

  it('keeps the keyboard pick through frames of measured still', () => {
    const pace = applySprint({ owner: 'keyboard', speed01: 0.8, cadenceSpm: 0 }, still);
    expect(pace).toEqual({ owner: 'keyboard', speed01: 0.8, cadenceSpm: 0 });
  });

  it('hands the pace to the camera on a measured step, then follows its cadence', () => {
    const pace = applyStep({ owner: 'keyboard', speed01: 0.8, cadenceSpm: 0 });
    expect(pace.owner).toBe('camera');
    expect(applySprint(pace, { speed01: 0.6, cadenceSpm: 150 })).toEqual({ owner: 'camera', speed01: 0.6, cadenceSpm: 150 });
  });

  it('keeps the keyboard pick while the cadence decays without new steps', () => {
    let pace: Pace = { owner: 'keyboard', speed01: 0.3, cadenceSpm: 0 };
    for (const cadenceSpm of [120, 90, 60, 30]) pace = applySprint(pace, { speed01: 0.4, cadenceSpm });
    expect(pace).toEqual({ owner: 'keyboard', speed01: 0.3, cadenceSpm: 0 });
  });

  it('keeps camera pace when measured cadence decays while the camera owns it', () => {
    const pace = applySprint({ owner: 'camera', speed01: 0.6, cadenceSpm: 150 }, { speed01: 0.4, cadenceSpm: 120 });
    expect(pace).toEqual({ owner: 'camera', speed01: 0.4, cadenceSpm: 120 });
  });

  it('reaches running on two presses separated by still frames', () => {
    let pace: Pace = { owner: 'camera', speed01: 0, cadenceSpm: 0 };
    for (const target of [0.3, 0.8]) {
      pace = press(pace);
      pace = applySprint(pace, still);
      expect(pace.speed01).toBe(target);
    }
  });

  it('stops when the keyboard cycles back to zero and stays stopped', () => {
    let pace: Pace = { owner: 'keyboard', speed01: 0, cadenceSpm: 0 };
    pace = press(press(pace));
    pace = press(pace);
    pace = applySprint(pace, still);
    expect(pace.speed01).toBe(0);
  });

  it('freezes adjudication time while camera input is coasting, but not for keyboard ownership', () => {
    const coasting = applySprint(
      { owner: 'camera', speed01: 0.8, cadenceSpm: 150 },
      { speed01: 0.4, cadenceSpm: 90, trackingState: 'degraded' },
    );
    expect(coasting.speed01).toBe(0.4);
    expect(adjudicationDt(coasting, 1 / 60)).toBe(0);

    const measured = applySprint(coasting, { speed01: 0.7, cadenceSpm: 140, trackingState: 'tracked' });
    expect(adjudicationDt(measured, 1 / 60)).toBeCloseTo(1 / 60);
    expect(adjudicationDt(measured, 1 / 60, 401)).toBe(0);
    expect(adjudicationDt(measured, 1 / 60, 399)).toBeCloseTo(1 / 60);

    const keyboard: Pace = { owner: 'keyboard', speed01: 0.8, cadenceSpm: 0, cameraTracking: 'degraded' };
    expect(adjudicationDt(keyboard, 1 / 60)).toBeCloseTo(1 / 60);
  });
});

describe('stumble', () => {
  it('halves the shown speed and eases back to a keyboard pick without touching it', () => {
    const pace: Pace = { owner: 'keyboard', speed01: 0.8, cadenceSpm: 0 };
    let shown = stumble(0.8);
    expect(shown).toBeCloseTo(0.4);
    for (let i = 0; i < 60; i += 1) shown = easeSpeed(shown, pace.speed01, 1 / 60);
    expect(shown).toBeCloseTo(pace.speed01, 2);
  });

  it('still settles to a full stop after tripping while braking', () => {
    let shown = stumble(0.8);
    for (let i = 0; i < 60; i += 1) shown = easeSpeed(shown, 0, 1 / 60);
    expect(shown).toBe(0);
  });
});
