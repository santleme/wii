import { describe, expect, it } from 'vitest';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { SwingDetector, type SwingOutput } from '../src/kinematics/swingDetector';
import { calibration, pose } from './fixtures/syntheticPose';

function confirmed(outputs: (SwingOutput | undefined)[]) {
  return outputs.filter((output) => output?.kind === 'confirmed');
}

describe('swing onset channel', () => {
  it('emits an onset at the threshold-crossing frame, strictly before the confirmation', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    const outputs = [
      detector.update(pose(0), profile),
      detector.update(pose(100, { wristLateral: -0.3 }), profile),
      detector.update(pose(150, { wristLateral: 0.2 }), profile),
    ];
    expect(outputs[0]).toBeUndefined();
    expect(outputs[1]).toMatchObject({ kind: 'onset', timestampMs: 100 });
    expect(outputs[2]).toMatchObject({ kind: 'confirmed' });
  });

  it('emits the onset exactly once per swing', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    const frames = [pose(0)];
    // Long accelerating stroke: many frames inside the swing must not re-fire the onset.
    for (let time = 50; time <= 350; time += 33) {
      frames.push(pose(time, { wristLateral: -0.15 - (time - 50) / 500 }));
    }
    const outputs = frames.map((frame) => detector.update(frame, profile));
    expect(outputs.filter((output) => output?.kind === 'onset')).toHaveLength(1);
  });

  it('keeps emitting onset for lateral motion that never confirms — it is an unconfirmed signal', () => {
    // This pins the contract on purpose: onsets fire on backswings and aborted motions too.
    // Consumers may use them for animation only, never for adjudication.
    const detector = new SwingDetector('right');
    const profile = calibration();
    const outputs = [
      detector.update(pose(0), profile),
      detector.update(pose(100, { wristLateral: -0.3 }), profile),
      detector.update(pose(3000, { wristLateral: -0.3 }), profile), // gap aborts the swing
    ];
    expect(outputs[1]).toMatchObject({ kind: 'onset' });
    expect(confirmed(outputs)).toHaveLength(0);
  });

  it('does not emit onset for vertical-only or depth-only fast motion', () => {
    for (const axis of ['wristVertical', 'wristDepth'] as const) {
      const detector = new SwingDetector('right');
      const profile = calibration();
      const outputs = [detector.update(pose(0), profile)];
      for (let time = 100; time <= 400; time += 40) {
        outputs.push(detector.update(pose(time, { [axis]: 0.3, wristLateral: 0.02 }), profile));
      }
      expect(outputs.filter(Boolean)).toHaveLength(0);
    }
  });
});

describe('confirmed swing enrichment', () => {
  function swingWithFinish(finish: 'up' | 'down' | 'level'): (SwingOutput | undefined)[] {
    const detector = new SwingDetector('right');
    const profile = calibration();
    const wristVertical = finish === 'up' ? 0.3 : finish === 'down' ? -0.15 : 0;
    const frames = [pose(0), pose(33), pose(66, { wristLateral: -0.11 })];
    for (let time = 99; time <= 495; time += 33) {
      frames.push(pose(time, { wristLateral: -0.12, wristVertical }), );
    }
    return frames.map((frame) => detector.update(frame, profile));
  }

  it('reports the onset and peak timestamps in order', () => {
    const detector = new SwingDetector('right');
    const profile = calibration();
    const outputs = [
      detector.update(pose(0), profile),
      detector.update(pose(100, { wristLateral: -0.3 }), profile),
      detector.update(pose(133, { wristLateral: -0.1 }), profile),
      detector.update(pose(166, { wristLateral: 0.2 }), profile),
    ];
    const [signal] = confirmed(outputs);
    expect(signal).toBeDefined();
    expect(signal!.onsetTimestampMs).toBe(100);
    expect(signal!.peakTimestampMs).toBeGreaterThanOrEqual(signal!.onsetTimestampMs);
  });

  it('reads an upward-finishing stroke as positive vertical speed — the topspin proxy', () => {
    const [up] = confirmed(swingWithFinish('up'));
    expect(up).toBeDefined();
    expect(up!.verticalSpeed).toBeGreaterThan(0);
  });

  it('reads a downward-finishing stroke as negative vertical speed — the slice proxy', () => {
    const [down] = confirmed(swingWithFinish('down'));
    expect(down).toBeDefined();
    expect(down!.verticalSpeed).toBeLessThan(0);
  });

  it('reports a higher contact height for a high finish than a low one', () => {
    const [up] = confirmed(swingWithFinish('up'));
    const [down] = confirmed(swingWithFinish('down'));
    expect(up!.contactY).toBeGreaterThan(down!.contactY);
  });
});

describe('pipeline swing-start and enriched events', () => {
  function trackedSwing(hand: 'left' | 'right') {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const lateralKey = hand === 'right' ? 'wristLateral' : 'leftWristLateral';
    const timeline: [number, number][] = [
      [0, 0], [33, 0], [66, 0],
      [100, hand === 'right' ? -0.3 : 0.3],
      [150, hand === 'right' ? 0.2 : -0.2],
      [200, 0],
    ];
    return timeline.flatMap(([time, lateral]) => (
      pipeline.update(pose(time, { [lateralKey]: lateral }), profile).events
    ));
  }

  it('emits a swing-start event in real time, ahead of the confirmed swing', () => {
    const events = trackedSwing('right');
    const start = events.find((event) => event.type === 'swing-start');
    const swing = events.find((event) => event.type === 'swing');
    expect(start).toMatchObject({ hand: 'right', timestampMs: 100 });
    expect(swing).toBeDefined();
    expect(start!.timestampMs).toBeLessThan(swing!.timestampMs);
  });

  it('carries contact height, vertical speed and onset time on the confirmed swing', () => {
    const swing = trackedSwing('right').find((event) => event.type === 'swing');
    expect(swing?.type).toBe('swing');
    if (swing?.type !== 'swing') return;
    expect(swing.onsetTimestampMs).toBe(100);
    expect(typeof swing.contactY).toBe('number');
    expect(typeof swing.verticalSpeed).toBe('number');
  });

  it('does not emit swing-start when the wrist gate is lost', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const events = [0, 100, 150, 200].flatMap((time) => (
      pipeline.update(pose(time, { confidence: 0.1, wristLateral: time === 100 ? -0.3 : 0 }), profile).events
    ));
    expect(events.filter((event) => event.type === 'swing-start' || event.type === 'swing')).toHaveLength(0);
  });

  it('rearms and confirms the first swing at a steady 133 ms pose cadence', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    for (const time of [0, 133, 266]) pipeline.update(pose(time));
    for (const time of [399, 532, 665, 798, 931, 1064]) pipeline.update(pose(time), profile);

    const events = [
      pose(1197, { wristLateral: -0.3 }),
      pose(1330, { wristLateral: 0.2 }),
    ].flatMap((frame) => pipeline.update(frame, profile).events);

    expect(events.some((event) => event.type === 'swing-start')).toBe(true);
    expect(events.some((event) => event.type === 'swing')).toBe(true);
  });
});
