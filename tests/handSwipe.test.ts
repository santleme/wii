import { describe, expect, it } from 'vitest';
import { HandCursorDetector, type HandCursorState } from '../src/kinematics/handCursor';
import { HandSwipeDetector } from '../src/kinematics/handSwipe';
import { emptyHand, hand } from './fixtures/menuHand';
import { rotationalWorldLandmarks } from './fixtures/rotationalHand';

/** Feeds x positions (mirrored image) every 33ms and returns the pulses fired. */
function feed(detector: HandSwipeDetector, startMs: number, xs: readonly number[], blocked = false) {
  return xs
    .map((x, index) => detector.update({ timestampMs: startMs + index * 33, x, y: 0.5, blocked }).direction)
    .filter((direction) => direction !== 0);
}

const rest = [0.5, 0.5, 0.5];
const leftward = [0.43, 0.36, 0.29, 0.22];
const rightward = [0.57, 0.64, 0.71, 0.78];

describe('hand swipe detector', () => {
  it('fires one wheel step per swipe, next for a leftward hand and previous for a rightward one', () => {
    expect(feed(new HandSwipeDetector(), 0, [...rest, ...leftward])).toEqual([1]);
    expect(feed(new HandSwipeDetector(), 0, [...rest, ...rightward])).toEqual([-1]);
  });

  it('ignores slow pointing movement and a single tracker jump', () => {
    const slow = Array.from({ length: 30 }, (_, index) => 0.5 + index * 0.03); // 0.9 widths/s
    expect(feed(new HandSwipeDetector(), 0, [...rest, ...slow])).toEqual([]);
    expect(feed(new HandSwipeDetector(), 0, [...rest, 0.8, 0.8, 0.8])).toEqual([]);
  });

  it('ignores a mostly vertical movement', () => {
    const detector = new HandSwipeDetector();
    const pulses = [0, 1, 2, 3, 4, 5, 6].map((index) => {
      const step = Math.max(0, index - 2);
      return detector.update({ timestampMs: index * 33, x: 0.5 + step * 0.06, y: 0.2 + step * 0.1, blocked: false })
        .direction;
    });
    expect(pulses.every((direction) => direction === 0)).toBe(true);
  });

  it('needs the hand to rest before the next swipe and honours the cooldown', () => {
    const detector = new HandSwipeDetector();
    const long = Array.from({ length: 20 }, (_, index) => 0.5 - (index + 1) * 0.07);
    expect(feed(detector, 0, [...rest, ...long])).toEqual([1]);

    const quick = new HandSwipeDetector();
    expect(feed(quick, 0, [...rest, ...leftward])).toEqual([1]);
    expect(feed(quick, 231, [0.22, 0.22, 0.15, 0.08, 0.01])).toEqual([]); // 99ms after: still cooling
    expect(feed(quick, 600, [0.5, 0.5, ...leftward])).toEqual([1]);
  });

  it('does not read the hand returning to its place as a swipe back', () => {
    const detector = new HandSwipeDetector();
    expect(feed(detector, 0, [...rest, ...leftward])).toEqual([1]);
    expect(feed(detector, 231, [0.22, 0.22, 0.29, 0.36, 0.43, 0.5])).toEqual([]);
    expect(feed(detector, 1200, [0.5, 0.5, ...rightward])).toEqual([-1]);
  });

  it('stays quiet while blocked and requires rest after the block', () => {
    const detector = new HandSwipeDetector();
    expect(feed(detector, 0, [...rest, ...leftward], true)).toEqual([]);
    expect(feed(detector, 231, [0.15, 0.08, 0.01])).toEqual([]);
  });

  it('does not bridge a long gap between samples', () => {
    const detector = new HandSwipeDetector();
    feed(detector, 0, rest);
    expect(detector.update({ timestampMs: 500, x: 0.1, y: 0.5, blocked: false })).toEqual({
      direction: 0,
      moving: false,
    });
  });
});

describe('hand cursor swipe arbitration', () => {
  type Options = Parameters<typeof hand>[1];

  /** Synchronizes at rest, then moves the raw camera anchor right (leftward on the mirrored screen). */
  function run(moving: Options, detector = new HandCursorDetector()): HandCursorState[] {
    for (let time = 0; time <= 300; time += 33) detector.update(hand(time, { tipX: 0.3 }));
    return [1, 2, 3, 4, 5].map((step) => detector.update(hand(297 + step * 33, { ...moving, tipX: 0.3 + step * 0.07 })));
  }
  const pulses = (states: readonly HandCursorState[]) => states.map((state) => state.swipeDirection).filter(Boolean);

  it('publishes a single-sample pulse for a quick sideways movement', () => {
    expect(pulses(run({}))).toEqual([1]);
  });

  it('does not click when the fingers touch during a swipe, until they part again', () => {
    const detector = new HandCursorDetector();
    for (let time = 0; time <= 300; time += 33) detector.update(hand(time, { tipX: 0.3 }));
    detector.update(hand(333, { tipX: 0.37 }));
    const touching = [366, 399, 432, 465, 498].map((time) =>
      detector.update(hand(time, { tipX: 0.37 + (time - 333) * 0.002, pinchRatio: 0.2 })),
    );
    expect(touching.every((state) => !state.pinchRelease && !state.pinching)).toBe(true);
  });

  it('is blocked by a held pinch and by a closed fist', () => {
    const detector = new HandCursorDetector();
    for (let time = 0; time <= 300; time += 33) detector.update(hand(time, { tipX: 0.3 }));
    for (let time = 333; time <= 500; time += 33) detector.update(hand(time, { tipX: 0.3, pinchRatio: 0.2 }));
    const dragged = [1, 2, 3, 4].map((step) =>
      detector.update(hand(495 + step * 33, { tipX: 0.3 + step * 0.07, pinchRatio: 0.2 })),
    );
    expect(pulses(dragged)).toEqual([]);
    expect(pulses(run({ curl: 1 }))).toEqual([]);
  });

  it('is blocked while a palm rotation is in progress', () => {
    const detector = new HandCursorDetector();
    const sample = (time: number, angle: number, tipX: number) => ({
      ...hand(time, { tipX }),
      worldLandmarks: rotationalWorldLandmarks(angle),
      rotationEnabled: true,
    });
    for (let time = 0; time <= 300; time += 33) detector.update(sample(time, 0, 0.3));
    const states = Array.from({ length: 8 }, (_, index) =>
      detector.update(sample(333 + index * 33, (index + 1) * 6, 0.3 + (index + 1) * 0.07)),
    );
    expect(states.every((state) => state.rotationPhase !== 'IDLE')).toBe(true);
    expect(pulses(states)).toEqual([]);
  });

  it('does not fire across a lost hand', () => {
    const detector = new HandCursorDetector();
    for (let time = 0; time <= 300; time += 33) detector.update(hand(time, { tipX: 0.3 }));
    detector.update(emptyHand(333));
    const reacquired = [366, 399, 432].map((time, index) => detector.update(hand(time, { tipX: 0.5 + index * 0.07 })));
    expect(pulses(reacquired)).toEqual([]);
  });
});
