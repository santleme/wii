import { describe, expect, it } from 'vitest';
import type { PunchMeasurement, PunchTrajectorySample } from '../src/cv/protocol';
import { classifyPunch } from '../src/kinematics/punchClassifier';

/**
 * Fixtures exercise the real classification path: frozen onset-frame coordinates and the
 * self-bracketing shape window. Each point is [timeMs, lateral, vertical, forward, rawElbowCosine]
 * in the frozen frame; the shoulder-relative fields mirror them because rotation is not what
 * these fixtures exercise.
 */
function sample([time, lateral, vertical, forward, cosine]: readonly [number, number, number, number, number]): PunchTrajectorySample {
  return { timestampMs: time, lateral, vertical, forward, elbowCosine: cosine, rawElbowCosine: cosine, confidence: 1, frozen: { lateral, vertical, forward } };
}

function measurement(points: readonly (readonly [number, number, number, number, number])[]): PunchMeasurement {
  const samples = points.map(sample);
  const origin = samples[0]!;
  const contact = samples.reduce((best, point) => (point.forward > best.forward ? point : best), origin);
  const end = samples.at(-1)!;
  let pathLength = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1]!;
    const b = samples[index]!;
    pathLength += Math.hypot(b.lateral - a.lateral, b.vertical - a.vertical, b.forward - a.forward);
  }
  return {
    samples,
    onsetIndex: 0,
    origin,
    speedPeak: samples[1] ?? origin,
    contact,
    end,
    durationMs: end.timestampMs - origin.timestampMs,
    forwardTravel: contact.forward - origin.forward,
    lateralExcursion: Math.max(...samples.map((point) => point.lateral)) - Math.min(...samples.map((point) => point.lateral)),
    verticalRise: Math.max(...samples.map((point) => point.vertical)) - origin.vertical,
    pathLength,
    netDisplacement: Math.hypot(contact.lateral - origin.lateral, contact.vertical - origin.vertical, contact.forward - origin.forward),
    maxElbowCosine: Math.max(...samples.map((point) => point.elbowCosine)),
  };
}

describe('classifyPunch', () => {
  it('classifies a straight head punch, ignoring the retraction tail', () => {
    // Chamber bent, extension, then the way back: the tail must not dilute the forward share.
    const result = classifyPunch(measurement([
      [0, 0, 0.1, 0.2, 0.2],
      [80, 0.01, 0.08, 0.45, 0.5],
      [150, 0, 0.05, 0.7, 0.9],
      [230, 0, 0.06, 0.4, 0.4],
      [300, 0, 0.08, 0.2, 0.1],
    ]));
    expect(result).toMatchObject({ punchKind: 'straight', targetZone: 'head' });
  });

  it('classifies a straight body punch', () => {
    const result = classifyPunch(measurement([
      [0, 0, -0.2, 0.15, 0.2],
      [80, 0, -0.35, 0.4, 0.5],
      [150, 0, -0.42, 0.65, 0.85],
    ]));
    expect(result).toMatchObject({ punchKind: 'straight', targetZone: 'body' });
  });

  it('classifies a lateral hook', () => {
    const result = classifyPunch(measurement([
      [0, -0.2, 0.05, 0.2, 0.2],
      [80, 0, 0.08, 0.32, 0.4],
      [150, 0.28, 0.05, 0.42, 0.55],
    ]));
    expect(result.punchKind).toBe('hook');
  });

  it('classifies a rising uppercut', () => {
    const result = classifyPunch(measurement([
      [0, 0, -0.35, 0.15, 0.2],
      [80, 0.02, -0.05, 0.28, 0.45],
      [150, 0.03, 0.18, 0.38, 0.7],
    ]));
    expect(result).toMatchObject({ punchKind: 'uppercut', targetZone: 'head' });
  });

  it('never brackets the shape into an extended sample before the chamber', () => {
    // Reconstruction garbage or the tail of the previous punch: extended elbow, weird forward,
    // then the real punch chambered bent. The shape must start at the chamber, not the noise.
    const result = classifyPunch(measurement([
      [0, 0.6, -0.5, -0.6, 0.95],
      [80, 0, 0.1, 0.2, 0.2],
      [160, 0.01, 0.08, 0.5, 0.5],
      [240, 0, 0.05, 0.7, 0.9],
    ]));
    expect(result.punchKind).toBe('straight');
  });

  it('keeps weak or contradictory evidence unknown', () => {
    const result = classifyPunch(measurement([
      [0, 0, -0.1, 0.1, 0.2],
      [100, 0.02, -0.05, 0.2, 0.3],
    ]));
    expect(result.punchKind).toBe('unknown');
  });

  it('falls back to the shoulder-relative totals when no frozen frame exists', () => {
    const legacy = measurement([
      [0, 0, 0.1, 0.2, 0.2],
      [80, 0.01, 0.08, 0.45, 0.5],
      [150, 0, 0.05, 0.7, 0.9],
    ]);
    for (const point of legacy.samples) delete point.frozen;
    expect(classifyPunch(legacy).punchKind).toBe('straight');
  });
});
