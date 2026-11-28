import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Point3, WorkerReply, WorkerRequest } from '../src/cv/protocol';
import { PoseClient } from '../src/cv/poseClient';

class FakeWorker {
  static instance: FakeWorker | undefined;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: WorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  throwOnNextFrame = false;
  terminated = false;

  constructor(_url: URL, _options: WorkerOptions) { FakeWorker.instance = this; }

  postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
    if (message.type === 'FRAME' && this.throwOnNextFrame) {
      this.throwOnNextFrame = false;
      throw new Error('DataCloneError');
    }
    this.sent.push(message);
    this.transfers.push(transfer);
    if (message.type === 'INIT') {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'READY', delegate: message.delegate } } as MessageEvent<WorkerReply>));
    }
  }

  terminate(): void { this.terminated = true; }

  reply(message: WorkerReply): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerReply>);
  }
}

function makeVideo(): HTMLVideoElement & { fireFrame(now: number): void } {
  let nextId = 0;
  let callback: ((now: number, metadata: VideoFrameCallbackMetadata) => void) | undefined;
  return {
    readyState: HTMLMediaElement.HAVE_CURRENT_DATA,
    requestVideoFrameCallback: (nextCallback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => {
      callback = nextCallback;
      return ++nextId;
    },
    cancelVideoFrameCallback: () => { callback = undefined; },
    fireFrame(now: number) {
      const frameCallback = callback;
      callback = undefined;
      frameCallback?.(now, {} as VideoFrameCallbackMetadata);
    },
  } as unknown as HTMLVideoElement & { fireFrame(now: number): void };
}

function visibleLandmarks(): Point3[] {
  return Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1 }));
}

async function flushCapture(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PoseClient capture sessions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeWorker.instance = undefined;
  });

  it('does not start the frame scheduler if a ready callback pauses reentrantly', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    const createImageBitmapMock = vi.fn(async () => bitmap);
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    const client = new PoseClient();
    const onStatus = vi.fn((_status: string, detail: string) => {
      if (detail.endsWith('capturando')) client.pauseCapture();
    });
    await client.init({ onPose: vi.fn(), onStatus });
    const worker = FakeWorker.instance!;
    const video = makeVideo();

    client.beginCapture(video, { onPose: vi.fn(), onStatus });
    video.fireFrame(10);
    await flushCapture();

    expect(createImageBitmapMock).not.toHaveBeenCalled();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(0);
    client.dispose();
  });

  it('disposes the pose worker on a late fatal error while a newer frame is in flight', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));

    const client = new PoseClient();
    const onPose = vi.fn();
    const onStatus = vi.fn();
    await client.init({ onPose, onStatus });
    const worker = FakeWorker.instance!;
    const video = makeVideo();
    client.beginCapture(video, { onPose, onStatus });

    video.fireFrame(10);
    await flushCapture();
    const frame = worker.sent.find((message) => message.type === 'FRAME');
    if (frame?.type !== 'FRAME') throw new Error('Expected a pose frame');

    worker.reply({
      type: 'POSE',
      requestId: frame.requestId,
      captureEpoch: frame.captureEpoch,
      timestampMs: frame.timestampMs,
      landmarks: visibleLandmarks(),
      worldLandmarks: visibleLandmarks(),
      frameWidth: 640,
      frameHeight: 480,
    });
    await flushCapture();
    expect(onPose).toHaveBeenCalledOnce();

    video.fireFrame(20);
    await flushCapture();
    const currentFrame = worker.sent.filter((message) => message.type === 'FRAME').at(-1);
    if (currentFrame?.type !== 'FRAME') throw new Error('Expected a newer pose frame');
    expect(currentFrame.requestId).toBeGreaterThan(frame.requestId);

    worker.reply({
      type: 'ERROR',
      stage: 'detect',
      fatal: true,
      requestId: frame.requestId,
      captureEpoch: frame.captureEpoch,
      message: 'CPU fallback failed after the pose result.',
    });

    expect(onStatus).toHaveBeenCalledWith('error', 'CPU fallback failed after the pose result.');
    expect(client.isReady).toBe(false);
    expect(worker.terminated).toBe(true);
  });

  it('discards an old pose after restart and releases backpressure for the new session', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));

    const client = new PoseClient();
    const oldOnPose = vi.fn();
    const newOnPose = vi.fn();
    const onStatus = vi.fn();
    await client.init({ onPose: oldOnPose, onStatus });
    const worker = FakeWorker.instance!;
    const video = makeVideo();

    client.beginCapture(video, { onPose: oldOnPose, onStatus });
    video.fireFrame(10);
    await flushCapture();
    const oldFrame = worker.sent.find((message) => message.type === 'FRAME');
    expect(oldFrame?.type).toBe('FRAME');
    if (oldFrame?.type !== 'FRAME') throw new Error('Expected an old-session frame');
    video.fireFrame(15);
    await flushCapture();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(1);

    client.pauseCapture();
    client.beginCapture(video, { onPose: newOnPose, onStatus });
    worker.reply({
      type: 'POSE',
      frameWidth: 1280,
      frameHeight: 720,
      requestId: oldFrame.requestId,
      captureEpoch: oldFrame.captureEpoch,
      timestampMs: 10,
      landmarks: visibleLandmarks(),
      worldLandmarks: visibleLandmarks(),
    });
    await flushCapture();

    expect(oldOnPose).not.toHaveBeenCalled();
    expect(newOnPose).not.toHaveBeenCalled();

    video.fireFrame(20);
    await flushCapture();
    const frames = worker.sent.filter((message) => message.type === 'FRAME');
    const newFrame = frames.at(-1);
    expect(newFrame?.type).toBe('FRAME');
    if (newFrame?.type !== 'FRAME') throw new Error('Expected a new-session frame');
    expect(newFrame.captureEpoch).toBeGreaterThan(oldFrame.captureEpoch);
    expect(newFrame.requestId).toBeGreaterThan(oldFrame.requestId);
    expect(worker.transfers.at(-1)).toEqual([bitmap]);

    const poseReply = {
      type: 'POSE' as const,
      requestId: newFrame.requestId,
      captureEpoch: newFrame.captureEpoch,
      timestampMs: 20,
      landmarks: visibleLandmarks(),
      worldLandmarks: visibleLandmarks(),
      frameWidth: 1280,
      frameHeight: 720,
    };
    worker.reply({ ...poseReply, requestId: poseReply.requestId + 1 });
    expect(newOnPose).not.toHaveBeenCalled();
    worker.reply(poseReply);
    worker.reply(poseReply);
    expect(newOnPose).toHaveBeenCalledOnce();
    expect(newOnPose).toHaveBeenCalledWith({
      timestampMs: 20,
      landmarks: visibleLandmarks(),
      worldLandmarks: visibleLandmarks(),
      trackingState: 'degraded',
      bodyConfidence: 1,
      frameWidth: 1280,
      frameHeight: 720,
    });

    client.dispose();
  });

  it('reports a fatal fallback failure after the triggering pose has already released the frame', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));

    const client = new PoseClient();
    const callbacks = { onPose: vi.fn(), onStatus: vi.fn() };
    await client.init(callbacks);
    const worker = FakeWorker.instance!;
    const video = makeVideo();
    client.beginCapture(video, callbacks);
    video.fireFrame(10);
    await flushCapture();
    const frame = worker.sent.find((message) => message.type === 'FRAME')!;
    const request = { requestId: frame.requestId, captureEpoch: frame.captureEpoch };
    worker.reply({ type: 'POSE', ...request, timestampMs: 10, landmarks: [], worldLandmarks: [], frameWidth: 640, frameHeight: 480 });
    expect(callbacks.onPose).toHaveBeenCalledOnce();

    worker.reply({ type: 'ERROR', stage: 'detect', fatal: true, ...request, message: 'CPU initialization failed' });
    expect(callbacks.onStatus).toHaveBeenLastCalledWith('error', 'CPU initialization failed');
    expect(client.isReady).toBe(false);
  });

  it('releases the pending frame on a non-fatal error from the old session without notifying the new one', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));

    const client = new PoseClient();
    const onStatus = vi.fn();
    await client.init({ onPose: vi.fn(), onStatus });
    const worker = FakeWorker.instance!;
    const video = makeVideo();

    client.beginCapture(video, { onPose: vi.fn(), onStatus });
    video.fireFrame(10);
    await flushCapture();
    const oldFrame = worker.sent.find((message) => message.type === 'FRAME');
    if (oldFrame?.type !== 'FRAME') throw new Error('Expected an old-session frame');

    client.pauseCapture();
    client.beginCapture(video, { onPose: vi.fn(), onStatus });
    onStatus.mockClear();
    video.fireFrame(15);
    await flushCapture();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(1);

    worker.reply({
      type: 'ERROR', stage: 'detect', fatal: false,
      requestId: oldFrame.requestId, captureEpoch: oldFrame.captureEpoch,
      message: 'GPU falhou; próxima captura será processada em CPU.',
    });
    await flushCapture();
    expect(onStatus).not.toHaveBeenCalled();

    video.fireFrame(20);
    await flushCapture();
    const newFrame = worker.sent.filter((message) => message.type === 'FRAME').at(-1);
    if (newFrame?.type !== 'FRAME') throw new Error('Expected a new-session frame');
    expect(newFrame.captureEpoch).toBeGreaterThan(oldFrame.captureEpoch);

    worker.reply({
      type: 'ERROR', stage: 'detect', fatal: false,
      requestId: newFrame.requestId + 1, captureEpoch: newFrame.captureEpoch,
      message: 'Erro de outro quadro.',
    });
    video.fireFrame(25);
    await flushCapture();
    expect(onStatus).not.toHaveBeenCalled();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(2);

    worker.reply({
      type: 'ERROR', stage: 'detect', fatal: false,
      requestId: newFrame.requestId, captureEpoch: newFrame.captureEpoch,
      message: 'GPU falhou; próxima captura será processada em CPU.',
    });
    await flushCapture();
    expect(onStatus).toHaveBeenCalledWith('fallback', 'GPU falhou; próxima captura será processada em CPU.');
    video.fireFrame(30);
    await flushCapture();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(3);

    client.dispose();
  });

  it('closes a bitmap created for a session that ended before the async copy finished', async () => {
    let resolveBitmap: ((value: ImageBitmap) => void) | undefined;
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', () => new Promise<ImageBitmap>((resolve) => { resolveBitmap = resolve; }));

    const client = new PoseClient();
    const onPose = vi.fn();
    const onStatus = vi.fn();
    await client.init({ onPose, onStatus });
    const worker = FakeWorker.instance!;
    const video = makeVideo();

    client.beginCapture(video, { onPose, onStatus });
    video.fireFrame(10);
    client.pauseCapture();
    client.beginCapture(video, { onPose, onStatus });
    resolveBitmap?.(bitmap);
    await flushCapture();

    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(0);

    client.dispose();
  });

  it('closes a bitmap if postMessage fails before transferring ownership', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));

    const client = new PoseClient();
    const onStatus = vi.fn();
    await client.init({ onPose: vi.fn(), onStatus });
    const worker = FakeWorker.instance!;
    const video = makeVideo();
    worker.throwOnNextFrame = true;

    client.beginCapture(video, { onPose: vi.fn(), onStatus });
    video.fireFrame(10);
    await flushCapture();

    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(0);

    client.dispose();
  });

  it('releases backpressure after an ImageBitmap copy rejects', async () => {
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    let copies = 0;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('HTMLMediaElement', { HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal('createImageBitmap', vi.fn(() => {
      copies += 1;
      return copies === 1 ? Promise.reject(new Error('bitmap copy failed')) : Promise.resolve(bitmap);
    }));

    const client = new PoseClient();
    const onStatus = vi.fn();
    await client.init({ onPose: vi.fn(), onStatus });
    const worker = FakeWorker.instance!;
    const video = makeVideo();
    client.beginCapture(video, { onPose: vi.fn(), onStatus });
    video.fireFrame(10);
    await flushCapture();

    expect(onStatus).toHaveBeenCalledWith('error', 'bitmap copy failed');
    video.fireFrame(20);
    await flushCapture();
    expect(worker.sent.filter((message) => message.type === 'FRAME')).toHaveLength(1);

    client.dispose();
  });
});
