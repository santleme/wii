import { describe, expect, it } from 'vitest';
import { HandCursorDetector, type MenuHandSnapshot } from '../src/kinematics/handCursor';
import { emptyHand, hand } from './fixtures/menuHand';
import { rotationalWorldLandmarks } from './fixtures/rotationalHand';

function synched(detector = new HandCursorDetector()) {
  for (let time = 0; time <= 1000; time += 100) detector.update(hand(time));
  return detector;
}

function syncedForGestureTiming() {
  return synched(new HandCursorDetector({ maxFrameGapMs: 1000 }));
}

function pinchSeries(detector: HandCursorDetector, frames: readonly [time: number, ratio: number][]) {
  return frames.map(([time, ratio]) => detector.update(hand(time, { pinchRatio: ratio })));
}

describe('hand cursor synchronization and active zone', () => {
  it('mirrors x and maps the whole camera frame to the whole screen', () => {
    const leftImage = new HandCursorDetector().update(hand(0, { tipX: 0.2, tipY: 0.5 }));
    const rightImage = new HandCursorDetector().update(hand(0, { tipX: 0.8, tipY: 0.5 }));
    expect(leftImage.x).toBeCloseTo(0.8);
    expect(rightImage.x).toBeCloseTo(0.2);
    expect(leftImage.y).toBeCloseTo(0.5);
    expect(rightImage.y).toBeCloseTo(0.5);
  });

  it('clamps positions outside the camera frame instead of leaving the screen', () => {
    expect(new HandCursorDetector().update(hand(0, { tipX: 1.2, tipY: -0.2 }))).toMatchObject({ x: 0, y: 0 });
    expect(new HandCursorDetector().update(hand(0, { tipX: -0.2, tipY: 1.2 }))).toMatchObject({ x: 1, y: 1 });
  });

  it('syncs after 200ms of hand presence without requiring the hand to stay still', () => {
    const detector = new HandCursorDetector();
    const states = [
      detector.update(hand(0, { tipX: 0.3 })),
      detector.update(hand(100, { tipX: 0.5 })),
      detector.update(hand(200, { tipX: 0.7 })),
    ];
    expect(states[0]).toMatchObject({ syncProgress: 0, synced: false, visible: false });
    expect(states[1]).toMatchObject({ syncProgress: 0.5, synced: false, visible: false });
    expect(states[2]).toMatchObject({ syncProgress: 1, synced: true, visible: true });
  });

  it('keeps the active zone covering the whole camera after synchronization', () => {
    const detector = new HandCursorDetector();
    let completed = detector.update(hand(0, { tipX: 0.9, tipY: 0.8 }));
    for (let time = 100; time <= 300; time += 100) completed = detector.update(hand(time, { tipX: 0.9, tipY: 0.8 }));
    expect(completed).toMatchObject({
      synced: true,
      activeZone: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
    });
    expect(completed.x).toBeCloseTo(0.1);
    expect(completed.y).toBeCloseTo(0.8);
  });

  it('accumulates presence across brief detection gaps', () => {
    const detector = new HandCursorDetector();
    detector.update(hand(0));
    detector.update(hand(100));
    detector.update(emptyHand(150));
    expect(detector.update(hand(200))).toMatchObject({ synced: true, visible: true });
  });

  it('caps long observation gaps instead of counting time with no observed hand', () => {
    const detector = new HandCursorDetector();
    detector.update(hand(0));
    expect(detector.update(hand(1000))).toMatchObject({ syncProgress: 0.5, synced: false });
    expect(detector.update(hand(1100))).toMatchObject({ synced: true });
  });

  it('keeps the cursor visible at the last position through a brief loss', () => {
    const detector = synched();
    const before = detector.update(hand(1100, { tipX: 0.4, tipY: 0.4 }));
    expect(before.synced).toBe(true);
    expect(detector.update(emptyHand(1200))).toMatchObject({ visible: true, synced: true, x: before.x, y: before.y });
    const reacquired = detector.update(hand(1450, { tipX: 0.7, tipY: 0.7 }));
    expect(reacquired).toMatchObject({ visible: true, synced: true });
    expect(reacquired.x).toBeCloseTo(0.3);
    expect(reacquired.y).toBeCloseTo(0.7);
  });

  it('requires synchronization again after a long loss', () => {
    const detector = synched();
    expect(detector.update(emptyHand(1100)).synced).toBe(true);
    expect(detector.update(emptyHand(1850)).synced).toBe(false);
    expect(detector.update(hand(1900))).toMatchObject({ synced: false, syncProgress: 0 });
  });

  it('expires the loss grace even when reacquisition is the next frame after one empty snapshot', () => {
    const detector = synched();
    expect(detector.update(emptyHand(1100))).toMatchObject({ visible: true, synced: true });
    const reacquired = detector.update(hand(2000));
    expect(reacquired).toMatchObject({ visible: false, synced: false, syncProgress: 0 });
  });

  it('does not reuse a stale frozen position after a long tracking loss', () => {
    const detector = synched();
    const oldPosition = detector.update(hand(1100, { tipX: 0.4, tipY: 0.4 }));
    detector.update(emptyHand(1200));
    detector.update(hand(2000, { tipX: 0.8, tipY: 0.8, pinchRatio: 0.8 }));
    detector.update(hand(2100, { tipX: 0.8, tipY: 0.8, pinchRatio: 0.8 }));
    detector.update(hand(2200, { tipX: 0.8, tipY: 0.8, pinchRatio: 0.8 }));
    detector.update(hand(2300, { tipX: 0.8, tipY: 0.8, pinchRatio: 0.2 }));
    const click = detector.update(hand(2400, { tipX: 0.8, tipY: 0.8, pinchRatio: 0.2 }));
    expect(click.pinchRelease).toBe(true);
    expect(click.x).not.toBeCloseTo(oldPosition.x);
    expect(click.x).toBeLessThan(0.4);
  });

  it('synchronizes at equivalent times across frame rates', () => {
    const syncTimes = [16, 33, 66].map((step) => {
      const detector = new HandCursorDetector();
      for (let time = 0; time <= 500; time += step) {
        if (detector.update(hand(time)).synced) return time;
      }
      throw new Error('hand did not synchronize');
    });
    expect(Math.max(...syncTimes) - Math.min(...syncTimes)).toBeLessThanOrEqual(70);
  });
});

describe('hand cursor hand validation', () => {
  it('never synchronizes while the handedness score stays below 0.75', () => {
    const detector = new HandCursorDetector();
    let state = detector.update({ ...hand(0), handednessScore: 0.5 });
    for (let time = 100; time <= 1000; time += 100) state = detector.update({ ...hand(time), handednessScore: 0.5 });
    expect(state).toMatchObject({ synced: false, syncProgress: 0, visible: false });
  });

  it('synchronizes with a handedness score of exactly 0.75 or with no score at all', () => {
    for (const handednessScore of [0.75, undefined]) {
      const detector = new HandCursorDetector();
      let synced = false;
      for (let time = 0; time <= 300; time += 100) {
        synced = detector.update({ ...hand(time), handednessScore }).synced || synced;
      }
      expect(synced).toBe(true);
    }
  });

  it('rejects a degenerate palm scale while the same shape above 0.03 synchronizes', () => {
    const tiny = new HandCursorDetector();
    let state = tiny.update(hand(0, { scale: 0.02 }));
    for (let time = 100; time <= 1000; time += 100) state = tiny.update(hand(time, { scale: 0.02 }));
    expect(state).toMatchObject({ synced: false, syncProgress: 0, visible: false });

    // the bounding-box ratio is scale-invariant, so the healthy hand differs only in the scale gate
    const healthy = new HandCursorDetector();
    let synced = false;
    for (let time = 0; time <= 300; time += 100) synced = healthy.update(hand(time, { scale: 0.04 })).synced || synced;
    expect(synced).toBe(true);
  });

  it('rejects bounding boxes outside the 0.25..3.5 width-to-height ratio in either direction', () => {
    // wrist and MIDDLE_MCP share the same x, so rescaling x around the anchor keeps their distance
    // intact and the rejection can only come from the bounding-box ratio.
    const xScaled = (timestampMs: number, factor: number): MenuHandSnapshot => {
      const snapshot = hand(timestampMs);
      const centerX = snapshot.landmarks[9]!.x;
      return {
        ...snapshot,
        landmarks: snapshot.landmarks.map((landmark) => ({ ...landmark, x: centerX + (landmark.x - centerX) * factor })),
      };
    };
    for (const factor of [0.1, 10]) {
      const detector = new HandCursorDetector();
      let state = detector.update(xScaled(0, factor));
      for (let time = 100; time <= 1000; time += 100) state = detector.update(xScaled(time, factor));
      expect(state).toMatchObject({ synced: false, syncProgress: 0 });
    }

    const control = new HandCursorDetector();
    let synced = false;
    for (let time = 0; time <= 300; time += 100) synced = control.update(xScaled(time, 0.5)).synced || synced;
    expect(synced).toBe(true);
  });
});

describe('hand cursor distance-sensitive active zone', () => {
  it('shrinks the zone for a close hand so the screen edge is reached before the camera edge', () => {
    const detector = new HandCursorDetector();
    let state = detector.update(hand(0, { scale: 0.3, tipX: 0.37, tipY: 0.5 }));
    for (let time = 100; time <= 1000; time += 100) {
      state = detector.update(hand(time, { scale: 0.3, tipX: 0.37, tipY: 0.5 }));
    }
    expect(state.activeZone.minX).toBeCloseTo(0.37);
    expect(state.activeZone.maxX).toBeCloseTo(0.63);
    expect(state.activeZone.minY).toBeCloseTo(0.37);
    expect(state.activeZone.maxY).toBeCloseTo(0.63);
    // camera x 0.37 mirrors to pointer x 0.63, the inner edge of the shrunk zone
    expect(state.x).toBeCloseTo(1);
  });

  it('keeps the zone covering the whole camera frame for a distant hand', () => {
    const detector = new HandCursorDetector();
    let state = detector.update(hand(0, { scale: 0.1, tipX: 0.25, tipY: 0.5 }));
    for (let time = 100; time <= 1000; time += 100) {
      state = detector.update(hand(time, { scale: 0.1, tipX: 0.25, tipY: 0.5 }));
    }
    expect(state.activeZone).toMatchObject({ minX: 0, maxX: 1, minY: 0, maxY: 1 });
    expect(state.x).toBeCloseTo(0.75);
  });

  it('never overrides an explicit active zone even for a close hand', () => {
    const zone = { minX: 0.2, maxX: 0.8, minY: 0.1, maxY: 0.9 };
    const detector = new HandCursorDetector({ activeZone: zone });
    let state = detector.update(hand(0, { scale: 0.3 }));
    for (let time = 100; time <= 1000; time += 100) state = detector.update(hand(time, { scale: 0.3 }));
    expect(state.activeZone).toEqual(zone);
  });
});

describe('hand cursor smoothing', () => {
  it('attenuates alternating fingertip jitter without leaving the active zone', () => {
    const detector = synched();
    const outputs = [];
    for (let index = 0; index < 12; index++) {
      const dx = index % 2 === 0 ? 0.02 : -0.02;
      outputs.push(detector.update(hand(1100 + index * 33, { dx })));
    }
    const xs = outputs.map((state) => state.x);
    const inputSpread = 0.04;
    const outputSpread = Math.max(...xs) - Math.min(...xs);
    expect(outputSpread).toBeLessThan(inputSpread * 0.45);
    expect(outputs.every((state) => state.x >= 0 && state.x <= 1)).toBe(true);
  });

  it('remains responsive to a deliberate step movement', () => {
    const detector = synched();
    const start = detector.update(hand(1100, { tipX: 0.5 })).x;
    let latest = start;
    for (let time = 1133; time <= 1800; time += 33) latest = detector.update(hand(time, { tipX: 0.7 })).x;
    const target = 1 - 0.7;
    const initialDistance = Math.abs(target - start);
    const remainingDistance = Math.abs(target - latest);
    expect(remainingDistance).toBeLessThan(initialDistance * 0.35);
  });
});

describe('hand cursor pointer anchor', () => {
  it('keeps the cursor fixed while only the pinch fingertips move, because the anchor is MIDDLE_MCP', () => {
    // pinchOnRatio 0 disables pinch activation, so neither pinch nor fist can freeze the cursor:
    // any output motion would have to come from the anchor following the fingertips.
    const spreadTips = (timestampMs: number): MenuHandSnapshot => {
      const snapshot = hand(timestampMs, { tipX: 0.5, tipY: 0.5 });
      const landmarks = snapshot.landmarks.map((landmark) => ({ ...landmark }));
      landmarks[8]!.x += 0.12;
      landmarks[8]!.y -= 0.04;
      landmarks[4]!.x += 0.08;
      landmarks[4]!.y += 0.03;
      return { ...snapshot, landmarks };
    };

    const detector = new HandCursorDetector({ pinchOnRatio: 0 });
    for (let time = 0; time <= 1000; time += 100) detector.update(hand(time, { tipX: 0.5, tipY: 0.5 }));
    const before = detector.update(hand(1100, { tipX: 0.5, tipY: 0.5 }));
    for (const time of [1200, 1300, 1400, 1500]) {
      const state = detector.update(spreadTips(time));
      expect(state.x).toBeCloseTo(before.x);
      expect(state.y).toBeCloseTo(before.y);
    }

    // control: the same fingertip motion must move a tip- or midIndex-anchored cursor,
    // otherwise the stability asserted above would be vacuous.
    for (const pointerAnchor of ['tip', 'midIndex'] as const) {
      const control = new HandCursorDetector({ pinchOnRatio: 0, pointerAnchor });
      for (let time = 0; time <= 1000; time += 100) control.update(hand(time, { tipX: 0.5, tipY: 0.5 }));
      const controlBefore = control.update(hand(1100, { tipX: 0.5, tipY: 0.5 }));
      let controlState = controlBefore;
      for (const time of [1200, 1300, 1400, 1500]) controlState = control.update(spreadTips(time));
      expect(Math.abs(controlState.x - controlBefore.x)).toBeGreaterThan(0.01);
    }
  });
});

describe('hand cursor pinch click', () => {
  it('suppresses pinch and back gestures before synchronization', () => {
    const detector = new HandCursorDetector();
    const pinched = detector.update(hand(0, { pinchRatio: 0.2 }));
    const fist = detector.update(hand(100, { curl: 1, pinchRatio: 0.2 }));
    expect(pinched).toMatchObject({ pinching: false, pinchRelease: false });
    expect(fist).toMatchObject({ backProgress: 0, pinchRelease: false });
  });

  it('ignores a one-frame pinch blip instead of clicking on noise', () => {
    const detector = synched();
    detector.update(hand(1100, { pinchRatio: 0.8 }));
    expect(detector.update(hand(1200, { pinchRatio: 0.2 }))).toMatchObject({ pinching: false, pinchRelease: false });
    detector.update(hand(1300, { pinchRatio: 0.8 }));
    detector.update(hand(1400, { pinchRatio: 0.2 }));
    expect(detector.update(hand(1500, { pinchRatio: 0.2 }))).toMatchObject({ pinching: true, pinchRelease: true });
  });

  it('fires once through the hysteresis cycle and freezes the cursor while pinching', () => {
    const detector = syncedForGestureTiming();
    const target = detector.update(hand(1100, { tipX: 0.4, tipY: 0.4, pinchRatio: 0.8 }));
    detector.update(hand(1150, { tipX: 0.4, tipY: 0.4, pinchRatio: 0.2 }));
    const press = detector.update(hand(1250, { tipX: 0.4, tipY: 0.4, pinchRatio: 0.2 }));
    expect(press).toMatchObject({ pinching: true, pinchRelease: true, x: target.x, y: target.y });
    const held = detector.update(hand(1250, { tipX: 0.7, tipY: 0.7, pinchRatio: 0.35 }));
    expect(held).toMatchObject({ pinching: true, pinchRelease: false, x: target.x, y: target.y });
    const released = detector.update(hand(1300, { tipX: 0.7, tipY: 0.7, pinchRatio: 0.6 }));
    expect(released).toMatchObject({ pinching: false, pinchRelease: false });
    expect(released.x).not.toBeCloseTo(target.x);
  });

  it('keeps the click cooldown and re-arm requirement across a tracking-loss frame', () => {
    const detector = synched();
    detector.update(hand(1100, { pinchRatio: 0.8 }));
    detector.update(hand(1150, { pinchRatio: 0.2 }));
    expect(detector.update(hand(1250, { pinchRatio: 0.2 })).pinchRelease).toBe(true);
    detector.update(hand(1230, { pinchRatio: 0.6 }));
    detector.update(emptyHand(1260));
    expect(detector.update(hand(1290, { pinchRatio: 0.2 }))).toMatchObject({ pinching: false, pinchRelease: false });
    detector.update(hand(1320, { pinchRatio: 0.6 }));
    detector.update(hand(1360, { pinchRatio: 0.2 }));
    expect(detector.update(hand(1460, { pinchRatio: 0.2 })).pinchRelease).toBe(false);
    detector.update(hand(1490, { pinchRatio: 0.6 }));
    detector.update(hand(1530, { pinchRatio: 0.2 }));
    expect(detector.update(hand(1630, { pinchRatio: 0.2 })).pinchRelease).toBe(true);
  });

  it('enforces the click cooldown between presses', () => {
    const detector = synched();
    const states = pinchSeries(detector, [
      [1100, 0.8],
      [1150, 0.2],
      [1250, 0.2],
      [1300, 0.6],
      [1350, 0.2],
      [1400, 0.2],
      [1450, 0.6],
      [1500, 0.2],
      [1600, 0.2],
    ]);
    expect(states.map((state) => state.pinchRelease)).toEqual([false, false, true, false, false, false, false, false, true]);
  });

  it('aspect-corrects vertical geometry instead of assuming square normalized coordinates', () => {
    const square = synched();
    square.update(hand(1100, { pinchRatio: 0.8 }));
    square.update(hand(1150, { pinchRatio: 0.24 }));
    expect(square.update(hand(1250, { pinchRatio: 0.24 })).pinchRelease).toBe(true);

    const wide = synched();
    wide.update(hand(1100, { pinchRatio: 0.8 }));
    wide.update({ ...hand(1150, { pinchRatio: 0.24 }), aspectY: 0.75 });
    expect(wide.update({ ...hand(1250, { pinchRatio: 0.24 }), aspectY: 0.75 }).pinchRelease).toBe(false);
  });

  it('keeps the same pinch threshold invariant across hand scales', () => {
    for (const scale of [0.05, 0.1, 0.2]) {
      const detector = new HandCursorDetector();
      for (let time = 0; time <= 1000; time += 100) detector.update(hand(time, { scale, pinchRatio: 0.8 }));
      detector.update(hand(1100, { scale, pinchRatio: 0.2 }));
      expect(detector.update(hand(1200, { scale, pinchRatio: 0.2 })).pinchRelease).toBe(true);
    }
  });

  it('ignores degenerate hand scale without producing NaN or a click', () => {
    const detector = synched();
    const state = detector.update(hand(1100, { pinchRatio: 0.2, scale: 0 }));
    expect(state.pinchRelease).toBe(false);
    expect(Number.isFinite(state.x)).toBe(true);
    expect(Number.isFinite(state.y)).toBe(true);
  });
});

describe('hand cursor integrated gesture session', () => {
  it('syncs, clicks once at the frozen target, then completes a back gesture', () => {
    const detector = syncedForGestureTiming();
    const target = detector.update(hand(1100, { tipX: 0.4, tipY: 0.4, pinchRatio: 0.8 }));
    detector.update(hand(1150, { tipX: 0.4, tipY: 0.4, pinchRatio: 0.2 }));
    const clickStates = [
      detector.update(hand(1250, { tipX: 0.4, tipY: 0.4, pinchRatio: 0.2 })),
      detector.update(hand(1300, { tipX: 0.65, tipY: 0.65, pinchRatio: 0.35 })),
      detector.update(hand(1350, { tipX: 0.65, tipY: 0.65, pinchRatio: 0.7 })),
    ];
    expect(clickStates.map((state) => state.pinchRelease)).toEqual([true, false, false]);
    expect(clickStates[0]).toMatchObject({ x: target.x, y: target.y });
    expect(clickStates[1]).toMatchObject({ x: target.x, y: target.y });

    detector.update(hand(1400, { curl: 1 }));
    expect(detector.update(hand(1900, { curl: 1 }))).toMatchObject({
      backProgress: 1,
      pinchRelease: false,
      pinching: false,
    });
  });
});

describe('hand cursor closed-fist back gesture', () => {
  it('ramps progress while the fist is held and resets when the hand opens', () => {
    const detector = syncedForGestureTiming();
    expect(detector.update(hand(1100, { curl: 1 })).backProgress).toBe(0);
    expect(detector.update(hand(1300, { curl: 1 })).backProgress).toBeCloseTo(0.4);
    expect(detector.update(hand(1600, { curl: 1 })).backProgress).toBe(1);
    expect(detector.update(hand(1700, { curl: 1 })).backProgress).toBe(1);
    expect(detector.update(hand(1800, { curl: 0 })).backProgress).toBe(0);
  });

  it('tolerates a partial geometric flicker but releases when the hand fully opens', () => {
    const detector = syncedForGestureTiming();
    detector.update(hand(1100, { curl: 1 }));
    expect(detector.update(hand(1200, { curl: 1 })).backProgress).toBeCloseTo(0.2);
    expect(detector.update(hand(1300, { curl: 0.55 })).backProgress).toBeCloseTo(0.4);
    expect(detector.update(hand(1400, { curl: 1 })).backProgress).toBeCloseTo(0.6);
    expect(detector.update(hand(1500, { curl: 0 })).backProgress).toBe(0);
  });

  it('resets progress when the fist is interrupted before completion', () => {
    const detector = syncedForGestureTiming();
    detector.update(hand(1100, { curl: 1 }));
    expect(detector.update(hand(1300, { curl: 1 })).backProgress).toBeCloseTo(0.4);
    expect(detector.update(hand(1400, { curl: 0 })).backProgress).toBe(0);
    expect(detector.update(hand(1500, { curl: 1 })).backProgress).toBe(0);
  });

  it('keeps active gestures dominant and treats simultaneous new pinch-plus-fist geometry as a fist', () => {
    const fistFirst = syncedForGestureTiming();
    fistFirst.update(hand(1100, { curl: 1 }));
    const held = fistFirst.update(hand(1200, { curl: 1, pinchRatio: 0.1 }));
    expect(held).toMatchObject({ pinching: false, pinchRelease: false });
    expect(fistFirst.update(hand(1600, { curl: 1, pinchRatio: 0.1 })).backProgress).toBe(1);

    const pinchFirst = syncedForGestureTiming();
    pinchFirst.update(hand(1100, { pinchRatio: 0.8 }));
    pinchFirst.update(hand(1150, { pinchRatio: 0.2 }));
    expect(pinchFirst.update(hand(1250, { pinchRatio: 0.2 })).pinchRelease).toBe(true);
    expect(pinchFirst.update(hand(1350, { curl: 1, pinchRatio: 0.1 }))).toMatchObject({
      pinching: true,
      backProgress: 0,
    });

    const neutral = syncedForGestureTiming();
    const ambiguous = neutral.update(hand(1100, { curl: 1, pinchRatio: 0.1 }));
    expect(ambiguous).toMatchObject({ pinching: false, pinchRelease: false, backProgress: 0 });
    expect(neutral.update(hand(1600, { curl: 1, pinchRatio: 0.1 })).backProgress).toBe(1);
  });

  it('cancels and rearms an incomplete back gesture across a long observation gap', () => {
    const detector = synched();
    detector.update(hand(1100, { curl: 1 }));
    expect(detector.update(hand(1500, { curl: 1 })).backProgress).toBe(0);
    detector.update(hand(1600, { curl: 0 }));
    detector.update(hand(1700, { curl: 1 }));
    for (const time of [1800, 1900, 2000, 2100]) detector.update(hand(time, { curl: 1 }));
    expect(detector.update(hand(2200, { curl: 1 })).backProgress).toBe(1);
  });

  it('does not start the back gesture when the hand was already closed during synchronization', () => {
    const detector = new HandCursorDetector({ maxFrameGapMs: 1000 });
    for (let time = 0; time <= 1000; time += 100) detector.update(hand(time, { curl: 1 }));
    expect(detector.update(hand(1100, { curl: 1 })).backProgress).toBe(0);
    expect(detector.update(hand(1600, { curl: 1 })).backProgress).toBe(0);

    detector.update(hand(1700, { curl: 0 }));
    expect(detector.update(hand(1800, { curl: 1 })).backProgress).toBe(0);
    expect(detector.update(hand(2300, { curl: 1 })).backProgress).toBe(1);
  });

  it('freezes the cursor while the fist progress is being held', () => {
    const detector = syncedForGestureTiming();
    const before = detector.update(hand(1100, { tipX: 0.4, tipY: 0.4 }));
    const held = detector.update(hand(1200, { tipX: 0.7, tipY: 0.7, curl: 1 }));
    expect(held).toMatchObject({ x: before.x, y: before.y, backProgress: 0 });
  });
});

describe('hand cursor rotational flick arbitration', () => {
  const rotationalMenuHand = (
    timestampMs: number,
    angleDeg: number,
    options: {
      curl?: number;
      pinchRatio?: number;
      tipX?: number;
      rotationEnabled?: boolean;
      imageCurl?: number;
    } = {},
  ): MenuHandSnapshot => ({
    ...hand(timestampMs, {
      pinchRatio: options.pinchRatio ?? 0.8,
      tipX: options.tipX,
      curl: options.imageCurl ?? 0,
    }),
    worldLandmarks: rotationalWorldLandmarks(angleDeg, options.curl ?? 0.65),
    rotationEnabled: options.rotationEnabled ?? true,
  });

  const syncRotational = (detector = new HandCursorDetector()) => {
    for (let time = 0; time <= 200; time += 100) detector.update(rotationalMenuHand(time, 0));
    return detector;
  };

  const rotate = (
    detector: HandCursorDetector,
    startMs: number,
    frames: number,
    options: Parameters<typeof rotationalMenuHand>[2] = {},
  ) => {
    const states = [];
    for (let frame = 0; frame < frames; frame += 1) {
      states.push(detector.update(rotationalMenuHand(startMs + frame * 16, frame * 3, options)));
    }
    return states;
  };

  it('keeps the rotational detector idle when rotationEnabled is false', () => {
    const detector = new HandCursorDetector();
    for (let time = 0; time <= 200; time += 100) detector.update(rotationalMenuHand(time, 0, { rotationEnabled: false }));
    const states = rotate(detector, 216, 12, { rotationEnabled: false });
    expect(states.every((state) => state.rotationPhase === 'IDLE')).toBe(true);
    expect(states.every((state) => state.rotationAngularVelocity === 0)).toBe(true);
  });

  it('publishes phase, direction, and carousel-ready velocity for a cupped rotational impulse', () => {
    const detector = syncRotational();
    const states = rotate(detector, 216, 12);
    const rotating = states.find((state) => state.rotationPhase === 'ROTATING');
    expect(rotating).toBeDefined();
    expect(rotating!.rotationDirection).toBe(-1); // positive fixture rotation is counterclockwise in the mirrored preview
    expect(rotating!.rotationAngularVelocity).toBeLessThan(0);
    expect(rotating!.rotationRawAngularVelocity).toBeGreaterThan(0);
  });

  it('suppresses a held pinch during rotation and requires release before the next click', () => {
    const detector = syncRotational();
    const rotating = rotate(detector, 216, 12, { pinchRatio: 0.2 });
    expect(rotating.some((state) => state.rotationPhase === 'ROTATING')).toBe(true);
    expect(rotating.every((state) => !state.pinchRelease && !state.pinching)).toBe(true);

    const stillHeld = detector.update(rotationalMenuHand(500, 33, { pinchRatio: 0.2, rotationEnabled: false }));
    expect(stillHeld).toMatchObject({ pinchRelease: false, pinching: false });
    detector.update(rotationalMenuHand(516, 33, { pinchRatio: 0.8, rotationEnabled: false }));
    detector.update(rotationalMenuHand(532, 33, { pinchRatio: 0.2, rotationEnabled: false }));
    const rearmed = detector.update(rotationalMenuHand(632, 33, { pinchRatio: 0.2, rotationEnabled: false }));
    expect(rearmed.pinchRelease).toBe(true);
  });

  it('keeps back progress at zero during rotation and re-arms the fist afterwards', () => {
    const detector = syncRotational();
    const rotating = rotate(detector, 216, 12, { imageCurl: 1, pinchRatio: 0.2 });
    expect(rotating.some((state) => state.rotationPhase === 'ROTATING')).toBe(true);
    expect(rotating.every((state) => state.backProgress === 0)).toBe(true);
    const after = detector.update(rotationalMenuHand(500, 33, { imageCurl: 1, pinchRatio: 0.2, rotationEnabled: false }));
    expect(after.backProgress).toBe(0);
  });

  it('freezes the cursor position while rotation owns the hand', () => {
    const detector = syncRotational();
    const before = detector.update(rotationalMenuHand(216, 0, { tipX: 0.5 }));
    const moving = [];
    for (let frame = 1; frame < 12; frame += 1) {
      moving.push(detector.update(rotationalMenuHand(216 + frame * 16, frame * 3, { tipX: 0.5 + frame * 0.02 })));
    }
    const active = moving.filter((state) => state.rotationPhase !== 'IDLE');
    expect(active.length).toBeGreaterThan(0);
    expect(active.every((state) => state.x === before.x && state.y === before.y)).toBe(true);
  });

  it('cancels rotation on tracking loss instead of leaving velocity or gestures armed', () => {
    const detector = syncRotational();
    const rotating = rotate(detector, 216, 12);
    expect(rotating.some((state) => state.rotationPhase === 'ROTATING')).toBe(true);
    const lost = detector.update({ ...emptyHand(400), rotationEnabled: true });
    expect(lost.rotationPhase).toBe('CANCELLED');
    expect(lost.rotationRejectReason).toBe('missing-hand');
    expect(lost).toMatchObject({ pinchRelease: false, backProgress: 0, rotationAngularVelocity: 0 });
  });
});

describe('index finger tap click', () => {
  const tapper = () => synched(new HandCursorDetector({ indexTapClick: true }));
  /** One frame every 40 ms from t = 1100, each with the given index bend. */
  const frames = (detector: HandCursorDetector, bends: number[], extra: Parameters<typeof hand>[1] = {}, from = 1100) =>
    bends.map((indexCurl, i) => detector.update(hand(from + i * 40, { ...extra, indexCurl })));
  const clicks = (states: { pinchRelease: boolean }[]) => states.filter((state) => state.pinchRelease).length;

  it('clicks once per flexion and needs the finger straight again', () => {
    const detector = tapper();
    const first = frames(detector, [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(clicks(first)).toBe(1);
    expect(first[4]).toMatchObject({ pinching: true });
    const second = frames(detector, [0, 0, 1, 1, 1, 1], {}, 1700);
    expect(second[0]).toMatchObject({ pinching: false });
    expect(clicks(second)).toBe(1);
  });

  it('does not click when every finger closes into a fist', () => {
    const detector = tapper();
    detector.update(hand(1100));
    const states = [1140, 1180, 1220, 1260, 1300].map((time) => detector.update(hand(time, { curl: 1 })));
    expect(clicks(states)).toBe(0);
  });

  it('keeps the pointer still while the index bends', () => {
    const detector = tapper();
    const [aimed] = frames(detector, [0, 0, 0]).slice(-1);
    const bent = [0.7, 1, 1, 1].map((indexCurl, i) =>
      detector.update(hand(1220 + i * 40, { indexCurl, dx: 0.004 * (i + 1), dy: 0.004 * (i + 1) })),
    );
    expect(clicks(bent)).toBe(1);
    for (const state of bent) expect(state).toMatchObject({ x: aimed!.x, y: aimed!.y });
  });

  it('ignores a flexion while the hand is sweeping across the screen', () => {
    const detector = tapper();
    detector.update(hand(1100));
    const states = [0, 1, 1, 1, 1].map((indexCurl, i) =>
      detector.update(hand(1140 + i * 40, { indexCurl, dx: 0.02 * (i + 1) })),
    );
    expect(clicks(states)).toBe(0);
  });

  it('lets go of the pointer when a half bend never becomes a click', () => {
    const detector = tapper();
    frames(detector, [0, 0]);
    const half = Array.from({ length: 16 }, (_, i) =>
      detector.update(hand(1180 + i * 40, { indexCurl: 0.5, dx: 0.001 * i })),
    );
    expect(clicks(half)).toBe(0);
    expect(half.at(-1)!.x).not.toBeCloseTo(half[0]!.x, 3);
  });

  it('measures the bend in 3D when world landmarks are present', () => {
    const detector = tapper();
    // The image looks bent (a finger aimed at the camera) while the 3D finger is straight.
    const states = [0, 1, 1, 1].map((indexCurl, i) => {
      const time = 1100 + i * 40;
      return detector.update({ ...hand(time, { indexCurl }), worldLandmarks: hand(time).landmarks });
    });
    expect(clicks(states)).toBe(0);
  });

  it('changes nothing for the arena, where the option is off', () => {
    const arena = synched();
    const explicit = synched(new HandCursorDetector({ indexTapClick: false }));
    const bends = [0, 0.7, 1, 1, 1, 0, 1, 1];
    const states = frames(arena, bends, { dx: 0.001 });
    expect(states).toEqual(frames(explicit, bends, { dx: 0.001 }));
    expect(states.some((state) => state.pinching || state.pinchRelease)).toBe(false);
  });
});

describe('index tap from the pointing pose', () => {
  const tapper = () => synched(new HandCursorDetector({ indexTapClick: true }));
  /** One frame every 40 ms from t = 1100: [bend of middle/ring/pinky, bend of the index]. */
  const play = (detector: HandCursorDetector, bends: [number, number][], from = 1100) =>
    bends.map(([curl, indexCurl], i) => detector.update(hand(from + i * 40, { curl, indexCurl })));
  const clicks = (states: { pinchRelease: boolean }[]) => states.filter((state) => state.pinchRelease).length;
  const aim: [number, number][] = Array.from({ length: 8 }, () => [1, 0]);
  const held = (indexCurl: number, count: number): [number, number][] => Array.from({ length: count }, () => [1, indexCurl]);

  it.each([0.52, 0.7, 1])('clicks once with the index bent to %s, without going back', (depth) => {
    const detector = tapper();
    const aimed = play(detector, aim);
    expect(clicks(aimed)).toBe(0);
    const bent = play(detector, held(depth, 20), 1420);
    expect(clicks(bent)).toBe(1);
    expect(bent.every((state) => state.backProgress === 0)).toBe(true);
    expect(bent[1]).toMatchObject({ x: aimed.at(-1)!.x, y: aimed.at(-1)!.y });
    expect(clicks(play(detector, [...aim, ...held(depth, 4)], 2220))).toBe(1);
  });

  it('does not click when an open hand closes gradually, and still goes back', () => {
    const detector = tapper();
    const closing: [number, number][] = [0, 0, 0.25, 0.5, 0.75, ...Array.from({ length: 20 }, () => 1)].map((c) => [c, c]);
    const states = play(detector, closing);
    expect(clicks(states)).toBe(0);
    expect(states.at(-1)!.backProgress).toBe(1);
  });

  it('still goes back when the other fingers close just before the index', () => {
    const detector = tapper();
    const states = play(detector, [[0, 0], [0, 0], [0, 0], [1, 0], [1, 0], ...Array.from({ length: 20 }, () => [1, 1] as [number, number])]);
    expect(clicks(states)).toBe(0);
    expect(states.at(-1)!.backProgress).toBe(1);
  });
});

describe('index tap in 3D', () => {
  const tapper = () => synched(new HandCursorDetector({ indexTapClick: true }));
  const clicks = (states: { pinchRelease: boolean }[]) => states.filter((state) => state.pinchRelease).length;

  /** A straight index lowered about its base toward the camera, by `degrees`, in image and world alike. */
  function pitched(time: number, degrees: number, curl = 0): MenuHandSnapshot {
    const snapshot = hand(time, { curl, indexCurl: 0 });
    const base = snapshot.landmarks[5]!;
    const angle = (degrees * Math.PI) / 180;
    const landmarks = snapshot.landmarks.map((p, i) =>
      i < 6 || i > 8
        ? p
        : { x: p.x, y: base.y + (p.y - base.y) * Math.cos(angle), z: (p.y - base.y) * Math.sin(angle) },
    );
    return { ...snapshot, landmarks, worldLandmarks: landmarks.map((p) => ({ ...p })) };
  }

  const play = (detector: HandCursorDetector, angles: number[], curl = 0, from = 1100) =>
    angles.map((degrees, i) => detector.update(pitched(from + i * 40, degrees, curl)));

  it.each([0, 1])('clicks when a straight index drops at its base (other fingers curl %s)', (curl) => {
    const detector = tapper();
    const aimed = play(detector, [0, 0, 0, 0, 0, 0, 0, 0], curl);
    const down = play(detector, [25, 50, 50, 50, 50, 50], curl, 1420);
    expect(clicks(down)).toBe(1);
    expect(down[2]).toMatchObject({ pinching: true, x: aimed.at(-1)!.x, y: aimed.at(-1)!.y });
    expect(down.every((state) => state.backProgress === 0)).toBe(true);
    const again = play(detector, [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50], curl, 1800);
    expect(clicks(again)).toBe(1);
  });

  it('does not click twice while the finger stays down or only comes halfway back', () => {
    const detector = tapper();
    play(detector, [0, 0]);
    expect(clicks(play(detector, [50, 50, 50, 35, 35, 50, 50, 50, 50, 50, 50, 50], 0, 1180))).toBe(1);
  });

  it('accepts a new resting direction after a tap instead of staying disarmed', () => {
    const detector = tapper();
    play(detector, [0, 0]);
    play(detector, [50, 50, 50], 0, 1180);
    // The finger comes back straight but 30 degrees lower than before, and stays there.
    play(detector, Array.from({ length: 20 }, () => 30), 0, 1300);
    expect(clicks(play(detector, [75, 75, 75], 0, 2100))).toBe(1);
  });

  it('does not read a finger aimed at the camera as a fist', () => {
    // The image looks closed; in 3D the index is straight.
    const foreshortened = (time: number): MenuHandSnapshot => ({
      ...hand(time, { curl: 1 }),
      worldLandmarks: hand(time, { curl: 1, indexCurl: 0 }).landmarks,
    });
    const run = (detector: HandCursorDetector) => {
      detector.update(hand(1100));
      return Array.from({ length: 20 }, (_, i) => detector.update(foreshortened(1140 + i * 40)));
    };
    expect(run(tapper()).every((state) => state.backProgress === 0)).toBe(true);
    // The arena keeps measuring the fist on the image.
    expect(run(synched()).at(-1)!.backProgress).toBe(1);
  });

  it('gives one click when a pinch follows from lowering the index', () => {
    const detector = tapper();
    play(detector, [0, 0]);
    const states = Array.from({ length: 16 }, (_, i) => {
      const snapshot = pitched(1180 + i * 40, 50);
      // After the tap the thumb reaches the lowered fingertip and stays there.
      const tip = snapshot.landmarks[8]!;
      const landmarks = snapshot.landmarks.map((p, k) => (k === 4 && i >= 8 ? { ...tip, x: tip.x + 0.01 } : p));
      return detector.update({ ...snapshot, landmarks });
    });
    expect(clicks(states)).toBe(1);
  });
});
