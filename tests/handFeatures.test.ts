import { describe, expect, it } from 'vitest';
import { HandFeatureExtractor, MockReplayProvider, PinchClutch, pinchDistanceRatio } from '@wii/spatial-core';
import type { HandObservation } from '@wii/spatial-core';
import { handSnapshot, syntheticHand } from './fixtures/syntheticHand';

describe('hand feature canonicalization', () => {
  it('removes translation, global scale, and in-plane camera rotation from pose features', () => {
    const base = new HandFeatureExtractor().extract(handSnapshot(100))[0]!;
    const transformed = new HandFeatureExtractor().extract(
      handSnapshot(100, {
        scale: 3.4,
        rotationRad: 1.17,
        translate: [4, -2, 7],
      }),
    )[0]!;

    transformed.landmarks.forEach((point, index) => {
      expect(point.x).toBeCloseTo(base.landmarks[index]!.x, 9);
      expect(point.y).toBeCloseTo(base.landmarks[index]!.y, 9);
      expect(point.z).toBeCloseTo(base.landmarks[index]!.z, 9);
    });
    expect(transformed.jointCosines).toHaveLength(15);
    transformed.jointCosines.forEach((cosine, index) => {
      expect(cosine).toBeCloseTo(base.jointCosines[index]!, 9);
    });
  });

  it('derives local landmark and screen-space wrist velocities, then resets across a tracking gap', () => {
    const extractor = new HandFeatureExtractor({ maxVelocityGapMs: 250 });
    const first = extractor.extract(handSnapshot(0))[0]!;
    const moving = extractor.extract(handSnapshot(100, { screenX: 0.56 }))[0]!;

    expect(first.landmarkVelocities.every((velocity) => velocity.x === 0 && velocity.y === 0 && velocity.z === 0)).toBe(
      true,
    );
    expect(moving.imageVelocity.x).toBeGreaterThan(0);
    expect(
      moving.landmarkVelocities.every((velocity) => velocity.x === 0 && velocity.y === 0 && velocity.z === 0),
    ).toBe(true);

    const afterGap = extractor.extract(handSnapshot(1000, { screenX: 0.7 }))[0]!;
    expect(afterGap.imageVelocity).toEqual({ x: 0, y: 0 });
    expect(
      afterGap.landmarkVelocities.every((velocity) => velocity.x === 0 && velocity.y === 0 && velocity.z === 0),
    ).toBe(true);
    expect(extractor.extract({ timestampMs: 1033, hands: [] })).toEqual([]);
  });

  it('rejects malformed world landmarks instead of emitting partial feature vectors', () => {
    const malformed = syntheticHand();
    malformed.worldLandmarks = malformed.worldLandmarks.slice(0, 20);
    expect(new HandFeatureExtractor().extract({ timestampMs: 0, hands: [malformed] })).toEqual([]);
  });

  it('requires a monotonic frame timeline and resets cleanly for a new replay', () => {
    const extractor = new HandFeatureExtractor();
    extractor.extract(handSnapshot(100));
    expect(() => extractor.extract(handSnapshot(100))).toThrow(/strictly increasing/);
    extractor.reset();
    expect(extractor.extract(handSnapshot(0))).toHaveLength(1);
  });

  it('keeps velocity attached to confident handedness when two-hand order changes', () => {
    const extractor = new HandFeatureExtractor();
    extractor.extract({
      timestampMs: 0,
      hands: [
        syntheticHand({ handedness: 'left', screenX: 0.3 }),
        syntheticHand({ handedness: 'right', screenX: 0.7 }),
      ],
    });

    const reordered = extractor.extract({
      timestampMs: 100,
      hands: [
        syntheticHand({ handedness: 'right', screenX: 0.68 }),
        syntheticHand({ handedness: 'left', screenX: 0.32 }),
      ],
    });

    expect(reordered.find(({ handedness }) => handedness === 'left')?.imageVelocity.x).toBeGreaterThan(0);
    expect(reordered.find(({ handedness }) => handedness === 'right')?.imageVelocity.x).toBeLessThan(0);
  });

  it('zeros motion across ambiguous multi-hand identity and restarts after labels recover', () => {
    const extractor = new HandFeatureExtractor();
    extractor.extract({
      timestampMs: 0,
      hands: [
        syntheticHand({ handedness: 'left', screenX: 0.3 }),
        syntheticHand({ handedness: 'right', screenX: 0.7 }),
      ],
    });

    const ambiguousHands: HandObservation[] = [
      { ...syntheticHand({ handedness: 'left', screenX: 0.7 }), handedness: 'right', handednessScore: 0.2 },
      { ...syntheticHand({ handedness: 'right', screenX: 0.3 }), handedness: 'left', handednessScore: 0.2 },
    ];
    const ambiguous = extractor.extract({ timestampMs: 100, hands: ambiguousHands });
    expect(ambiguous.every(({ imageVelocity, landmarkVelocities }) =>
      imageVelocity.x === 0 && imageVelocity.y === 0 &&
      landmarkVelocities.every(({ x, y, z }) => x === 0 && y === 0 && z === 0),
    )).toBe(true);

    const recovered = extractor.extract({
      timestampMs: 200,
      hands: [
        syntheticHand({ handedness: 'left', screenX: 0.34 }),
        syntheticHand({ handedness: 'right', screenX: 0.66 }),
      ],
    });
    expect(recovered.every(({ imageVelocity }) => imageVelocity.x === 0 && imageVelocity.y === 0)).toBe(true);
  });
});

describe('pinch clutch', () => {
  it('uses palm-normalized distance and separate close and release thresholds', () => {
    const ratio = pinchDistanceRatio(syntheticHand({ pinchRatio: 0.2 }).worldLandmarks);
    const scaledRatio = pinchDistanceRatio(syntheticHand({ scale: 4, pinchRatio: 0.2 }).worldLandmarks);
    expect(ratio).toBeCloseTo(0.2, 9);
    expect(scaledRatio).toBeCloseTo(ratio!, 9);

    const clutch = new PinchClutch();
    expect(clutch.update(0.28)).toBe(true);
    expect(clutch.update(0.35)).toBe(true);
    expect(clutch.update(0.4)).toBe(false);
    expect(clutch.update(0.3)).toBe(false);
    expect(clutch.update(undefined)).toBe(false);
  });
});

describe('mock replay provider', () => {
  it('replays cloned snapshots deterministically and can reset', () => {
    const source = [handSnapshot(0), handSnapshot(33, { screenX: 0.6 })];
    const replay = new MockReplayProvider(source);
    source[0]!.hands[0]!.worldLandmarks[0]!.x = 99;

    const first = replay.next()!;
    first.hands[0]!.worldLandmarks[0]!.x = -99;
    expect(replay.next()?.timestampMs).toBe(33);
    expect(replay.isComplete).toBe(true);
    expect(replay.next()).toBeUndefined();

    replay.reset();
    expect(replay.next()?.hands[0]?.worldLandmarks[0]?.x).toBe(0);
  });

  it('does not advance the cursor past the end, like PoseReplayProvider', () => {
    const replay = new MockReplayProvider([handSnapshot(0), handSnapshot(33)]);
    replay.next();
    replay.next();
    expect(replay.frameIndex).toBe(2);
    expect(replay.next()).toBeUndefined();
    expect(replay.next()).toBeUndefined();
    expect(replay.frameIndex).toBe(2);
    expect(replay.isComplete).toBe(true);
  });

  it('requires a strictly increasing replay timeline', () => {
    expect(() => new MockReplayProvider([handSnapshot(10), handSnapshot(10)])).toThrow(/strictly increasing/);
  });
});
