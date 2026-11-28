import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandWorkerReply, HandWorkerRequest } from '@wii/spatial-core';
import { HandClient } from '../src/cv/handClient';
import { handSnapshot } from './fixtures/syntheticHand';

class FakeWorker {
  static instance: FakeWorker | undefined;
  onmessage: ((event: MessageEvent<HandWorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: HandWorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];

  constructor(_url: URL, _options: WorkerOptions) {
    FakeWorker.instance = this;
  }

  postMessage(message: HandWorkerRequest, transfer: Transferable[] = []): void {
    this.sent.push(message);
    this.transfers.push(transfer);
    if (message.type === 'INIT') {
      queueMicrotask(() => this.reply({ type: 'READY', delegate: message.delegate }));
    }
  }

  terminate(): void {}

  reply(message: HandWorkerReply): void {
    this.onmessage?.({ data: message } as MessageEvent<HandWorkerReply>);
  }
}

function makeVideo(): HTMLVideoElement & { fireFrame(now: number): void } {
  let nextId = 0;
  let callback: ((now: number, metadata: VideoFrameCallbackMetadata) => void) | undefined;
  return {
    readyState: HTMLMediaElement.HAVE_CURRENT_DATA,
    currentTime: 0,
    videoWidth: 640,
    videoHeight: 480,
    requestVideoFrameCallback: (nextCallback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => {
      callback = nextCallback;
      return ++nextId;
    },
    cancelVideoFrameCallback: () => {
      callback = undefined;
    },
    fireFrame(now: number) {
      const frameCallback = callback;
      callback = undefined;
      frameCallback?.(now, {} as VideoFrameCallbackMetadata);
    },
  } as unknown as HTMLVideoElement & { fireFrame(now: number): void };
}

function makeClient(): HandClient {
  return new HandClient({ wasmBaseUrl: '/mediapipe/wasm', modelUrl: '/mediapipe/hand.task' });
}

async function flushCapture(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function stubBrowser(): void {
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
  });
}

describe('HandClient capture loop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeWorker.instance = undefined;
  });

  it('captures resized video frame callbacks and publishes snapshots with aspectY', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const createImageBitmapMock = vi.fn(async () => bitmap);
    stubBrowser();
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const client = makeClient();
    await client.init({ onStatus: vi.fn() }, 'GPU');
    const worker = FakeWorker.instance!;
    const video = makeVideo();
    const onHand = vi.fn();
    const onError = vi.fn();
    client.beginCapture(video, onHand, onError);

    video.fireFrame(10);
    await flushCapture();

    expect(createImageBitmapMock).toHaveBeenCalledWith(video, { resizeWidth: 640, resizeQuality: 'low' });
    const frame = worker.sent.find((message) => message.type === 'FRAME');
    if (frame?.type !== 'FRAME') throw new Error('Expected a hand frame');
    expect(worker.transfers.at(-1)).toEqual([bitmap]);

    const expected = handSnapshot(frame.timestampMs);
    worker.reply({ type: 'HAND', requestId: frame.requestId, timestampMs: frame.timestampMs, hands: expected.hands });
    await flushCapture();

    expect(onHand).toHaveBeenCalledWith(expected, 0.75);
    expect(onError).not.toHaveBeenCalled();
    client.dispose();
  });

  it('sends a VideoFrame without a bitmap copy when the video already fits the delegate', async () => {
    const createImageBitmapMock = vi.fn();
    const frames: { close: () => void; init: VideoFrameInit }[] = [];
    stubBrowser();
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
    vi.stubGlobal(
      'VideoFrame',
      class {
        close = vi.fn();
        constructor(_video: unknown, readonly init: VideoFrameInit) {
          frames.push(this);
        }
      },
    );

    const client = makeClient();
    await client.init({ onStatus: vi.fn() }, 'GPU');
    const worker = FakeWorker.instance!;
    const video = makeVideo();
    client.beginCapture(video, vi.fn());
    video.fireFrame(10);

    expect(createImageBitmapMock).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.init.timestamp).toBe(10_000);
    expect(worker.transfers.at(-1)).toEqual([frames[0]]);
    client.dispose();
  });

  it('downscales to a quarter of the pixels once the worker is on CPU', async () => {
    const createImageBitmapMock = vi.fn(async () => ({ close: vi.fn() }) as unknown as ImageBitmap);
    const videoFrame = vi.fn();
    stubBrowser();
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
    vi.stubGlobal('VideoFrame', videoFrame);

    const client = makeClient();
    await client.init({ onStatus: vi.fn() }, 'GPU');
    FakeWorker.instance!.reply({ type: 'FALLBACK', from: 'GPU', to: 'CPU', reason: 'slow' });
    const video = makeVideo();
    client.beginCapture(video, vi.fn());
    video.fireFrame(10);
    await flushCapture();

    expect(videoFrame).not.toHaveBeenCalled();
    expect(createImageBitmapMock).toHaveBeenCalledWith(video, { resizeWidth: 320, resizeQuality: 'low' });
    client.dispose();
  });

  it('closes a stale bitmap and keeps backpressure across a capture restart', async () => {
    const resolveBitmaps: ((value: ImageBitmap) => void)[] = [];
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const nextBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    let copies = 0;
    stubBrowser();
    vi.stubGlobal('createImageBitmap', () => {
      copies += 1;
      return new Promise<ImageBitmap>((resolve) => {
        resolveBitmaps.push(resolve);
      });
    });

    const client = makeClient();
    await client.init({ onStatus: vi.fn() }, 'GPU');
    const worker = FakeWorker.instance!;
    const video = makeVideo();
    client.beginCapture(video, vi.fn());

    video.fireFrame(10);
    client.pauseCapture();
    client.beginCapture(video, vi.fn());
    video.fireFrame(20);
    expect(copies).toBe(1);

    resolveBitmaps[0]?.(bitmap);
    await flushCapture();

    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(0);

    video.fireFrame(30);
    expect(copies).toBe(2);
    resolveBitmaps[1]?.(nextBitmap);
    await flushCapture();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(1);
    client.dispose();
  });

  it('reports a bitmap copy failure and releases backpressure for the next frame', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    let copies = 0;
    stubBrowser();
    vi.stubGlobal('createImageBitmap', vi.fn(() => {
      copies += 1;
      return copies === 1 ? Promise.reject(new Error('bitmap copy failed')) : Promise.resolve(bitmap);
    }));

    const client = makeClient();
    await client.init({ onStatus: vi.fn() }, 'GPU');
    const worker = FakeWorker.instance!;
    const video = makeVideo();
    const onError = vi.fn();
    client.beginCapture(video, vi.fn(), onError);

    video.fireFrame(10);
    await flushCapture();
    expect(onError).toHaveBeenCalledWith(new Error('bitmap copy failed'));
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(0);

    video.fireFrame(20);
    await flushCapture();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(1);
    client.dispose();
  });

  it('falls back to animation frames and deduplicates unchanged video times', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const createImageBitmapMock = vi.fn(async () => bitmap);
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      },
      cancelAnimationFrame: vi.fn(),
    });
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const client = makeClient();
    await client.init({ onStatus: vi.fn() }, 'GPU');
    const worker = FakeWorker.instance!;
    const video = {
      readyState: HTMLMediaElement.HAVE_CURRENT_DATA,
      currentTime: 1,
      videoWidth: 640,
      videoHeight: 480,
    } as HTMLVideoElement;
    client.beginCapture(video, vi.fn());
    expect(rafCallbacks).toHaveLength(1);

    rafCallbacks.shift()?.(16);
    await flushCapture();
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    const firstFrame = worker.sent.find((message) => message.type === 'FRAME');
    if (firstFrame?.type !== 'FRAME') throw new Error('Expected a hand frame');
    worker.reply({ type: 'HAND', requestId: firstFrame.requestId, timestampMs: firstFrame.timestampMs, hands: [] });
    await flushCapture();

    rafCallbacks.shift()?.(32);
    await flushCapture();
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);

    video.currentTime = 2;
    rafCallbacks.shift()?.(48);
    await flushCapture();
    expect(createImageBitmapMock).toHaveBeenCalledTimes(2);
    client.dispose();
  });
});
