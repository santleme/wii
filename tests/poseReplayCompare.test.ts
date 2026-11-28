import { describe, expect, it } from 'vitest';
import { createPoseRecording } from '@wii/spatial-core';
import type { Delegate, PoseRecording, PoseSnapshot } from '@wii/spatial-core';
import { delegateContext, incompatibleReasons } from '../scripts/poseReplayCompare';

const MODEL_SHA = 'a'.repeat(64);
const OTHER_MODEL_SHA = 'b'.repeat(64);

const snapshot = (timestampMs: number): PoseSnapshot => ({
  timestampMs,
  landmarks: [],
  worldLandmarks: [],
  trackingState: 'lost',
  bodyConfidence: 0,
  frameWidth: 640,
  frameHeight: 360,
});

function recording(delegate: Delegate, modelSha256 = MODEL_SHA): PoseRecording {
  return createPoseRecording([snapshot(0), snapshot(33)], {
    kind: 'mediapipe',
    tasksVisionVersion: '0.10.0',
    modelSha256,
    delegate,
    runningMode: 'VIDEO',
    runtime: { userAgent: 'agent', platform: 'platform' },
    input: { width: 640, height: 360, rotationDegrees: 0, mirrored: false, sha256: 'c'.repeat(64) },
  }, 'media-time');
}

describe('pose replay compatibility', () => {
  it('allows a verdict for same-model cross-delegate comparisons', () => {
    expect(incompatibleReasons(recording('GPU'), recording('CPU'))).toEqual([]);
  });

  it('still blocks comparisons across different model checksums', () => {
    expect(incompatibleReasons(recording('GPU', MODEL_SHA), recording('GPU', OTHER_MODEL_SHA))).toEqual(['pose model checksum differs']);
  });

  it('accepts identical configurations', () => {
    expect(incompatibleReasons(recording('CPU'), recording('CPU'))).toEqual([]);
  });
});

describe('pose replay report', () => {
  it('names the requested, sampled and reference delegates after a GPU run fell back to CPU', () => {
    expect(delegateContext('GPU', recording('CPU'), recording('GPU'))).toEqual({ requested: 'GPU', sampled: 'CPU', reference: 'GPU' });
  });
});
