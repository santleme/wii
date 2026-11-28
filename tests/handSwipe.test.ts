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
const leftward = [0.4, 0.3, 0.2, 0.1];
const rightward = [0.6, 0.7, 0.8, 0.9];

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

  it('ignores an unhurried cursor reach, with its bell-shaped speed profile', () => {
    const reach = Array.from({ length: 14 }, (_, index) => {
      const t = Math.min(1, ((index + 1) * 33) / 400);
      return 0.5 + 0.25 * (10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5);
    });
    expect(feed(new HandSwipeDetector(), 0, [...rest, ...reach])).toEqual([]);
  });

  it('reads the swipe speed reached at playing distance, but not a diagonal pointer move', () => {
    const modest = [0.44, 0.38, 0.32, 0.26]; // 1.8 widths/s
    expect(feed(new HandSwipeDetector(), 0, [...rest, ...modest])).toEqual([1]);

    const detector = new HandSwipeDetector();
    const diagonal = [0, 1, 2, 3, 4, 5, 6].map((index) => {
      const step = Math.max(0, index - 2);
      return detector.update({ timestampMs: index * 33, x: 0.5 + step * 0.07, y: 0.2 + step * 0.065, blocked: false })
        .direction;
    });
    expect(diagonal.every((direction) => direction === 0)).toBe(true);
  });

  it('allows a correction in the opposite direction after 450ms', () => {
    const detector = new HandSwipeDetector();
    expect(feed(detector, 0, [...rest, ...leftward])).toEqual([1]);
    expect(feed(detector, 560, [0.1, 0.1, 0.2, 0.3, 0.4])).toEqual([-1]);
  });

  it('still reads a swipe from a slow 10fps camera', () => {
    const detector = new HandSwipeDetector();
    const pulses = [0.8, 0.8, 0.5, 0.2].map(
      (x, index) => detector.update({ timestampMs: index * 200, x, y: 0.5, blocked: false }).direction,
    );
    expect(pulses.every((direction) => direction === 0)).toBe(true); // 1.5 widths/s: pointing
    const fast = new HandSwipeDetector();
    const swiped = [0.8, 0.8, 0.5, 0.2].map(
      (x, index) => fast.update({ timestampMs: index * 100, x, y: 0.5, blocked: false }).direction,
    );
    expect(swiped).toEqual([0, 0, 0, 1]);
  });

  it('ignores a mostly vertical movement', () => {
    const detector = new HandSwipeDetector();
    const pulses = [0, 1, 2, 3, 4, 5, 6].map((index) => {
      const step = Math.max(0, index - 2);
      return detector.update({ timestampMs: index * 33, x: 0.5 + step * 0.09, y: 0.2 + step * 0.13, blocked: false })
        .direction;
    });
    expect(pulses.every((direction) => direction === 0)).toBe(true);
  });

  it('needs the hand to rest before the next swipe and honours the cooldown', () => {
    const detector = new HandSwipeDetector();
    const long = Array.from({ length: 20 }, (_, index) => 0.5 - (index + 1) * 0.1);
    expect(feed(detector, 0, [...rest, ...long])).toEqual([1]);

    const quick = new HandSwipeDetector();
    expect(feed(quick, 0, [...rest, ...leftward])).toEqual([1]);
    expect(feed(quick, 231, [0.1, 0.1, 0, -0.1, -0.2])).toEqual([]); // 99ms after: still cooling
    expect(feed(quick, 600, [0.5, 0.5, ...leftward])).toEqual([1]);
  });

  it('does not read the hand returning to its place as a swipe back', () => {
    const detector = new HandSwipeDetector();
    expect(feed(detector, 0, [...rest, ...leftward])).toEqual([1]);
    expect(feed(detector, 231, [0.1, 0.1, 0.2, 0.3, 0.4, 0.5])).toEqual([]);
    expect(feed(detector, 1200, [0.5, 0.5, ...rightward])).toEqual([-1]);
  });

  it('stays quiet while blocked and requires rest after the block', () => {
    const detector = new HandSwipeDetector();
    expect(feed(detector, 0, [...rest, ...leftward], true)).toEqual([]);
    expect(feed(detector, 231, [0, -0.1, -0.2])).toEqual([]);
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
    return [1, 2, 3, 4, 5].map((step) => detector.update(hand(297 + step * 33, { ...moving, tipX: 0.3 + step * 0.1 })));
  }
  const pulses = (states: readonly HandCursorState[]) => states.map((state) => state.swipeDirection).filter(Boolean);

  it('publishes a single-sample pulse for a quick sideways movement', () => {
    expect(pulses(run({}))).toEqual([1]);
  });

  it('does not click when the fingers touch during a swipe, until they part again', () => {
    const detector = new HandCursorDetector();
    for (let time = 0; time <= 300; time += 33) detector.update(hand(time, { tipX: 0.3 }));
    detector.update(hand(333, { tipX: 0.4 }));
    const touching = [366, 399, 432, 465, 498].map((time) =>
      detector.update(hand(time, { tipX: 0.4 + (time - 333) * 0.002, pinchRatio: 0.2 })),
    );
    expect(touching.every((state) => !state.pinchRelease && !state.pinching)).toBe(true);

    for (const time of [531, 564, 597]) detector.update(hand(time, { tipX: 0.73, pinchRatio: 0.8 }));
    const clicks = [630, 663, 696, 729].map((time) => detector.update(hand(time, { tipX: 0.73, pinchRatio: 0.2 })));
    expect(clicks.some((state) => state.pinchRelease)).toBe(true);
  });

  it('is blocked by a held pinch and by a closed fist', () => {
    const detector = new HandCursorDetector();
    for (let time = 0; time <= 300; time += 33) detector.update(hand(time, { tipX: 0.3 }));
    for (let time = 333; time <= 500; time += 33) detector.update(hand(time, { tipX: 0.3, pinchRatio: 0.2 }));
    const dragged = [1, 2, 3, 4].map((step) =>
      detector.update(hand(495 + step * 33, { tipX: 0.3 + step * 0.1, pinchRatio: 0.2 })),
    );
    expect(pulses(dragged)).toEqual([]);
    expect(pulses(run({ curl: 1 }))).toEqual([]);
  });

  const turning = (time: number, angle: number, tipX: number) => ({
    ...hand(time, { tipX }),
    worldLandmarks: rotationalWorldLandmarks(angle),
    rotationEnabled: true,
  });
  const synchronized = () => {
    const detector = new HandCursorDetector();
    for (let time = 0; time <= 300; time += 33) detector.update(turning(time, 0, 0.3));
    return detector;
  };

  it('is blocked while a palm rotation is committed', () => {
    const detector = synchronized();
    for (let index = 1; index <= 8; index += 1) detector.update(turning(297 + index * 33, index * 6, 0.3));
    const states = [1, 2, 3, 4].map((step) =>
      detector.update(turning(561 + step * 33, (8 + step) * 6, 0.3 + step * 0.1)),
    );
    expect(states.every((state) => state.rotationPhase === 'ROTATING')).toBe(true);
    expect(pulses(states)).toEqual([]);
  });

  it('still swipes while the rotation is only a candidate', () => {
    const detector = synchronized();
    const states = [1, 2, 3].map((step) => detector.update(turning(297 + step * 33, step * 3, 0.3 + step * 0.1)));
    expect(states.some((state) => state.rotationPhase === 'ROTATION_CANDIDATE')).toBe(true);
    expect(states.some((state) => state.rotationPhase === 'ROTATING')).toBe(false);
    expect(pulses(states)).toEqual([1]);
  });

  it('does not fire across a lost hand', () => {
    const detector = new HandCursorDetector();
    for (let time = 0; time <= 300; time += 33) detector.update(hand(time, { tipX: 0.3 }));
    detector.update(emptyHand(333));
    const reacquired = [366, 399, 432].map((time, index) => detector.update(hand(time, { tipX: 0.5 + index * 0.1 })));
    expect(pulses(reacquired)).toEqual([]);
  });
});
