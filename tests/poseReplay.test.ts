import { describe, expect, it } from 'vitest';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import {
  POSE_RECORDING_SCHEMA_VERSION,
  PoseReplayProvider,
  createPoseRecording,
  parsePoseRecording,
  serializePoseRecording,
} from '@wii/spatial-core';
import type { PoseRecording } from '@wii/spatial-core';
import { calibration, pose } from './fixtures/syntheticPose';

const lostPose = (timestampMs: number) => ({
  timestampMs,
  landmarks: [],
  worldLandmarks: [],
  trackingState: 'lost' as const,
  bodyConfidence: 0,
  frameWidth: 1280,
  frameHeight: 720,
});

describe('pose recording and replay', () => {
  it('round trips versioned recordings with exact order, timestamps, and landmark values', () => {
    const snapshots = [pose(10), pose(43, { wristLateral: 0.2 }), lostPose(310)];
    const recording = createPoseRecording(snapshots);
    const decoded = parsePoseRecording(serializePoseRecording(recording));

    expect(decoded.schemaVersion).toBe(POSE_RECORDING_SCHEMA_VERSION);
    expect(decoded.frameCount).toBe(3);
    expect(decoded.firstTimestampMs).toBe(10);
    expect(decoded.lastTimestampMs).toBe(310);
    expect(decoded.frames.map(({ sequence, snapshot }) => [sequence, snapshot.timestampMs])).toEqual([
      [0, 10], [1, 43], [2, 310],
    ]);
    expect(decoded.frames[1]!.snapshot.worldLandmarks[16]).toEqual(snapshots[1]!.worldLandmarks[16]);
    expect(decoded.frames[2]!.snapshot.landmarks).toEqual([]);
  });

  it('preserves a declared sampling rate and rejects invalid ones', () => {
    const recording = createPoseRecording([pose(0)], { kind: 'synthetic', samplingFps: 15 });
    expect(parsePoseRecording(serializePoseRecording(recording)).source.samplingFps).toBe(15);
    expect(() => createPoseRecording([pose(0)], { kind: 'synthetic', samplingFps: 0 })).toThrow(/samplingFps/);
  });

  it('migrates legacy version 1 recordings using the trusted input geometry', () => {
    const recording = createPoseRecording([pose(10), pose(43)], {
      kind: 'mediapipe',
      tasksVisionVersion: '0.10.0',
      modelSha256: 'a'.repeat(64),
      delegate: 'GPU',
      runningMode: 'VIDEO',
      input: { width: 1280, height: 720, rotationDegrees: 0, mirrored: false },
    });
    const legacy = JSON.parse(serializePoseRecording(recording)) as {
      schemaVersion: number;
      frames: { snapshot: Record<string, unknown> }[];
    };
    legacy.schemaVersion = 1;
    for (const frame of legacy.frames) {
      delete frame.snapshot.frameWidth;
      delete frame.snapshot.frameHeight;
    }

    const decoded = parsePoseRecording(JSON.stringify(legacy));
    expect(decoded.frames[0]!.snapshot.frameWidth).toBe(640);
    expect(decoded.frames[0]!.snapshot.frameHeight).toBe(360);
  });

  it('reconstructs the harness inference geometry instead of the source video size', () => {
    // The recording harness resizes every frame to 640px wide before inference, so the landmarks
    // are normalized against the resized bitmap — not the original video dimensions stored in
    // the source metadata. Migration must apply the same resize rule.
    const recording = createPoseRecording([pose(10)], {
      kind: 'mediapipe',
      tasksVisionVersion: '0.10.0',
      modelSha256: 'a'.repeat(64),
      delegate: 'GPU',
      runningMode: 'VIDEO',
      input: { width: 854, height: 480, rotationDegrees: 0, mirrored: false },
    });
    const legacy = JSON.parse(serializePoseRecording(recording)) as {
      schemaVersion: number;
      frames: { snapshot: Record<string, unknown> }[];
    };
    legacy.schemaVersion = 1;
    for (const frame of legacy.frames) {
      delete frame.snapshot.frameWidth;
      delete frame.snapshot.frameHeight;
    }

    const decoded = parsePoseRecording(JSON.stringify(legacy));
    expect(decoded.frames[0]!.snapshot.frameWidth).toBe(640);
    expect(decoded.frames[0]!.snapshot.frameHeight).toBe(Math.round((480 * 640) / 854));
  });

  it('migrates legacy objects without mutating the caller snapshots', () => {
    const recording = createPoseRecording([pose(10)], {
      kind: 'mediapipe',
      tasksVisionVersion: '0.10.0',
      modelSha256: 'a'.repeat(64),
      delegate: 'GPU',
      runningMode: 'VIDEO',
      input: { width: 1280, height: 720, rotationDegrees: 0, mirrored: false },
    });
    const legacy = JSON.parse(serializePoseRecording(recording)) as {
      schemaVersion: number;
      frames: { snapshot: Record<string, unknown> }[];
    };
    legacy.schemaVersion = 1;
    for (const frame of legacy.frames) {
      delete frame.snapshot.frameWidth;
      delete frame.snapshot.frameHeight;
      Object.freeze(frame.snapshot);
    }

    const decoded = parsePoseRecording(legacy);
    expect(decoded.frames[0]!.snapshot.frameWidth).toBe(640);
    expect(legacy.frames[0]!.snapshot.frameWidth).toBeUndefined();
  });

  it('rejects legacy version 1 recordings without recoverable frame dimensions', () => {
    const recording = createPoseRecording([pose(10)]);
    const legacy = JSON.parse(serializePoseRecording(recording)) as {
      schemaVersion: number;
      frames: { snapshot: Record<string, unknown> }[];
    };
    legacy.schemaVersion = 1;
    for (const frame of legacy.frames) {
      delete frame.snapshot.frameWidth;
      delete frame.snapshot.frameHeight;
    }

    expect(() => parsePoseRecording(JSON.stringify(legacy))).toThrow(/re-record|frame dimensions/i);
  });

  it('rejects current-schema recordings whose snapshots lack frame dimensions', () => {
    const recording = createPoseRecording([pose(10)], {
      kind: 'mediapipe',
      tasksVisionVersion: '0.10.0',
      modelSha256: 'a'.repeat(64),
      delegate: 'GPU',
      runningMode: 'VIDEO',
      input: { width: 1280, height: 720, rotationDegrees: 0, mirrored: false },
    });
    const broken = JSON.parse(serializePoseRecording(recording)) as {
      frames: { snapshot: Record<string, unknown> }[];
    };
    delete broken.frames[0]!.snapshot.frameWidth;

    expect(() => parsePoseRecording(JSON.stringify(broken))).toThrow(/frameWidth/);
  });

  it('replays from the beginning after reset and returns independent snapshots', () => {
    const source = [pose(0), pose(40)];
    const replay = new PoseReplayProvider(createPoseRecording(source));
    source[0]!.landmarks[0]!.x = 12;

    const first = replay.next()!;
    first.landmarks[0]!.x = -12;
    expect(replay.next()?.timestampMs).toBe(40);
    expect(replay.isComplete).toBe(true);
    expect(replay.next()).toBeUndefined();

    replay.reset();
    expect(replay.frameIndex).toBe(0);
    expect(replay.next()?.landmarks[0]?.x).toBe(0.5);
  });

  it('produces the same downstream controls and events when the same recording is replayed twice', () => {
    const recording = createPoseRecording(Array.from({ length: 20 }, (_, index) => pose(index * 33, {
      hipRise: index % 6 < 3 ? 0.02 : 0.08,
      wristLateral: index * 0.002,
    })));
    const playThrough = () => {
      const pipeline = new ActionPipeline();
      const replay = new PoseReplayProvider(recording);
      const results = [];
      for (let snapshot = replay.next(); snapshot; snapshot = replay.next()) {
        const result = pipeline.update(snapshot, calibration());
        results.push({ events: result.events, controls: result.controls });
      }
      return results;
    };

    expect(playThrough()).toEqual(playThrough());
  });

  it('validates MediaPipe provenance before allowing a recording to be replayed', () => {
    const source = {
      kind: 'mediapipe' as const,
      tasksVisionVersion: '0.10.14',
      modelSha256: 'a'.repeat(64),
      delegate: 'CPU' as const,
      runningMode: 'VIDEO' as const,
      droppedFrameCount: 0,
      input: { width: 640, height: 480, rotationDegrees: 0 as const, mirrored: false, sha256: 'b'.repeat(64) },
    };
    const recording = createPoseRecording([pose(0)], {
      ...source,
    });
    source.input.width = 1280;

    expect(new PoseReplayProvider(recording).next()?.trackingState).toBe('tracked');
    expect(recording.source.input?.width).toBe(640);
    expect(recording.timestampClock).toBe('performance');
  });

  it('rejects string values for numeric input rotation metadata', () => {
    const valid = createPoseRecording([pose(0)], {
      kind: 'mediapipe',
      tasksVisionVersion: '0.10.14',
      modelSha256: 'a'.repeat(64),
      delegate: 'CPU',
      runningMode: 'VIDEO',
      input: { width: 640, height: 480, rotationDegrees: 90, mirrored: false },
    });
    const malformed = structuredClone(valid);
    (malformed.source.input as unknown as { rotationDegrees: unknown }).rotationDegrees = '90';

    expect(() => parsePoseRecording(malformed)).toThrow(/rotation or mirrored flag is invalid/);
  });

  it('rejects malformed JSON, unsupported schemas, incomplete manifests, and bad sequences', () => {
    expect(() => parsePoseRecording('{')).toThrow(/valid JSON/);

    const valid = createPoseRecording([pose(0), pose(40)]);
    expect(() => parsePoseRecording({ ...valid, schemaVersion: 3 })).toThrow(/Unsupported pose recording schema/);
    expect(() => parsePoseRecording({ ...valid, frameCount: 3 })).toThrow(/frameCount/);
    expect(() => parsePoseRecording({ ...valid, lastTimestampMs: 100 })).toThrow(/time bounds/);
    expect(() => parsePoseRecording({ ...valid, frames: [{ ...valid.frames[0]!, sequence: 1 }, valid.frames[1]] })).toThrow(/sequence/);
  });

  it('rejects nonmonotonic timestamps, malformed topology, nonfinite points, and invalid confidence', () => {
    const valid = createPoseRecording([pose(0), pose(40)]);
    const duplicateTime = structuredClone(valid);
    duplicateTime.frames[1]!.snapshot.timestampMs = 0;
    duplicateTime.lastTimestampMs = 0;
    expect(() => parsePoseRecording(duplicateTime)).toThrow(/strictly increasing/);

    const wrongTopology = structuredClone(valid);
    const wrongTopologyFrame = wrongTopology.frames[0]!.snapshot;
    (wrongTopologyFrame as unknown as { landmarks: unknown[] }).landmarks = wrongTopologyFrame.landmarks.slice(1);
    expect(() => parsePoseRecording(wrongTopology as PoseRecording)).toThrow(/0 or 33/);

    const nonfinite = structuredClone(valid);
    nonfinite.frames[0]!.snapshot.worldLandmarks[0]!.z = Number.NaN;
    expect(() => parsePoseRecording(nonfinite)).toThrow(/finite number/);

    const invalidConfidence = structuredClone(valid);
    invalidConfidence.frames[0]!.snapshot.bodyConfidence = 1.1;
    expect(() => parsePoseRecording(invalidConfidence)).toThrow(/between 0 and 1/);
  });
});
