import type { Delegate, PoseRecording } from '@wii/spatial-core';

/**
 * Configuration guards that make a regression comparison meaningless. The delegate is
 * deliberately absent: with the model checksum pinned, a cross-delegate comparison is a
 * controlled experiment whose numeric differences deserve a verdict, not a veto.
 */
export function incompatibleReasons(reference: PoseRecording, actual: PoseRecording): string[] {
  const reasons: string[] = [];
  const expectedSource = reference.source;
  const actualSource = actual.source;
  if (expectedSource.kind !== 'mediapipe') reasons.push('reference source is not MediaPipe');
  if (expectedSource.tasksVisionVersion !== actualSource.tasksVisionVersion) reasons.push('MediaPipe Tasks version differs');
  if (expectedSource.modelSha256 !== actualSource.modelSha256) reasons.push('pose model checksum differs');
  if (expectedSource.runningMode !== 'VIDEO') reasons.push('reference was not captured in VIDEO mode');
  if (reference.timestampClock !== actual.timestampClock) reasons.push('timestamp clock domain differs');
  if (expectedSource.runtime?.userAgent !== actualSource.runtime?.userAgent) reasons.push('browser user agent differs');
  if (expectedSource.runtime?.platform !== actualSource.runtime?.platform) reasons.push('browser platform differs');
  if (expectedSource.input?.sha256 !== actualSource.input?.sha256) reasons.push('input video checksum differs');
  if (expectedSource.input?.width !== actualSource.input?.width || expectedSource.input?.height !== actualSource.input?.height) {
    reasons.push('input video dimensions differ');
  }
  if (reference.frameCount !== actual.frameCount) reasons.push('sampled frame count differs');
  if (reference.frames.some((frame, index) => frame.snapshot.timestampMs !== actual.frames[index]?.snapshot.timestampMs)) {
    reasons.push('sampled frame timestamps differ');
  }
  return reasons;
}

/** What a reader needs to judge a verdict across delegates, including a GPU run that fell back to CPU. */
export function delegateContext(requested: Delegate, actual: PoseRecording, reference: PoseRecording) {
  return { requested, sampled: actual.source.delegate, reference: reference.source.delegate };
}
