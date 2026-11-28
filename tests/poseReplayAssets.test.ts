import { describe, expect, it } from 'vitest';
import { POSE_FULL_MODEL_SHA8, POSE_MODEL_SHA8 } from '../src/cv/mediapipeAssets';
import { poseReplayModelFiles } from '../scripts/poseReplayAssets';

describe('pose replay model files', () => {
  it('uses the live GPU full model with the live lite CPU fallback', () => {
    expect(poseReplayModelFiles('GPU')).toEqual({
      modelFile: `pose_landmarker_full.${POSE_FULL_MODEL_SHA8}.task`,
      cpuModelFile: `pose_landmarker_lite.${POSE_MODEL_SHA8}.task`,
    });
  });

  it('uses the lite model for a CPU replay', () => {
    expect(poseReplayModelFiles('CPU')).toEqual({
      modelFile: `pose_landmarker_lite.${POSE_MODEL_SHA8}.task`,
      cpuModelFile: `pose_landmarker_lite.${POSE_MODEL_SHA8}.task`,
    });
  });

  it('can hold lite constant across delegates for controlled comparisons', () => {
    expect(poseReplayModelFiles('GPU', 'lite')).toEqual({
      modelFile: `pose_landmarker_lite.${POSE_MODEL_SHA8}.task`,
      cpuModelFile: `pose_landmarker_lite.${POSE_MODEL_SHA8}.task`,
    });
    expect(poseReplayModelFiles('CPU', 'lite')).toEqual(poseReplayModelFiles('GPU', 'lite'));
  });

  it('can hold full constant across delegates for controlled comparisons', () => {
    expect(poseReplayModelFiles('GPU', 'full')).toEqual({
      modelFile: `pose_landmarker_full.${POSE_FULL_MODEL_SHA8}.task`,
      cpuModelFile: `pose_landmarker_full.${POSE_FULL_MODEL_SHA8}.task`,
    });
    expect(poseReplayModelFiles('CPU', 'full')).toEqual(poseReplayModelFiles('GPU', 'full'));
  });
});
