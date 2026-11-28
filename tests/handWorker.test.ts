import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandWorkerReply, HandWorkerRequest } from '../packages/core/src/providers/handProtocol';

const mediaPipe = vi.hoisted(() => ({
  timestamps: [] as { delegate: string; timestampMs: number }[],
  options: [] as Record<string, unknown>[],
  /** Simulated GPU inference cost on the stubbed clock. */
  gpuCostMs: 0,
  cpuFails: false,
  clockMs: 0,
}));

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: {
    forVisionTasks: async (baseUrl: string) => ({ wasmLoaderPath: `${baseUrl}/loader.js` }),
  },
  HandLandmarker: {
    createFromOptions: async (_fileset: unknown, options: { baseOptions: { delegate: string } }) => {
      const { delegate } = options.baseOptions;
      mediaPipe.options.push(options as unknown as Record<string, unknown>);
      if (delegate === 'CPU' && mediaPipe.cpuFails) throw new Error('CPU unavailable');
      return {
        close: () => undefined,
        detectForVideo: (_image: unknown, timestampMs: number) => {
          mediaPipe.timestamps.push({ delegate, timestampMs });
          if (delegate === 'GPU') mediaPipe.clockMs += mediaPipe.gpuCostMs;
          return { landmarks: [], worldLandmarks: [], handedness: [] };
        },
      };
    },
  },
}));

describe('hand worker', () => {
  const replies: HandWorkerReply[] = [];
  let send: (data: HandWorkerRequest) => Promise<void>;

  const frame = (requestId: number, timestampMs = requestId * 10) => {
    const bitmap = { close: vi.fn() };
    return { bitmap, done: send({ type: 'FRAME', requestId, timestampMs, bitmap: bitmap as unknown as ImageBitmap }) };
  };
  const init = () => send({ type: 'INIT', delegate: 'GPU', wasmBaseUrl: '/wasm', modelUrl: '/hand.task' });

  beforeEach(async () => {
    vi.resetModules();
    Object.assign(mediaPipe, { timestamps: [], options: [], gpuCostMs: 0, cpuFails: false, clockMs: 0 });
    replies.length = 0;
    const scope = {
      onmessage: null as ((event: { data: HandWorkerRequest }) => Promise<void>) | null,
      postMessage: (reply: HandWorkerReply) => replies.push(reply),
      location: { href: 'http://localhost/hand.worker.js' },
    };
    vi.stubGlobal('self', scope);
    vi.stubGlobal('fetch', async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }));
    vi.stubGlobal('performance', { now: () => mediaPipe.clockMs });
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { fillRect: () => undefined };
        }
      },
    );
    await import('../packages/core/src/providers/hand.worker');
    send = async (data) => scope.onmessage!({ data });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('warms up before READY and keeps real timestamps above the warm-up', async () => {
    await init();
    expect(mediaPipe.timestamps).toEqual([{ delegate: 'GPU', timestampMs: 0 }]);
    expect(replies.map((reply) => reply.type)).toEqual(['READY']);

    const first = frame(1, 0);
    await first.done;
    expect(mediaPipe.timestamps.at(-1)).toEqual({ delegate: 'GPU', timestampMs: 1 });
    expect(replies.at(-1)).toMatchObject({ type: 'HAND', requestId: 1, timestampMs: 0 });
    expect(first.bitmap.close).toHaveBeenCalledOnce();
  });

  it('keeps the tracking floors low enough for a moving or tilted hand', async () => {
    await init();
    expect(mediaPipe.options[0]).toMatchObject({
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.45,
      minTrackingConfidence: 0.45,
    });
  });

  it('holds the probe reply until the warmed CPU delegate is ready', async () => {
    mediaPipe.gpuCostMs = 120;
    await init();
    for (let requestId = 1; requestId <= 5; requestId++) await frame(requestId).done;

    expect(replies.slice(-2)).toMatchObject([{ type: 'FALLBACK', to: 'CPU' }, { type: 'HAND', requestId: 5 }]);
    expect(replies.some((reply) => reply.type === 'ERROR')).toBe(false);
    expect(mediaPipe.timestamps.at(-1)).toEqual({ delegate: 'CPU', timestampMs: 0 });
  });

  it('reports a failed latency fallback against the request still in flight', async () => {
    mediaPipe.gpuCostMs = 120;
    mediaPipe.cpuFails = true;
    await init();
    for (let requestId = 1; requestId <= 5; requestId++) await frame(requestId).done;

    expect(replies.filter((reply) => reply.type === 'HAND')).toHaveLength(4);
    expect(replies.at(-1)).toMatchObject({ type: 'ERROR', fatal: true, requestId: 5 });
  });
});
