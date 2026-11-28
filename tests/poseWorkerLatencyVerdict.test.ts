import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerReply, WorkerRequest } from '../packages/core/src/providers/poseProtocol';

const mediaPipe = vi.hoisted(() => ({
  forVisionTasks: vi.fn(async (baseUrl: string) => ({
    wasmLoaderPath: `${baseUrl}/vision_wasm_module_internal.js`,
    wasmBinaryPath: `${baseUrl}/vision_wasm_module_internal.wasm`,
  })),
  createFromOptions: vi.fn(async (_fileset: { wasmLoaderPath: string }, options: { baseOptions: { delegate: string } }) => {
    if (options.baseOptions.delegate === 'GPU') {
      // Slow but successful GPU inference: the latency verdict, not an exception, must fire.
      return {
        close: vi.fn(),
        detectForVideo: vi.fn(() => ({ landmarks: [], worldLandmarks: [] })),
      };
    }
    throw new Error('CPU init failed.');
  }),
}));

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: mediaPipe.forVisionTasks },
  PoseLandmarker: { createFromOptions: mediaPipe.createFromOptions },
  HandLandmarker: { createFromOptions: mediaPipe.createFromOptions },
}));

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => Promise<void>) | null;
  postMessage: ReturnType<typeof vi.fn>;
  location: { href: string };
}

describe('pose worker latency verdict', () => {
  let worker: WorkerScope;
  let nowMs: number;

  beforeEach(() => {
    vi.resetModules();
    mediaPipe.forVisionTasks.mockClear();
    mediaPipe.createFromOptions.mockClear();
    nowMs = 0;
    // Every performance.now() call advances 200 ms, so each frame measures 200 ms of
    // inference — far above the 45 ms GPU probe budget, forcing the latency fallback.
    vi.spyOn(performance, 'now').mockImplementation(() => {
      nowMs += 200;
      return nowMs;
    });

    worker = {
      onmessage: null,
      postMessage: vi.fn(),
      location: { href: 'http://localhost/packages/core/src/providers/pose.worker.js' },
    };
    vi.stubGlobal('self', worker);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(1),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not emit a POSE for the frame whose latency fallback fails fatally', async () => {
    await import('../packages/core/src/providers/pose.worker');
    const dispatch = async (data: WorkerRequest) => {
      if (!worker.onmessage) throw new Error('worker message handler was not installed');
      await worker.onmessage({ data } as MessageEvent<WorkerRequest>);
    };

    await dispatch({
      type: 'INIT',
      delegate: 'GPU',
      wasmBaseUrl: '/mediapipe/wasm-1.2.3',
      modelUrl: '/mediapipe/pose.task',
    });

    const replies = () => worker.postMessage.mock.calls.map(([reply]) => reply as WorkerReply);
    const bitmaps: { close: ReturnType<typeof vi.fn> }[] = [];
    for (let requestId = 1; requestId <= 5; requestId += 1) {
      const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
      bitmaps.push(bitmap as unknown as { close: ReturnType<typeof vi.fn> });
      await dispatch({ type: 'FRAME', bitmap, requestId, captureEpoch: 1, timestampMs: requestId * 10 });
    }

    // Frames 1-4 complete before the verdict: one POSE each, no fallback yet.
    for (let requestId = 1; requestId <= 4; requestId += 1) {
      expect(replies().some((reply) => reply.type === 'POSE' && reply.requestId === requestId)).toBe(true);
    }
    // Frame 5 triggers the verdict and the CPU fallback fails: the frame must end in exactly
    // one terminal reply — the fatal ERROR. A POSE first would release the client's in-flight
    // slot, so the ERROR that follows it is dropped as stale and the fatal failure is swallowed.
    expect(replies().some((reply) => reply.type === 'POSE' && reply.requestId === 5)).toBe(false);
    const fatal = replies().find((reply) => reply.type === 'ERROR' && 'requestId' in reply && reply.requestId === 5);
    expect(fatal).toMatchObject({ type: 'ERROR', stage: 'detect', fatal: true });
    expect((fatal as { message: string }).message).toContain('fallback CPU também falhou');
    expect(bitmaps.every((bitmap) => bitmap.close.mock.calls.length === 1)).toBe(true);
  });
});
