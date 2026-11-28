import { createPoseRecording, serializePoseRecording } from '@wii/spatial-core';
import type { Delegate, PoseSnapshot } from '../protocol';
import { MEDIAPIPE_WASM_VERSION, POSE_FULL_MODEL_SHA8, POSE_MODEL_SHA8 } from '../mediapipeAssets';
import { segmentAt, TRACK_RECORDING_SCRIPT } from './recordingScript';
import type { Photo } from './photoTrail';

const CLIP_MS = 20_000;

/** Capture-to-game delay of each snapshot, saved with the recording so latency can be read from it. */
const delays = new WeakMap<PoseSnapshot, number>();

export function noteArrival(snapshot: PoseSnapshot, nowMs: number): void {
  delays.set(snapshot, Math.round(nowMs - snapshot.timestampMs));
}

/** Always remembers the last seconds, so a mistake can be saved after it happens. */
export function rememberFrame(recent: PoseSnapshot[], snapshot: PoseSnapshot): PoseSnapshot[] {
  recent.push(snapshot);
  while (snapshot.timestampMs - recent[0]!.timestampMs > CLIP_MS) recent.shift();
  return recent;
}

/** Keeps the raw snapshots exactly as the game receives them. Body points only, never video. */
export class PoseRecorder {
  private readonly frames: PoseSnapshot[];

  constructor(frames: readonly PoseSnapshot[] = [], private readonly script = TRACK_RECORDING_SCRIPT) { this.frames = [...frames]; }

  /** Stores the frame and returns what the player should be doing now; undefined ends the script. */
  push(snapshot: PoseSnapshot): ReturnType<typeof segmentAt> {
    const first = this.frames[0]?.timestampMs ?? snapshot.timestampMs;
    const current = segmentAt(snapshot.timestampMs - first, this.script);
    if (current) this.frames.push(snapshot);
    return current;
  }

  get frameCount(): number { return this.frames.length; }

  serialize(delegate: Delegate, modelSha256: string, photos: readonly Photo[] = []): string {
    const text = serializePoseRecording(createPoseRecording(this.frames, {
      kind: 'mediapipe',
      tasksVisionVersion: MEDIAPIPE_WASM_VERSION,
      modelSha256,
      delegate,
      runningMode: 'VIDEO',
      runtime: { userAgent: navigator.userAgent, platform: navigator.platform },
    }));
    // Extra fields the recording parser ignores.
    const delaysMs = this.frames.map((frame) => delays.get(frame) ?? null);
    return JSON.stringify({ ...JSON.parse(text), delaysMs, ...(photos.length ? { photos } : {}) });
  }
}

/** GPU runs the full model and CPU the lite one; the recording must say which it measured. */
export async function downloadRecording(recorder: PoseRecorder, delegate: Delegate, prefix = 'corrida', photos: readonly Photo[] = []): Promise<void> {
  const modelName = delegate === 'GPU' ? `pose_landmarker_full.${POSE_FULL_MODEL_SHA8}.task` : `pose_landmarker_lite.${POSE_MODEL_SHA8}.task`;
  const sums = await (await fetch(`${import.meta.env.BASE_URL}mediapipe/models/SHA256SUMS`)).text();
  const sha = sums.split(/\r?\n/).find((line) => line.trim().endsWith(modelName))?.trim().split(/\s+/)[0];
  if (!sha) throw new Error(`Modelo ${modelName} não está no SHA256SUMS.`);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([recorder.serialize(delegate, sha, photos)], { type: 'application/json' }));
  link.download = `${prefix}-${delegate}-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}
