/// <reference lib="webworker" />
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { shouldFallbackForLatency } from './delegateProbe';
import type { Delegate, Point3, WorkerReply, WorkerRequest } from './poseProtocol';

let landmarker: PoseLandmarker | undefined;
let wasmBaseUrl = '';
let modelUrl = '';
let cpuModelUrl = '';
let delegate: Delegate = 'GPU';
let attemptedFallback = false;
let wasmLoaderInstance = 0;
/** Real per-frame inference times on the GPU delegate, collected until the latency verdict. */
const gpuInferenceTimes: number[] = [];
let latencyVerdictDone = false;
/** True while an async delegate re-init runs; frames in the window are dropped, not fatal. */
let transitioningDelegate = false;

/** Frames needed for the latency verdict: one warmup plus enough warmed samples for a median. */
const LATENCY_PROBE_FRAMES = 5;

async function createTask(nextDelegate: Delegate): Promise<void> {
  const vision = await FilesetResolver.forVisionTasks(wasmBaseUrl, true);
  if (wasmLoaderInstance > 0) {
    // MediaPipe consumes and clears self.ModuleFactory after instantiation. The module worker
    // caches an ESM import by URL, so a retry needs a fresh loader URL to restore the factory.
    const loaderUrl = new URL(vision.wasmLoaderPath, self.location.href);
    loaderUrl.searchParams.set('instance', String(wasmLoaderInstance));
    vision.wasmLoaderPath = loaderUrl.href;
  }
  wasmLoaderInstance += 1;
  const activeModelUrl = nextDelegate === 'CPU' && cpuModelUrl ? cpuModelUrl : modelUrl;
  const response = await fetch(activeModelUrl);
  if (!response.ok) throw new Error(`Pose model request failed (${response.status})`);
  const modelBytes = new Uint8Array(await response.arrayBuffer());
  landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetBuffer: modelBytes, delegate: nextDelegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    outputSegmentationMasks: false,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.38,
    minTrackingConfidence: 0.38,
  });
  delegate = nextDelegate;
}

function simplify(points: readonly { x: number; y: number; z: number; visibility?: number; presence?: number }[] | undefined): Point3[] {
  return (points ?? []).map(({ x, y, z, visibility, presence }) => ({ x, y, z, visibility, presence }));
}

async function fallback(reason: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (delegate !== 'GPU' || attemptedFallback) return { ok: false, message: reason };
  attemptedFallback = true;
  transitioningDelegate = true;
  try { landmarker?.close(); } catch { /* task may have failed before initialization */ }
  landmarker = undefined;
  try {
    await createTask('CPU');
    self.postMessage({ type: 'FALLBACK', from: 'GPU', to: 'CPU', reason } satisfies WorkerReply);
    return { ok: true };
  } catch (error) {
    landmarker = undefined;
    const cpuReason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `GPU falhou (${reason}); fallback CPU também falhou (${cpuReason}).` };
  } finally {
    transitioningDelegate = false;
  }
}

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  if (data.type === 'INIT') {
    wasmBaseUrl = data.wasmBaseUrl;
    modelUrl = data.modelUrl;
    cpuModelUrl = data.cpuModelUrl ?? data.modelUrl;
    try {
      try {
        await createTask(data.delegate);
      } catch (error) {
        if (data.delegate !== 'GPU') throw error;
        const reason = error instanceof Error ? error.message : String(error);
        const fallbackResult = await fallback(reason);
        if (!fallbackResult.ok) throw new Error(fallbackResult.message);
      }
      self.postMessage({ type: 'READY', delegate } satisfies WorkerReply);
    } catch (error) {
      self.postMessage({ type: 'ERROR', stage: 'init', fatal: true, message: error instanceof Error ? error.message : String(error) } satisfies WorkerReply);
    }
    return;
  }

  if (data.type === 'DISPOSE') {
    landmarker?.close();
    landmarker = undefined;
    return;
  }

  const { bitmap, timestampMs, requestId, captureEpoch } = data;
  if (!landmarker) {
    bitmap.close();
    // During a delegate re-init the missing landmarker is expected — the frame is dropped so the
    // client releases its one-in-flight slot, but the session survives. Outside a transition it is
    // the fatal invariant violation it always was.
    self.postMessage(transitioningDelegate
      ? { type: 'ERROR', stage: 'detect', fatal: false, requestId, captureEpoch, message: 'Reinicializando em CPU; frame descartado.' } satisfies WorkerReply
      : { type: 'ERROR', stage: 'detect', fatal: true, requestId, captureEpoch, message: 'PoseLandmarker is not initialized' } satisfies WorkerReply);
    return;
  }
  try {
    const inferenceStart = performance.now();
    const result = landmarker.detectForVideo(bitmap, timestampMs);
    const inferenceMs = performance.now() - inferenceStart;
    self.postMessage({
      type: 'POSE', requestId, captureEpoch, timestampMs,
      landmarks: simplify(result.landmarks[0]),
      worldLandmarks: simplify(result.worldLandmarks[0]),
      frameWidth: bitmap.width,
      frameHeight: bitmap.height,
    } satisfies WorkerReply);
    // Latency verdict on real frames: the GPU delegate over software GL costs ~96-243 ms/frame
    // without ever throwing, so only timing evidence can catch it. Decided once, early.
    if (delegate === 'GPU' && !latencyVerdictDone) {
      gpuInferenceTimes.push(inferenceMs);
      if (gpuInferenceTimes.length >= LATENCY_PROBE_FRAMES) {
        latencyVerdictDone = true;
        if (shouldFallbackForLatency(gpuInferenceTimes)) {
          const sorted = [...gpuInferenceTimes.slice(1)].sort((a, b) => a - b);
          const median = Math.round(sorted[Math.floor(sorted.length / 2)]!);
          const outcome = await fallback(`GPU lento (mediana ${median} ms/frame — provável GL de software)`);
          if (!outcome.ok) {
            self.postMessage({ type: 'ERROR', stage: 'detect', fatal: true, requestId, captureEpoch, message: outcome.message } satisfies WorkerReply);
          }
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallbackResult = await fallback(message);
    if (fallbackResult.ok) {
      self.postMessage({ type: 'ERROR', stage: 'detect', fatal: false, requestId, captureEpoch, message: 'GPU falhou; próxima captura será processada em CPU.' } satisfies WorkerReply);
    } else {
      self.postMessage({ type: 'ERROR', stage: 'detect', fatal: true, requestId, captureEpoch, message: fallbackResult.message } satisfies WorkerReply);
    }
  } finally {
    bitmap.close();
  }
};
