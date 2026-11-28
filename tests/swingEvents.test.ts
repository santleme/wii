import { describe, expect, it } from 'vitest';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { calibration, pose } from './fixtures/syntheticPose';

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

  it('reports strokes still being confirmed or arbitrated', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    for (const time of [0, 33, 66]) pipeline.update(pose(time), profile);

    const onset = pipeline.update(pose(100, { leftWristLateral: 0.3 }), profile);
    expect(onset.swingTracking.wrists).toEqual([
      { hand: 'right', tracked: true, pending: false, arbitrating: false },
      { hand: 'left', tracked: true, pending: true, arbitrating: false },
    ]);

    let tracking = onset.swingTracking;
    let confirmedAt300 = false;
    for (const [time, left, right] of [
      [150, 0.6, 0],
      [200, 0.9, 0],
      [250, 1.2, -0.3],
      [300, 1.5, 0.2],
    ] as const) {
      const result = pipeline.update(pose(time, { leftWristLateral: left, wristLateral: right }), profile);
      tracking = result.swingTracking;
      if (time === 300) confirmedAt300 = result.events.some((event) => event.type === 'swing' && event.hand === 'right');
    }

    expect(confirmedAt300).toBe(false);
    expect(tracking.wrists).toEqual([
      { hand: 'right', tracked: true, pending: false, arbitrating: true },
      { hand: 'left', tracked: true, pending: true, arbitrating: false },
    ]);
  });

  it('discards a practice swing when entering the match', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    for (const time of [0, 33, 66]) pipeline.update(pose(time), profile);
    const onset = pipeline.update(pose(100, { wristLateral: -0.3 }), profile);
    expect(onset.events.some(({ type }) => type === 'swing-start')).toBe(true);

    pipeline.resetSwings();
    const events = [150, 200, 250].flatMap((time) => (
      pipeline.update(pose(time, { wristLateral: 0.2 }), profile).events
    ));
    expect(events.some(({ type }) => type === 'swing')).toBe(false);
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

  it('confirms a swing when both image and world hips [23, 24] are out of frame (upper-body webcam framing)', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hideAllHips = (snapshot: ReturnType<typeof pose>) => ({
      ...snapshot,
      landmarks: snapshot.landmarks.map((p, i) => (i === 23 || i === 24 ? { ...p, visibility: 0.1, presence: 0.1 } : p)),
      worldLandmarks: snapshot.worldLandmarks.map((p, i) => (i === 23 || i === 24 ? { ...p, visibility: 0.1, presence: 0.1 } : p)),
    });
    for (const time of [0, 33, 66]) pipeline.update(hideAllHips(pose(time)), profile);
    const events = [
      hideAllHips(pose(100, { wristLateral: -0.3 })),
      hideAllHips(pose(150, { wristLateral: 0.2 })),
    ].flatMap((frame) => pipeline.update(frame, profile).events);
    expect(events.some((event) => event.type === 'swing-start')).toBe(true);
    expect(events.some((event) => event.type === 'swing')).toBe(true);
  });
});
