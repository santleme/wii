import { createPoseRecording, parsePoseRecording } from '@wii/spatial-core';
import type { Point3, PoseRecording, PoseSnapshot, WorkerReply } from '@wii/spatial-core';
import { MEDIAPIPE_WASM_VERSION } from '../src/cv/mediapipeAssets';
import { type PoseReplayModelChoice, poseReplayModelFiles } from './poseReplayAssets';
import { delegateContext, incompatibleReasons } from './poseReplayCompare';
import { PoseWorkerSession } from './poseReplaySession';
import { seekVideoTo, waitForVideoFrame } from './poseReplayVideo';

const query = new URLSearchParams(location.search);
const requestedFps = Number(query.get('fps') ?? '30');
/** Default to the rate the game's detectors see; external clips may need their native cadence. */
const SAMPLE_FPS = Number.isFinite(requestedFps) && requestedFps > 0 ? Math.min(60, requestedFps) : 30;
const SAMPLE_STEP_MS = 1000 / SAMPLE_FPS;
const EVAL_MODE = query.has('eval');
const MAX_CLIP_BYTES = 256 * 1024 * 1024;
const videoInput = document.querySelector<HTMLInputElement>('#video-file')!;
const referenceInput = document.querySelector<HTMLInputElement>('#reference-file')!;
const delegateInput = document.querySelector<HTMLSelectElement>('#delegate')!;
const modelInput = document.querySelector<HTMLSelectElement>('#model')!;
const imageToleranceInput = document.querySelector<HTMLInputElement>('#image-tolerance')!;
const worldToleranceInput = document.querySelector<HTMLInputElement>('#world-tolerance')!;
const confidenceToleranceInput = document.querySelector<HTMLInputElement>('#confidence-tolerance')!;
const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const downloadButton = document.querySelector<HTMLButtonElement>('#download')!;
const video = document.querySelector<HTMLVideoElement>('#video')!;
const report = document.querySelector<HTMLPreElement>('#report')!;

let currentRecording: PoseRecording | undefined;
let activeWorker: Worker | undefined;
let currentUrl: string | undefined;

function confidence(points: readonly Point3[]): number {
  // Same anchor as the live client: the shoulders.
  const indices = [11, 12];
  if (indices.some((index) => !points[index])) return 0;
  return Math.min(...indices.map((index) => {
    const point = points[index]!;
    return Math.min(point.visibility ?? point.presence ?? 0, point.presence ?? point.visibility ?? 0);
  }));
}

function snapshotFromReply(reply: Extract<WorkerReply, { type: 'POSE' }>): PoseSnapshot {
  return {
    timestampMs: reply.timestampMs,
    landmarks: reply.landmarks,
    worldLandmarks: reply.worldLandmarks,
    trackingState: 'degraded',
    bodyConfidence: confidence(reply.landmarks),
    frameWidth: reply.frameWidth,
    frameHeight: reply.frameHeight,
  };
}

async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifiedModel(sums: string, modelName: string) {
  const expectedHash = sums.split(/\r?\n/).find((line) => line.trim().endsWith(modelName))?.trim().split(/\s+/)[0];
  if (!expectedHash) throw new Error(`Model ${modelName} is not listed in SHA256SUMS.`);
  const modelUrl = new URL(`/mediapipe/models/${modelName}`, location.origin).href;
  const modelResponse = await fetch(modelUrl);
  if (!modelResponse.ok) throw new Error(`Could not fetch local model (${modelResponse.status}).`);
  const actualHash = await sha256(await modelResponse.arrayBuffer());
  if (actualHash !== expectedHash) throw new Error('Local pose model does not match SHA256SUMS.');
  return { modelUrl, modelSha256: actualHash };
}

async function modelAssets(delegate: 'CPU' | 'GPU', choice: PoseReplayModelChoice) {
  const sumsResponse = await fetch('/mediapipe/models/SHA256SUMS');
  if (!sumsResponse.ok) throw new Error('Could not read the local MediaPipe model checksum manifest.');
  const sums = await sumsResponse.text();
  const files = poseReplayModelFiles(delegate, choice);
  const primary = await verifiedModel(sums, files.modelFile);
  const cpu = files.cpuModelFile === files.modelFile ? primary : await verifiedModel(sums, files.cpuModelFile);
  return {
    wasmBaseUrl: new URL(`/mediapipe/wasm-${MEDIAPIPE_WASM_VERSION}`, location.origin).href,
    modelUrl: primary.modelUrl,
    cpuModelUrl: cpu.modelUrl,
    modelSha256: primary.modelSha256,
    cpuModelSha256: cpu.modelSha256,
  };
}

function loadVideo(file: File): Promise<void> {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(file);
  video.src = currentUrl;
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Video metadata did not load within 15 seconds.')), 15_000);
    video.onloadedmetadata = () => { window.clearTimeout(timeout); resolve(); };
    video.onerror = () => { window.clearTimeout(timeout); reject(new Error('Browser could not decode this video.')); };
    video.load();
  }).then(() => waitForVideoFrame(video));
}

async function readReference(file: File): Promise<PoseRecording> {
  return parsePoseRecording(await file.text());
}

function errors(reference: PoseRecording, actual: PoseRecording) {
  const image: number[] = [];
  const world: number[] = [];
  const confidence: number[] = [];
  let topologyMismatch = false;
  let trackingStateMismatch = false;
  for (let frameIndex = 0; frameIndex < Math.min(reference.frames.length, actual.frames.length); frameIndex += 1) {
    const expected = reference.frames[frameIndex]!.snapshot;
    const observed = actual.frames[frameIndex]!.snapshot;
    confidence.push(Math.abs(expected.bodyConfidence - observed.bodyConfidence));
    trackingStateMismatch ||= expected.trackingState !== observed.trackingState;
    if (expected.landmarks.length !== observed.landmarks.length || expected.worldLandmarks.length !== observed.worldLandmarks.length) {
      topologyMismatch = true;
      continue;
    }
    for (let pointIndex = 0; pointIndex < expected.landmarks.length; pointIndex += 1) {
      for (const axis of ['x', 'y', 'z'] as const) {
        image.push(Math.abs(expected.landmarks[pointIndex]![axis] - observed.landmarks[pointIndex]![axis]));
        world.push(Math.abs(expected.worldLandmarks[pointIndex]![axis] - observed.worldLandmarks[pointIndex]![axis]));
      }
      for (const key of ['visibility', 'presence'] as const) {
        const expectedImageConfidence = expected.landmarks[pointIndex]![key];
        const actualImageConfidence = observed.landmarks[pointIndex]![key];
        const expectedWorldConfidence = expected.worldLandmarks[pointIndex]![key];
        const actualWorldConfidence = observed.worldLandmarks[pointIndex]![key];
        if (expectedImageConfidence !== undefined && actualImageConfidence !== undefined) {
          confidence.push(Math.abs(expectedImageConfidence - actualImageConfidence));
        } else if (expectedImageConfidence !== actualImageConfidence) topologyMismatch = true;
        if (expectedWorldConfidence !== undefined && actualWorldConfidence !== undefined) {
          confidence.push(Math.abs(expectedWorldConfidence - actualWorldConfidence));
        } else if (expectedWorldConfidence !== actualWorldConfidence) topologyMismatch = true;
      }
    }
  }
  const stats = (values: number[]) => {
    if (!values.length) return { comparedValues: 0, maxAbsError: null, p95AbsError: null };
    const sorted = [...values].sort((a, b) => a - b);
    return {
      comparedValues: sorted.length,
      maxAbsError: sorted.at(-1)!,
      p95AbsError: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
    };
  };
  return { topologyMismatch, trackingStateMismatch, image: stats(image), world: stats(world), confidence: stats(confidence) };
}

async function run(): Promise<void> {
  const videoFile = videoInput.files?.[0];
  const referenceFile = referenceInput.files?.[0];
  if (!videoFile) throw new Error('Choose a local video clip.');
  if (videoFile.size > MAX_CLIP_BYTES) throw new RangeError('The local harness accepts clips up to 256 MiB.');
  const imageTolerance = Number(imageToleranceInput.value);
  const worldTolerance = Number(worldToleranceInput.value);
  const confidenceTolerance = Number(confidenceToleranceInput.value);
  if (![imageTolerance, worldTolerance, confidenceTolerance].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new RangeError('Coordinate tolerances must be finite, non-negative numbers.');
  }

  const reference = referenceFile ? await readReference(referenceFile) : undefined;
  await loadVideo(videoFile);
  const videoHash = await sha256(await videoFile.arrayBuffer());
  const requestedDelegate = delegateInput.value as 'CPU' | 'GPU';
  const model = await modelAssets(requestedDelegate, modelInput.value as PoseReplayModelChoice);
  const worker = new Worker(new URL('../packages/core/src/providers/pose.worker.ts', import.meta.url), { type: 'module' });
  activeWorker = worker;
  const session = new PoseWorkerSession(worker, requestedDelegate);
  await session.initialize(model.wasmBaseUrl, model.modelUrl, model.cpuModelUrl);
  const snapshots: PoseSnapshot[] = [];
  let droppedFrameCount = 0;
  const frameCount = Math.floor((video.duration * 1000) / SAMPLE_STEP_MS) + 1;

  for (let sequence = 0; sequence < frameCount; sequence += 1) {
    const timestampMs = sequence * SAMPLE_STEP_MS;
    await seekVideoTo(video, timestampMs / 1000);
    // Resized exactly as the live client does it.
    const bitmap = video.videoWidth > 640
      ? await createImageBitmap(video, { resizeWidth: 640, resizeQuality: 'medium' })
      : await createImageBitmap(video);
    const reply = await session.detect(bitmap, timestampMs);
    session.assertSingleConfigurationRun();
    if (!reply) {
      droppedFrameCount += 1;
      report.textContent = `Processed ${sequence + 1}/${frameCount} sampled frames (${droppedFrameCount} dropped)…`;
      continue;
    }
    snapshots.push(snapshotFromReply(reply));
    report.textContent = `Processed ${sequence + 1}/${frameCount} sampled frames…`;
  }

  session.dispose();
  activeWorker = undefined;
  currentRecording = createPoseRecording(snapshots, {
    kind: 'mediapipe',
    tasksVisionVersion: MEDIAPIPE_WASM_VERSION,
    modelSha256: (session.sampledDelegate ?? session.delegate) === 'CPU' ? model.cpuModelSha256 : model.modelSha256,
    delegate: session.sampledDelegate ?? session.delegate,
    runningMode: 'VIDEO',
    samplingFps: SAMPLE_FPS,
    droppedFrameCount,
    runtime: { userAgent: navigator.userAgent, platform: navigator.platform },
    input: {
      width: video.videoWidth,
      height: video.videoHeight,
      rotationDegrees: 0,
      mirrored: false,
      sha256: videoHash,
    },
  }, 'media-time');
  if (EVAL_MODE) (window as Window & { POSE_RECORDING?: PoseRecording }).POSE_RECORDING = currentRecording;
  downloadButton.disabled = false;

  if (!reference) {
    const result = {
      status: 'recorded',
      message: 'This run can be downloaded as a reference. Re-run with that JSON selected to compare future inference.',
      sampling: { fps: SAMPLE_FPS, stepMs: SAMPLE_STEP_MS, frameCount, videoDurationMs: video.duration * 1000 },
      runtime: currentRecording.source,
    };
    (window as Window & { POSE_REGRESSION?: unknown }).POSE_REGRESSION = result;
    report.textContent = JSON.stringify(result, null, 2);
    console.log('POSE_REGRESSION', result);
    return;
  }

  const reasons = incompatibleReasons(reference, currentRecording);
  const difference = errors(reference, currentRecording);
  const hasValues = difference.image.comparedValues > 0 && difference.world.comparedValues > 0;
  const passed = reasons.length === 0 && hasValues && !difference.topologyMismatch && !difference.trackingStateMismatch &&
    difference.image.maxAbsError! <= imageTolerance && difference.world.maxAbsError! <= worldTolerance &&
    difference.confidence.maxAbsError! <= confidenceTolerance;
  const result = {
    status: reasons.length > 0 ? 'incomparable' : !hasValues ? 'inconclusive' : passed ? 'pass' : 'fail',
    comparison: reasons,
    delegates: delegateContext(requestedDelegate, currentRecording, reference),
    sampling: { fps: SAMPLE_FPS, stepMs: SAMPLE_STEP_MS, frameCount, videoDurationMs: video.duration * 1000 },
    tolerance: {
      imageCoordinateMaxAbs: imageTolerance,
      worldCoordinateMaxAbsMeters: worldTolerance,
      confidenceMaxAbs: confidenceTolerance,
    },
    differences: difference,
    runtime: currentRecording.source,
  };
  (window as Window & { POSE_REGRESSION?: unknown }).POSE_REGRESSION = result;
  report.textContent = JSON.stringify(result, null, 2);
  console.log('POSE_REGRESSION', result);
}

runButton.addEventListener('click', () => {
  runButton.disabled = true;
  downloadButton.disabled = true;
  currentRecording = undefined;
  report.textContent = 'Starting local Pose inference…';
  void run().catch((error: unknown) => {
    report.textContent = JSON.stringify({ status: 'error', message: error instanceof Error ? error.message : String(error) }, null, 2);
    activeWorker?.terminate();
    activeWorker = undefined;
  }).finally(() => { runButton.disabled = false; });
});

downloadButton.addEventListener('click', () => {
  if (!currentRecording) return;
  const blob = new Blob([JSON.stringify(currentRecording, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `pose-recording-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

window.addEventListener('beforeunload', () => {
  activeWorker?.terminate();
  if (currentUrl) URL.revokeObjectURL(currentUrl);
});
