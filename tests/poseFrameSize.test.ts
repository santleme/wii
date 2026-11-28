import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerReply, WorkerRequest } from '../packages/core/src/providers/poseProtocol';
import { PoseClient } from '../packages/core/src/providers/poseClient';

class FakeWorker {
  static instance: FakeWorker | undefined;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: WorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  throwOnFrame = false;

  constructor() { FakeWorker.instance = this; }

  postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
    if (message.type === 'FRAME' && this.throwOnFrame) throw new Error('DataCloneError');
    this.sent.push(message);
    this.transfers.push(transfer);
    if (message.type === 'INIT') queueMicrotask(() => this.reply({ type: 'READY', delegate: message.delegate }));
  }

  terminate(): void {}

  reply(message: WorkerReply): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerReply>);
  }
}

function makeVideo(videoWidth: number) {
  let callback: ((now: number) => void) | undefined;
  return {
    videoWidth,
    readyState: 2,
    requestVideoFrameCallback: (next: (now: number) => void) => { callback = next; return 1; },
    cancelVideoFrameCallback: () => { callback = undefined; },
    async fireFrame(now: number) {
      callback?.(now);
      await Promise.resolve();
      await Promise.resolve();
    },
  } as unknown as HTMLVideoElement & { fireFrame(now: number): Promise<void> };
}

describe('PoseClient frame size', () => {
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
  const createBitmap = vi.fn(async () => bitmap);

  beforeEach(() => {
    createBitmap.mockClear();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', createBitmap);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function start(videoWidth: number, delegate: 'GPU' | 'CPU' = 'GPU') {
    const client = new PoseClient({ wasmBaseUrl: '/wasm', modelUrl: '/pose.task' });
    const callbacks = { onPose: vi.fn(), onStatus: vi.fn() };
    await client.init(callbacks, delegate);
    const video = makeVideo(videoWidth);
    client.beginCapture(video, callbacks);
    return { client, callbacks, video, worker: FakeWorker.instance! };
  }

  it('downscales video wider than 640 before inference', async () => {
    const { client, video, worker } = await start(1280, 'CPU');
    await video.fireFrame(10);

    expect(createBitmap).toHaveBeenCalledWith(video, { resizeWidth: 640, resizeQuality: 'medium' });
    expect(worker.transfers.at(-1)).toEqual([bitmap]);
    client.dispose();
  });
});
