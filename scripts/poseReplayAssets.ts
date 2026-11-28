import type { Delegate } from '@wii/spatial-core';
import { POSE_FULL_MODEL_SHA8, POSE_MODEL_SHA8 } from '../src/cv/mediapipeAssets';

export type PoseReplayModelChoice = 'live' | 'lite' | 'full';

export function poseReplayModelFiles(delegate: Delegate, choice: PoseReplayModelChoice = 'live'): { modelFile: string; cpuModelFile: string } {
  const lite = `pose_landmarker_lite.${POSE_MODEL_SHA8}.task`;
  const full = `pose_landmarker_full.${POSE_FULL_MODEL_SHA8}.task`;
  if (choice === 'lite') return { modelFile: lite, cpuModelFile: lite };
  if (choice === 'full') return { modelFile: full, cpuModelFile: full };
  return {
    modelFile: delegate === 'GPU' ? full : lite,
    cpuModelFile: lite,
  };
}
