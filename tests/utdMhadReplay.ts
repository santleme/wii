import { parsePoseRecording } from '@wii/spatial-core';
import { AdaptiveCalibrator } from '../src/cv/adaptiveCalibrator';
import type { CalibrationProfile, PoseSnapshot, SportActionEvent } from '../src/cv/protocol';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import type { PunchDiagnostics } from '../src/kinematics/punchDetector';

export interface ClipResult {
  clip: string;
  frames: number;
  trackedShare: number;
  scaleReadyShare: number;
  starts: number;
  confirmed: SportActionEvent[];
  interiorConfirmed: SportActionEvent[];
  diagnostics: Record<string, PunchDiagnostics>;
}

/** Replays one pose recording through the pipeline exactly like the browser evaluation harness. */
export function replayClip(frames: readonly PoseSnapshot[]): Omit<ClipResult, 'clip'> {
  const pipeline = new ActionPipeline();
  const calibrator = new AdaptiveCalibrator();
  let profile: CalibrationProfile | undefined;
  const events: SportActionEvent[] = [];
  let tracked = 0;
  let scaleReady = 0;
  for (const snapshot of frames) {
    profile = calibrator.update(snapshot, pipeline.dodgeZone, 0.05) ?? profile;
    const output = pipeline.update(snapshot, profile);
    if (output.controls.trackingState === 'tracked') tracked += 1;
    if (output.swingTracking.scaleReady) scaleReady += 1;
    events.push(...output.events);
  }
  const confirmed = events.filter((event) => event.type === 'punch');
  const first = frames[0]?.timestampMs ?? 0;
  const last = frames.at(-1)?.timestampMs ?? 0;
  const interior = confirmed.filter((event) => event.timestampMs >= first + 500 && event.timestampMs <= last - 250);
  return {
    frames: frames.length,
    trackedShare: frames.length ? tracked / frames.length : 0,
    scaleReadyShare: frames.length ? scaleReady / frames.length : 0,
    starts: events.filter((event) => event.type === 'punch-start').length,
    confirmed,
    interiorConfirmed: interior,
    diagnostics: pipeline.punchDiagnostics as Record<string, PunchDiagnostics>,
  };
}

/** Loads one gitignored UTD recording into replayable frames. */
export function loadUtdFrames(raw: string): PoseSnapshot[] {
  return parsePoseRecording(JSON.parse(raw)).frames.map((frame) => frame.snapshot);
}
