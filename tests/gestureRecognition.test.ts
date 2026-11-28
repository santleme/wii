import { describe, expect, it } from 'vitest';
import {
  DtwGestureRecognizer,
  GestureRecorder,
  HandFeatureExtractor,
  bandedDtwDistance,
  handGestureVector,
} from '@wii/spatial-core';
import { handSnapshot } from './fixtures/syntheticHand';
import { syntheticGestureSequence } from './fixtures/gestureSequences';

function featureFrames(optionsAt: (index: number) => Parameters<typeof handSnapshot>[1], count = 20): number[][] {
  const extractor = new HandFeatureExtractor();
  return Array.from({ length: count }, (_, index) => {
    const features = extractor.extract(handSnapshot(index * 33, optionsAt(index)))[0]!;
    return handGestureVector(features);
  });
}

function rampSequence(values: readonly number[]): number[][] {
  return values.map((value) => [value]);
}

describe('banded DTW gesture recognition', () => {
  it('aligns time-warped sequences inside a Sakoe-Chiba band and rejects paths outside it', () => {
    const template = rampSequence([0, 0, 1, 2, 3, 3]);
    const warped = rampSequence([0, 0, 0, 1, 2, 3, 3]);
    const different = rampSequence([3, 3, 2, 1, 0, 0]);

    expect(bandedDtwDistance(template, warped, 2)).toBeCloseTo(0, 8);
    expect(bandedDtwDistance(template, different, 1)).toBeGreaterThan(0.5);
    expect(bandedDtwDistance(template, warped, 0)).toBeUndefined();
  });

  it('records a null class and only accepts a gesture that beats null and competing classes', () => {
    const action = featureFrames((index) => ({
      screenX: 0.45 + Math.sin((Math.PI * index) / 19) * 0.08,
      pinchRatio: index > 7 && index < 14 ? 0.2 : 0.8,
    }));
    const nullMotion = featureFrames((index) => ({ screenX: 0.5 + (index % 2) * 0.002 }));
    const recognizer = new DtwGestureRecognizer({ maxDistance: 0.2, nullSeparationRatio: 0.85 });
    recognizer.addExample('squeeze-swipe', action);
    expect(recognizer.recognize(action)).toBeUndefined();
    recognizer.addNullExample(nullMotion);

    expect(recognizer.recognize(action)?.label).toBe('squeeze-swipe');
    expect(recognizer.recognize(nullMotion)).toBeUndefined();
    expect(recognizer.exampleCount('__null__')).toBe(1);
  });

  it('measures recognition and rejection across speed, jitter, rest, random motion, and near-misses', () => {
    const recognizer = new DtwGestureRecognizer();
    for (const seed of [1, 2, 3]) {
      recognizer.addExample(
        'pinch-right',
        syntheticGestureSequence('pinch-right', { seed, noise: 0.001, frameIntervalMs: 33 }),
      );
      recognizer.addExample(
        'pinch-left',
        syntheticGestureSequence('pinch-left', { seed: seed + 10, noise: 0.001, frameIntervalMs: 33 }),
      );
    }
    for (const [kind, seed] of [
      ['rest', 31],
      ['rest', 32],
      ['random', 41],
      ['open-right', 51],
    ] as const) {
      recognizer.addNullExample(
        syntheticGestureSequence(kind, { seed, noise: 0.004, frameIntervalMs: 33 }),
      );
    }

    const positiveScenarios = [
      {
        scenario: 'right-fast-with-jitter',
        label: 'pinch-right',
        sequence: syntheticGestureSequence('pinch-right', {
          seed: 61,
          noise: 0.003,
          frameIntervalMs: 18,
        }),
      },
      {
        scenario: 'right-slower-with-jitter',
        label: 'pinch-right',
        sequence: syntheticGestureSequence('pinch-right', {
          seed: 62,
          noise: 0.003,
          frameCount: 20,
          frameIntervalMs: 40,
        }),
      },
      {
        scenario: 'left-different-frame-count',
        label: 'pinch-left',
        sequence: syntheticGestureSequence('pinch-left', {
          seed: 63,
          noise: 0.003,
          frameCount: 18,
          frameIntervalMs: 40,
        }),
      },
    ];
    const negativeScenarios = [
      { scenario: 'rest-with-jitter', sequence: syntheticGestureSequence('rest', { seed: 71, noise: 0.004 }) },
      { scenario: 'random-motion', sequence: syntheticGestureSequence('random', { seed: 72, noise: 0.002 }) },
      { scenario: 'open-hand-swipe', sequence: syntheticGestureSequence('open-right', { seed: 73, noise: 0.002 }) },
      { scenario: 'pinch-at-wrong-phase', sequence: syntheticGestureSequence('near-miss', { seed: 74, noise: 0.002 }) },
    ];

    const report = {
      positives: positiveScenarios.map(({ scenario, label, sequence }) => ({
        scenario,
        expected: label,
        predicted: recognizer.recognize(sequence)?.label ?? null,
      })),
      negatives: negativeScenarios.map(({ scenario, sequence }) => ({
        scenario,
        predicted: recognizer.recognize(sequence)?.label ?? null,
      })),
    };
    const summary = {
      correctPositiveAcceptances: report.positives.filter(({ expected, predicted }) => expected === predicted).length,
      positiveCount: report.positives.length,
      falsePositives: report.negatives.filter(({ predicted }) => predicted !== null).length,
      negativeRejections: report.negatives.filter(({ predicted }) => predicted === null).length,
      negativeCount: report.negatives.length,
    };

    expect({ report, summary }).toEqual({
      report: {
        positives: [
          { scenario: 'right-fast-with-jitter', expected: 'pinch-right', predicted: 'pinch-right' },
          { scenario: 'right-slower-with-jitter', expected: 'pinch-right', predicted: 'pinch-right' },
          { scenario: 'left-different-frame-count', expected: 'pinch-left', predicted: 'pinch-left' },
        ],
        negatives: [
          { scenario: 'rest-with-jitter', predicted: null },
          { scenario: 'random-motion', predicted: null },
          { scenario: 'open-hand-swipe', predicted: null },
          { scenario: 'pinch-at-wrong-phase', predicted: null },
        ],
      },
      summary: {
        correctPositiveAcceptances: 3,
        positiveCount: 3,
        falsePositives: 0,
        negativeRejections: 4,
        negativeCount: 4,
      },
    });
  });

  it('rejects an indistinguishable query when trained classes have no separation margin', () => {
    const recognizer = new DtwGestureRecognizer({ targetFrames: 4, bandWidth: 1, maxDistance: 1 });
    const query = rampSequence([0, 0, 0, 0]);
    recognizer.addExample('gesture-a', query);
    recognizer.addExample('gesture-b', query);
    recognizer.addNullExample(rampSequence([1, 1, 1, 1]));

    expect(recognizer.measure(query)?.get('gesture-a')).toBe(0);
    expect(recognizer.measure(query)?.get('gesture-b')).toBe(0);
    expect(recognizer.recognize(query)).toBeUndefined();
  });

  it('bounds gesture recordings, clones recorded frames, and survives inconsistent feature dimensions', () => {
    const recorder = new GestureRecorder({ minFrames: 2, maxFrames: 3 });
    recorder.start();
    const first = [1, 2];
    recorder.addFrame(first);
    first[0] = 9;
    recorder.addFrame([2, 3]);
    expect(recorder.addFrame([3, 4])).toBe(true);
    expect(recorder.addFrame([4, 5])).toBe(false);
    expect(recorder.finish()).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(recorder.isRecording).toBe(false);

    recorder.start();
    recorder.addFrame([1]);
    expect(() => recorder.addFrame([1, 2])).toThrow(/dimension changed/);
    // The error is recoverable: the recording and the frames already in it survive.
    expect(recorder.isRecording).toBe(true);
    expect(recorder.frameCount).toBe(1);
    recorder.addFrame([2]);
    expect(recorder.finish()).toEqual([[1], [2]]);
  });
});
