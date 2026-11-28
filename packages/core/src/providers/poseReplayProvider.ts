import type { Delegate, Point3, PoseSnapshot } from '../types';

export const POSE_RECORDING_SCHEMA_VERSION = 2 as const;
export const POSE_LANDMARK_SCHEMA = 'mediapipe-pose-33' as const;
export type PoseRecordingTimestampClock = 'performance' | 'media-time' | 'synthetic';

export interface PoseRecordingSource {
  kind: 'synthetic' | 'mediapipe';
  tasksVisionVersion?: string;
  modelSha256?: string;
  delegate?: Delegate;
  runningMode?: 'VIDEO' | 'LIVE_STREAM';
  /** Sampling rate used to collect the frames, when the harness knows it. */
  samplingFps?: number;
  droppedFrameCount?: number;
  runtime?: { userAgent: string; platform: string };
  input?: {
    width: number;
    height: number;
    rotationDegrees: 0 | 90 | 180 | 270;
    mirrored: boolean;
    sha256?: string;
  };
}

export interface PoseRecordingFrame {
  sequence: number;
  snapshot: PoseSnapshot;
}

export interface PoseRecording {
  schemaVersion: typeof POSE_RECORDING_SCHEMA_VERSION;
  timestampUnit: 'ms';
  timestampClock: PoseRecordingTimestampClock;
  landmarkSchema: typeof POSE_LANDMARK_SCHEMA;
  source: PoseRecordingSource;
  frameCount: number;
  firstTimestampMs: number;
  lastTimestampMs: number;
  frames: readonly PoseRecordingFrame[];
}

function clonePoint(point: Point3): Point3 {
  return { ...point };
}

function cloneSnapshot(snapshot: PoseSnapshot): PoseSnapshot {
  return {
    timestampMs: snapshot.timestampMs,
    landmarks: snapshot.landmarks.map(clonePoint),
    worldLandmarks: snapshot.worldLandmarks.map(clonePoint),
    trackingState: snapshot.trackingState,
    bodyConfidence: snapshot.bodyConfidence,
    frameWidth: snapshot.frameWidth,
    frameHeight: snapshot.frameHeight,
  };
}

function cloneSource(source: PoseRecordingSource): PoseRecordingSource {
  return {
    kind: source.kind,
    ...(source.tasksVisionVersion !== undefined ? { tasksVisionVersion: source.tasksVisionVersion } : {}),
    ...(source.modelSha256 !== undefined ? { modelSha256: source.modelSha256 } : {}),
    ...(source.delegate !== undefined ? { delegate: source.delegate } : {}),
    ...(source.runningMode !== undefined ? { runningMode: source.runningMode } : {}),
    ...(source.samplingFps !== undefined ? { samplingFps: source.samplingFps } : {}),
    ...(source.droppedFrameCount !== undefined ? { droppedFrameCount: source.droppedFrameCount } : {}),
    ...(source.runtime !== undefined ? { runtime: { ...source.runtime } } : {}),
    ...(source.input !== undefined ? { input: { ...source.input } } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertFinite(value: unknown, description: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${description} must be a finite number.`);
  }
}

function validatePoint(value: unknown, description: string): asserts value is Point3 {
  if (!isRecord(value)) throw new TypeError(`${description} must be a point object.`);
  assertFinite(value.x, `${description}.x`);
  assertFinite(value.y, `${description}.y`);
  assertFinite(value.z, `${description}.z`);
  for (const key of ['visibility', 'presence'] as const) {
    const confidence = value[key];
    if (confidence !== undefined && (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new RangeError(`${description}.${key} must be between 0 and 1.`);
    }
  }
}

function validateLandmarks(value: unknown, description: string): asserts value is readonly Point3[] {
  if (!Array.isArray(value)) throw new TypeError(`${description} must be an array.`);
  if (value.length !== 0 && value.length !== 33) {
    throw new RangeError(`${description} must contain either 0 or 33 landmarks.`);
  }
  value.forEach((point, index) => {
    validatePoint(point, `${description}[${index}]`);
  });
}

function validateSnapshot(value: unknown, index: number, requireFrameDimensions: boolean): asserts value is PoseSnapshot {
  const description = `Replay frame ${index} snapshot`;
  if (!isRecord(value)) throw new TypeError(`${description} must be an object.`);
  assertFinite(value.timestampMs, `${description}.timestampMs`);
  if (value.timestampMs < 0) throw new RangeError(`${description}.timestampMs must not be negative.`);
  if (!['calibrating', 'tracked', 'degraded', 'lost'].includes(String(value.trackingState))) {
    throw new TypeError(`${description}.trackingState is invalid.`);
  }
  assertFinite(value.bodyConfidence, `${description}.bodyConfidence`);
  if (value.bodyConfidence < 0 || value.bodyConfidence > 1) {
    throw new RangeError(`${description}.bodyConfidence must be between 0 and 1.`);
  }
  validateLandmarks(value.landmarks, `${description}.landmarks`);
  validateLandmarks(value.worldLandmarks, `${description}.worldLandmarks`);
  if (value.landmarks.length !== value.worldLandmarks.length) {
    throw new RangeError(`${description} image and world landmarks must have the same count.`);
  }
  if (requireFrameDimensions) {
    assertFinite(value.frameWidth, `${description}.frameWidth`);
    assertFinite(value.frameHeight, `${description}.frameHeight`);
    if (value.frameWidth <= 0 || value.frameHeight <= 0) {
      throw new RangeError(`${description} frame dimensions must be positive.`);
    }
  }
}

function validateSource(value: unknown): asserts value is PoseRecordingSource {
  if (!isRecord(value) || (value.kind !== 'synthetic' && value.kind !== 'mediapipe')) {
    throw new TypeError('Replay source kind must be synthetic or mediapipe.');
  }
  if (value.kind === 'mediapipe') {
    if (typeof value.tasksVisionVersion !== 'string' || !value.tasksVisionVersion.trim()) {
      throw new TypeError('MediaPipe replay source requires tasksVisionVersion.');
    }
    if (typeof value.modelSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.modelSha256)) {
      throw new TypeError('MediaPipe replay source requires a 64-character modelSha256.');
    }
    if (value.delegate !== 'GPU' && value.delegate !== 'CPU') {
      throw new TypeError('MediaPipe replay source requires a GPU or CPU delegate.');
    }
    if (value.runningMode !== 'VIDEO' && value.runningMode !== 'LIVE_STREAM') {
      throw new TypeError('MediaPipe replay source requires a VIDEO or LIVE_STREAM runningMode.');
    }
  }
  if (value.samplingFps !== undefined && (typeof value.samplingFps !== 'number' || !Number.isFinite(value.samplingFps) || value.samplingFps <= 0)) {
    throw new RangeError('Replay source samplingFps must be a positive finite number.');
  }
  if (value.droppedFrameCount !== undefined && (!Number.isInteger(value.droppedFrameCount) || Number(value.droppedFrameCount) < 0)) {
    throw new RangeError('Replay source droppedFrameCount must be a non-negative integer.');
  }
  if (value.runtime !== undefined && (!isRecord(value.runtime) || typeof value.runtime.userAgent !== 'string' || typeof value.runtime.platform !== 'string')) {
    throw new TypeError('Replay source runtime must include userAgent and platform strings.');
  }
  if (value.input !== undefined) {
    const input = value.input;
    if (!isRecord(input) || !Number.isInteger(input.width) || Number(input.width) <= 0 || !Number.isInteger(input.height) || Number(input.height) <= 0) {
      throw new TypeError('Replay source input dimensions must be positive integers.');
    }
    if (typeof input.rotationDegrees !== 'number' || ![0, 90, 180, 270].includes(input.rotationDegrees) || typeof input.mirrored !== 'boolean') {
      throw new TypeError('Replay source input rotation or mirrored flag is invalid.');
    }
    if (input.sha256 !== undefined && (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.sha256))) {
      throw new TypeError('Replay source input sha256 must contain 64 hexadecimal characters.');
    }
  }
}

/** Builds a versioned recording manifest around snapshots and validates it before returning. */
export function createPoseRecording(
  snapshots: readonly PoseSnapshot[],
  source: PoseRecordingSource = { kind: 'synthetic' },
  timestampClock: PoseRecordingTimestampClock = source.kind === 'synthetic' ? 'synthetic' : 'performance',
): PoseRecording {
  const frames = snapshots.map((snapshot, sequence) => ({ sequence, snapshot: cloneSnapshot(snapshot) }));
  const firstTimestampMs = frames[0]?.snapshot.timestampMs ?? 0;
  const lastTimestampMs = frames.at(-1)?.snapshot.timestampMs ?? 0;
  return parsePoseRecording({
    schemaVersion: POSE_RECORDING_SCHEMA_VERSION,
    timestampUnit: 'ms',
    timestampClock,
    landmarkSchema: POSE_LANDMARK_SCHEMA,
    source: { ...source },
    frameCount: frames.length,
    firstTimestampMs,
    lastTimestampMs,
    frames,
  });
}

/** Parses and validates untrusted JSON/object recording data, returning an owned deep copy. */
export function parsePoseRecording(input: unknown): PoseRecording {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new SyntaxError('Pose recording is not valid JSON.');
    }
  }
  if (!isRecord(value)) throw new TypeError('Pose recording must be an object.');
  if (value.schemaVersion !== POSE_RECORDING_SCHEMA_VERSION && value.schemaVersion !== 1) {
    throw new RangeError(`Unsupported pose recording schema version: ${String(value.schemaVersion)}.`);
  }
  const legacyWithoutDimensions = value.schemaVersion === 1;
  if (value.timestampUnit !== 'ms' || !['performance', 'media-time', 'synthetic'].includes(String(value.timestampClock))) {
    throw new TypeError('Pose recording timestamps require milliseconds and a supported clock domain.');
  }
  if (value.landmarkSchema !== POSE_LANDMARK_SCHEMA) throw new TypeError('Unsupported pose landmark schema.');
  validateSource(value.source);
  // Version 1 predates per-frame dimensions, but lane measurement divides by the frame aspect
  // ratio — replaying without them would feed NaN into every filter downstream. The recorder has
  // always stored the input video geometry in the source metadata, so genuine recordings migrate;
  // anything else cannot be recovered and the player must re-record.
  const legacyInput = isRecord(value.source) && isRecord(value.source.input) ? value.source.input : undefined;
  if (legacyWithoutDimensions && (!Number.isInteger(legacyInput?.width) || !Number.isInteger(legacyInput?.height))) {
    throw new RangeError('Pose recording schema version 1 lacks frame dimensions and trusted input geometry; please re-record it.');
  }
  if (!Array.isArray(value.frames)) throw new TypeError('Pose recording frames must be an array.');
  const rawFrames: unknown[] = value.frames;
  if (!Number.isInteger(value.frameCount) || value.frameCount !== rawFrames.length) {
    throw new RangeError('Pose recording frameCount does not match its frames.');
  }

  const frames = rawFrames.map((frame, index) => {
    if (!isRecord(frame) || frame.sequence !== index) {
      throw new RangeError(`Replay frame ${index} must have sequence ${index}.`);
    }
    const snapshot = frame.snapshot;
    validateSnapshot(snapshot, index, !legacyWithoutDimensions);
    const ownedSnapshot = legacyWithoutDimensions
      // Every version 1 recording came from the pose-replay harness, which resizes frames to
      // 640px wide before inference — so the landmarks are normalized against the resized
      // bitmap, not the source video dimensions stored in the metadata. Reconstructing the
      // bitmap size with the same proportional rule keeps the aspect correction honest; the
      // integer rounding is approximate by at most half a pixel. Never write into the caller's
      // object: the input may be frozen, and a later validation failure must not leave it
      // partially migrated.
      ? {
          ...snapshot,
          frameWidth: 640,
          frameHeight: Math.round(((legacyInput!.height as number) * 640) / (legacyInput!.width as number)),
        }
      : snapshot;
    if (index > 0 && snapshot.timestampMs <= (rawFrames[index - 1] as PoseRecordingFrame).snapshot.timestampMs) {
      throw new RangeError(`Replay timestamps must be strictly increasing (frame ${index}).`);
    }
    return { sequence: index, snapshot: cloneSnapshot(ownedSnapshot) };
  });

  const firstTimestampMs = frames[0]?.snapshot.timestampMs ?? 0;
  const lastTimestampMs = frames.at(-1)?.snapshot.timestampMs ?? 0;
  assertFinite(value.firstTimestampMs, 'Pose recording firstTimestampMs');
  assertFinite(value.lastTimestampMs, 'Pose recording lastTimestampMs');
  if (value.firstTimestampMs !== firstTimestampMs || value.lastTimestampMs !== lastTimestampMs) {
    throw new RangeError('Pose recording time bounds do not match its frames.');
  }

  return {
    schemaVersion: POSE_RECORDING_SCHEMA_VERSION,
    timestampUnit: 'ms',
    timestampClock: value.timestampClock as PoseRecordingTimestampClock,
    landmarkSchema: POSE_LANDMARK_SCHEMA,
    source: cloneSource(value.source as PoseRecordingSource),
    frameCount: frames.length,
    firstTimestampMs,
    lastTimestampMs,
    frames,
  };
}

export function serializePoseRecording(recording: PoseRecording): string {
  return JSON.stringify(parsePoseRecording(recording));
}

/** Deterministic, camera-free replay source for PoseSnapshot recordings. */
export class PoseReplayProvider {
  private readonly frames: readonly PoseRecordingFrame[];
  private cursor = 0;

  constructor(recording: PoseRecording | string) {
    this.frames = parsePoseRecording(recording).frames;
  }

  get isComplete(): boolean {
    return this.cursor >= this.frames.length;
  }

  get frameIndex(): number {
    return this.cursor;
  }

  next(): PoseSnapshot | undefined {
    const frame = this.frames[this.cursor];
    if (!frame) return undefined;
    this.cursor += 1;
    return cloneSnapshot(frame.snapshot);
  }

  reset(): void {
    this.cursor = 0;
  }
}

