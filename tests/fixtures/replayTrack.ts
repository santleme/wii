import { AdaptiveCalibrator } from '../../src/cv/adaptiveCalibrator';
import type { CalibrationProfile, PoseSnapshot } from '../../src/cv/protocol';
import { segmentAt, TRACK_RECORDING_SCRIPT, type SegmentKind } from '../../src/cv/diagnostics/recordingScript';
import { ActionPipeline } from '../../src/kinematics/actionPipeline';

export interface SegmentScore {
  kind: SegmentKind;
  frames: number;
  steps: number;
  jumps: number;
  /** Share of frames with the runner moving. */
  moving01: number;
  /** Seconds into the segment until the first moving frame / the first still frame. */
  firstMovingS?: number;
  firstStillS?: number;
  /** Share of the segment's last 1.5 s in the lane it asks for (reading and walking take ~2 s). */
  lane01?: number;
}

const LANE: Partial<Record<SegmentKind, -1 | 0 | 1>> = { left: -1, center: 0, right: 1 };

/** Replays frames in the same order as App.onPose and scores each scripted segment. */
/** The comparison table: share of frames (%) with the runner moving where it should and should not. */
export function summarize(frames: readonly PoseSnapshot[]) {
  const pipeline = new ActionPipeline();
  const calibrator = new AdaptiveCalibrator();
  let profile: CalibrationProfile | undefined;
  const first = frames[0]?.timestampMs ?? 0;
  const rows = frames.flatMap((snapshot) => {
    profile = calibrator.update(snapshot, pipeline.laneZone) ?? profile;
    const { controls, rawEffort } = pipeline.update(snapshot, profile);
    const current = segmentAt(snapshot.timestampMs - first);
    return current ? [{ kind: current.segment.kind, intoS: current.segment.seconds - current.remainingMs / 1000, moving: controls.sprintSpeed01 > 0, effort: rawEffort }] : [];
  });
  const share = (kinds: SegmentKind[], fromS = 0) => {
    const chosen = rows.filter((row) => kinds.includes(row.kind) && row.intoS >= fromS);
    return chosen.length ? Math.round((100 * chosen.filter((row) => row.moving).length) / chosen.length) : -1;
  };
  const meanEffort = (kinds: SegmentKind[], fromS = 0) => {
    const chosen = rows.filter((row) => kinds.includes(row.kind) && row.intoS >= fromS);
    return chosen.length ? chosen.reduce((sum, row) => sum + row.effort, 0) / chosen.length : -1;
  };
  return {
    still: share(['still']),
    arms: share(['arms']),
    // The race input: mean raw effort per segment. Arms without a bounce must read zero.
    armsEffort: meanEffort(['arms']),
    runEffort: meanEffort(['run'], 6),
    // After 6 s the player is surely running; 1.5 s after "stop" they are surely meant to be stopped.
    run: share(['run'], 6),
    stop: share(['stop'], 1.5),
    jumps: share(['jump']),
    side: Math.max(share(['left']), share(['right']), share(['center'])),
    // Only recordings made after these segments were added have them; -1 otherwise.
    walk: share(['walk'], 2),
    runJump: share(['runjump'], 3),
  };
}

export function replayTrack(frames: readonly PoseSnapshot[]): SegmentScore[] {
  const pipeline = new ActionPipeline();
  const calibrator = new AdaptiveCalibrator();
  let profile: CalibrationProfile | undefined;
  const scores = TRACK_RECORDING_SCRIPT.map(({ kind }) => ({ kind, frames: 0, steps: 0, jumps: 0, moving: 0, laneFrames: 0, laneHits: 0 } as {
    kind: SegmentKind; frames: number; steps: number; jumps: number; moving: number; laneFrames: number; laneHits: number; firstMovingS?: number; firstStillS?: number;
  }));
  const first = frames[0]?.timestampMs ?? 0;
  for (const snapshot of frames) {
    profile = calibrator.update(snapshot, pipeline.laneZone) ?? profile;
    const { events, controls } = pipeline.update(snapshot, profile);
    const current = segmentAt(snapshot.timestampMs - first);
    if (!current) break;
    const score = scores[current.index]!;
    const intoMs = current.segment.seconds * 1000 - current.remainingMs;
    score.frames += 1;
    score.steps += events.filter((event) => event.type === 'step').length;
    score.jumps += events.filter((event) => event.type === 'jump').length;
    if (controls.sprintSpeed01 > 0) {
      score.moving += 1;
      score.firstMovingS ??= intoMs / 1000;
    } else score.firstStillS ??= intoMs / 1000;
    const wanted = LANE[score.kind];
    if (wanted !== undefined && current.remainingMs <= 1500) {
      score.laneFrames += 1;
      if (controls.laneZone === wanted) score.laneHits += 1;
    }
  }
  return scores.map(({ moving, laneFrames, laneHits, ...score }) => ({
    ...score,
    moving01: score.frames ? moving / score.frames : 0,
    ...(laneFrames ? { lane01: laneHits / laneFrames } : {}),
  }));
}
