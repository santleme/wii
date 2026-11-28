import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerReply, WorkerRequest } from '../packages/core/src/providers/poseProtocol';

const mediaPipe = vi.hoisted(() => ({
  detectForVideo: vi.fn(),
}));

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: async () => ({ wasmLoaderPath: 'http://localhost/loader.js' }) },
  PoseLandmarker: {
    createFromOptions: async () => ({ close: vi.fn(), detectForVideo: mediaPipe.detectForVideo }),
  },
}));

describe('pose worker frame ownership', () => {
  let scope: { onmessage: ((event: MessageEvent<WorkerRequest>) => Promise<void>) | null; postMessage: ReturnType<typeof vi.fn> };
  const dispatch = (data: WorkerRequest) => scope.onmessage!({ data } as MessageEvent<WorkerRequest>);
  const replies = () => scope.postMessage.mock.calls.map(([reply]) => reply as WorkerReply);
  const frame = () => ({ width: 640, height: 480, close: vi.fn() }) as unknown as ImageBitmap;

  beforeEach(async () => {
    vi.resetModules();
    mediaPipe.detectForVideo.mockReset().mockReturnValue({ landmarks: [], worldLandmarks: [] });
    scope = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', scope);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    await import('../packages/core/src/providers/pose.worker');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('closes frames from any capture epoch, including after disposal', async () => {
    await dispatch({ type: 'INIT', delegate: 'GPU', wasmBaseUrl: '/wasm', modelUrl: '/pose.task' });
    const stale = frame();
    await dispatch({ type: 'FRAME', bitmap: stale, requestId: 1, captureEpoch: 0, timestampMs: 10 });
    expect(stale.close).toHaveBeenCalledOnce();

    await dispatch({ type: 'DISPOSE' });
    const late = frame();
    await dispatch({ type: 'FRAME', bitmap: late, requestId: 2, captureEpoch: 1, timestampMs: 20 });
    expect(late.close).toHaveBeenCalledOnce();
    expect(replies().at(-1)).toMatchObject({ type: 'ERROR', stage: 'detect', fatal: true });
  });
});
