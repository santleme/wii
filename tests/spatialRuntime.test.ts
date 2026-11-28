import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Delegate,
  HandClientCallbacks,
  HandSnapshot,
  PoseProviderCallbacks,
  PoseSnapshot,
  WorkerReply,
  WorkerRequest,
} from '@wii/spatial-core';
import { SpatialRuntime } from '@wii/spatial-core';
import type { HandProviderClient, PoseProviderClient, SpatialObservation } from '@wii/spatial-core';
import { pose } from './fixtures/syntheticPose';
import { handSnapshot } from './fixtures/syntheticHand';

class ReadyPoseWorker {
  static instance: ReadyPoseWorker | undefined;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: WorkerRequest[] = [];
  terminated = false;

  constructor(_url: URL, _options: WorkerOptions) {
    ReadyPoseWorker.instance = this;
  }

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
    if (message.type === 'INIT') {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'READY', delegate: message.delegate } } as MessageEvent<WorkerReply>));
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeVideo(): HTMLVideoElement & { fireFrame(now: number): void } {
  let nextId = 0;
  let callback: ((now: number, metadata: VideoFrameCallbackMetadata) => void) | undefined;
  return {
    readyState: 2,
    currentTime: 0,
    requestVideoFrameCallback: (next: (now: number, metadata: VideoFrameCallbackMetadata) => void) => {
      callback = next;
      return ++nextId;
    },
    cancelVideoFrameCallback: () => {
      callback = undefined;
    },
    fireFrame(now: number) {
      const current = callback;
      callback = undefined;
      current?.(now, {} as VideoFrameCallbackMetadata);
    },
  } as unknown as HTMLVideoElement & { fireFrame(now: number): void };
}

class FakeHandClient implements HandProviderClient {
  isReady = false;
  disposeCount = 0;
  private disposed = false;
  readonly frames: { bitmap: ImageBitmap; timestampMs: number }[] = [];
  initialize?: Promise<void>;
  frameResult: Promise<HandSnapshot | undefined> = Promise.resolve(undefined);
  throwOnProcessFrame = false;

  async init(callbacks: HandClientCallbacks, _preferred?: Delegate): Promise<void> {
    callbacks.onStatus('loading', 'hand loading');
    await this.initialize;
    if (this.disposed) return;
    this.isReady = true;
    callbacks.onStatus('ready', 'hand ready');
  }

  processFrame(bitmap: ImageBitmap, timestampMs: number): Promise<HandSnapshot | undefined> {
    this.frames.push({ bitmap, timestampMs });
    if (this.throwOnProcessFrame) throw new Error('adapter failed before accepting the frame');
    return this.frameResult;
  }

  dispose(): void {
    this.disposeCount += 1;
    this.disposed = true;
    this.isReady = false;
  }
}

class CapturingHandClient extends FakeHandClient {
  beginCount = 0;
  captureVideo?: HTMLVideoElement;
  private onHand?: (snapshot: HandSnapshot, aspectY: number) => void;

  beginCapture(
    video: HTMLVideoElement,
    onHand: (snapshot: HandSnapshot, aspectY: number) => void,
    _onError?: (error: Error) => void,
  ): void {
    this.beginCount += 1;
    this.captureVideo = video;
    this.onHand = onHand;
  }

  emitHand(snapshot: HandSnapshot, aspectY: number): void {
    this.onHand?.(snapshot, aspectY);
  }
}

class FakePoseClient implements PoseProviderClient {
  isReady = false;
  beginCount = 0;
  pauseCount = 0;
  disposeCount = 0;
  private callbacks?: PoseProviderCallbacks;

  async init(callbacks: PoseProviderCallbacks, _preferred?: Delegate): Promise<void> {
    this.isReady = true;
    callbacks.onStatus('ready', 'pose ready');
  }

  beginCapture(_video: HTMLVideoElement, callbacks: PoseProviderCallbacks): void {
    this.beginCount += 1;
    this.callbacks = callbacks;
  }

  pauseCapture(): void {
    this.pauseCount += 1;
  }

  dispose(): void {
    this.disposeCount += 1;
    this.isReady = false;
  }

  emitPose(snapshot: PoseSnapshot): void {
    this.callbacks?.onPose(snapshot);
  }
}

function makeRuntime(
  video: HTMLVideoElement,
  createHandClient: () => FakeHandClient,
  createPoseClient: () => FakePoseClient,
  onObservation = vi.fn<(observation: SpatialObservation) => void>(),
  onStatus = vi.fn(),
) {
  const runtime = new SpatialRuntime({
    video,
    handAssets: { wasmBaseUrl: '/vision-wasm', modelUrl: '/hand.task' },
    createHandClient,
    createPoseClient,
    onObservation,
    onStatus,
  });
  return { runtime, onObservation, onStatus };
}

async function flushAsyncFrame(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SpatialRuntime context switching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    ReadyPoseWorker.instance = undefined;
  });

  it('requires a pose provider adapter instead of importing the application pose client', async () => {
    const onStatus = vi.fn();
    const runtime = new SpatialRuntime({
      video: makeVideo(),
      handAssets: { wasmBaseUrl: '/vision-wasm', modelUrl: '/hand.task' },
      onObservation: vi.fn(),
      onStatus,
    });

    await expect(runtime.activate('pose')).resolves.toBe(false);
    expect(onStatus).toHaveBeenCalledWith(
      'pose',
      'error',
      'A pose provider adapter must be supplied to activate the pose context.',
    );
    expect(runtime.activeContext).toBeUndefined();
  });

  it('creates the package PoseClient from injected assets when no adapter is supplied', async () => {
    vi.stubGlobal('Worker', ReadyPoseWorker);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const runtime = new SpatialRuntime({
      video: makeVideo(),
      handAssets: { wasmBaseUrl: '/vision-wasm', modelUrl: '/hand.task' },
      poseAssets: { wasmBaseUrl: '/pose-wasm', modelUrl: '/pose.task' },
      onObservation: vi.fn(),
      onStatus: vi.fn(),
    });

    await expect(runtime.activate('pose')).resolves.toBe(true);
    expect(runtime.activeContext).toBe('pose');
    expect(ReadyPoseWorker.instance?.sent[0]).toMatchObject({
      type: 'INIT',
      wasmBaseUrl: '/pose-wasm',
      modelUrl: '/pose.task',
    });

    runtime.dispose();
    expect(ReadyPoseWorker.instance?.terminated).toBe(true);
  });

  it('uses a hand provider live-capture API when the provider owns its scheduler', async () => {
    const video = makeVideo();
    const hand = new CapturingHandClient();
    const poseClient = new FakePoseClient();
    const { runtime, onObservation } = makeRuntime(video, () => hand, () => poseClient);

    await expect(runtime.activate('hand')).resolves.toBe(true);

    expect(hand.beginCount).toBe(1);
    expect(hand.captureVideo).toBe(video);
    expect(hand.frames).toEqual([]);

    hand.emitHand(handSnapshot(12), 0.75);
    expect(onObservation).toHaveBeenCalledWith({ source: 'hand', snapshot: handSnapshot(12) });

    runtime.dispose();
    expect(hand.disposeCount).toBe(1);
  });

  it('deduplicates same-context activation and disposes a stale provider after a slower init resolves', async () => {
    const handInitialization = deferred<void>();
    const hand = new FakeHandClient();
    hand.initialize = handInitialization.promise;
    const poseClient = new FakePoseClient();
    const { runtime, onObservation } = makeRuntime(
      makeVideo(),
      () => hand,
      () => poseClient,
    );

    const handActivation = runtime.activate('hand');
    expect(runtime.activate('hand')).toBe(handActivation);
    const poseActivation = runtime.activate('pose');
    await expect(poseActivation).resolves.toBe(true);
    expect(runtime.activeContext).toBe('pose');
    expect(hand.disposeCount).toBe(1);
    expect(poseClient.beginCount).toBe(1);

    handInitialization.resolve();
    await expect(handActivation).resolves.toBe(false);
    expect(hand.disposeCount).toBe(1);
    expect(runtime.activeContext).toBe('pose');
    poseClient.emitPose(pose(10));
    expect(onObservation).toHaveBeenCalledWith({ source: 'pose', snapshot: pose(10) });

    runtime.deactivate();
    expect(poseClient.pauseCount).toBe(1);
    expect(poseClient.disposeCount).toBe(1);
    expect(runtime.activeContext).toBeUndefined();
  });

  it('cleans up a client when a loading callback reentrantly switches context', async () => {
    const hand = new FakeHandClient();
    const poseClient = new FakePoseClient();
    let runtime: SpatialRuntime;
    let poseActivation: Promise<boolean> | undefined;
    const onStatus = vi.fn((context: string, status: string) => {
      if (context === 'hand' && status === 'loading') poseActivation = runtime.activate('pose');
    });
    runtime = makeRuntime(
      makeVideo(),
      () => hand,
      () => poseClient,
      undefined,
      onStatus,
    ).runtime;

    await expect(runtime.activate('hand')).resolves.toBe(false);
    await expect(poseActivation).resolves.toBe(true);
    expect(hand.disposeCount).toBe(2);
    expect(runtime.activeContext).toBe('pose');
    runtime.dispose();
  });

  it('closes a bitmap created after the hand context was replaced', async () => {
    const video = makeVideo();
    const hand = new FakeHandClient();
    const poseClient = new FakePoseClient();
    const { runtime, onObservation } = makeRuntime(
      video,
      () => hand,
      () => poseClient,
    );
    const bitmapReady = deferred<ImageBitmap>();
    const createImageBitmapMock = vi.fn(() => bitmapReady.promise);
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    await runtime.activate('hand');
    video.fireFrame(10);
    await Promise.resolve();
    await runtime.activate('pose');
    const lateBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    bitmapReady.resolve(lateBitmap);
    await flushAsyncFrame();

    expect(lateBitmap.close).toHaveBeenCalledOnce();
    expect(hand.frames).toEqual([]);
    expect(onObservation).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('closes a bitmap when a processFrame adapter throws before taking ownership', async () => {
    const video = makeVideo();
    const hand = new FakeHandClient();
    hand.throwOnProcessFrame = true;
    const poseClient = new FakePoseClient();
    const { runtime, onStatus } = makeRuntime(video, () => hand, () => poseClient);
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const createImageBitmapMock = vi.fn(async () => bitmap);
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    await runtime.activate('hand');
    video.fireFrame(10);
    await flushAsyncFrame();

    expect(hand.frames).toHaveLength(1);
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenCalledWith(
      'hand',
      'error',
      'adapter failed before accepting the frame',
    );
    runtime.dispose();
  });

  it('drops a hand result that arrives after switching to pose', async () => {
    const video = makeVideo();
    const hand = new FakeHandClient();
    const poseClient = new FakePoseClient();
    const { runtime, onObservation } = makeRuntime(
      video,
      () => hand,
      () => poseClient,
    );
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const createImageBitmapMock = vi.fn(async () => bitmap);
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
    const pendingResult = deferred<HandSnapshot | undefined>();
    hand.frameResult = pendingResult.promise;

    await runtime.activate('hand');
    video.fireFrame(10);
    await flushAsyncFrame();
    expect(hand.frames).toHaveLength(1);
    await runtime.activate('pose');
    pendingResult.resolve(handSnapshot(10));
    await flushAsyncFrame();

    expect(onObservation).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('starts a fresh legacy-adapter pump when a new hand provider replaces pending work', async () => {
    const video = makeVideo();
    const firstHand = new FakeHandClient();
    const pendingOldResult = deferred<HandSnapshot | undefined>();
    firstHand.frameResult = pendingOldResult.promise;
    const secondHand = new FakeHandClient();
    const newSnapshot = handSnapshot(20);
    secondHand.frameResult = Promise.resolve(newSnapshot);
    const clients = [firstHand, secondHand];
    const poseClient = new FakePoseClient();
    const { runtime, onObservation } = makeRuntime(
      video,
      () => clients.shift()!,
      () => poseClient,
    );
    const bitmaps = [
      { close: vi.fn() } as unknown as ImageBitmap,
      { close: vi.fn() } as unknown as ImageBitmap,
    ];
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmaps.shift()!));

    await runtime.activate('hand');
    video.fireFrame(10);
    await flushAsyncFrame();
    expect(firstHand.frames).toHaveLength(1);

    await runtime.activate('pose');
    await runtime.activate('hand');
    video.fireFrame(20);
    await flushAsyncFrame();

    expect(secondHand.frames).toHaveLength(1);
    expect(onObservation).toHaveBeenCalledWith({ source: 'hand', snapshot: newSnapshot });

    pendingOldResult.resolve(handSnapshot(10));
    await flushAsyncFrame();
    expect(onObservation).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });
});
