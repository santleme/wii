import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoseWorkerSession } from '../scripts/poseReplaySession';
import type { WorkerReply, WorkerRequest } from '@wii/spatial-core';

class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: WorkerRequest[] = [];

  postMessage(message: WorkerRequest, _transfer?: Transferable[]): void {
    this.messages.push(message);
  }

  terminate(): void {}

  emit(data: WorkerReply): void {
    this.onmessage?.({ data } as MessageEvent<WorkerReply>);
  }
}

describe('pose replay worker session', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the CPU fallback model to the worker when one is provided', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const worker = new FakeWorker();
    const session = new PoseWorkerSession(worker as unknown as Worker, 'GPU');
    const initialization = session.initialize('/wasm', '/pose-full.task', '/pose-lite.task');
    worker.emit({ type: 'READY', delegate: 'GPU' });
    await initialization;

    expect(worker.messages[0]).toMatchObject({
      type: 'INIT',
      modelUrl: '/pose-full.task',
      cpuModelUrl: '/pose-lite.task',
    });
  });

  it('records a recoverable GPU fallback as a dropped sample and continues on CPU', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const worker = new FakeWorker();
    const session = new PoseWorkerSession(worker as unknown as Worker, 'GPU');
    const initialization = session.initialize('/wasm', '/pose.task');
    worker.emit({ type: 'READY', delegate: 'GPU' });
    await expect(initialization).resolves.toBe('GPU');

    const firstSample = session.detect({ close: vi.fn() } as unknown as ImageBitmap, 0);
    const firstFrame = worker.messages.filter((message) => message.type === 'FRAME').at(-1);
    expect(firstFrame?.type).toBe('FRAME');
    if (firstFrame?.type !== 'FRAME') throw new Error('Expected a frame request.');
    worker.emit({ type: 'FALLBACK', from: 'GPU', to: 'CPU', reason: 'GPU context lost' });
    worker.emit({
      type: 'ERROR', stage: 'detect', fatal: false, requestId: firstFrame.requestId,
      captureEpoch: firstFrame.captureEpoch, message: 'GPU failed; next frame will use CPU.',
    });
    await expect(firstSample).resolves.toBeUndefined();
    expect(session.delegate).toBe('CPU');
    expect(session.hasMixedConfigurationSamples).toBe(false);

    const nextSample = session.detect({ close: vi.fn() } as unknown as ImageBitmap, 100);
    const nextFrame = worker.messages.filter((message) => message.type === 'FRAME').at(-1);
    expect(nextFrame?.type).toBe('FRAME');
    if (nextFrame?.type !== 'FRAME') throw new Error('Expected a frame request.');
    const poseReply: WorkerReply = {
      type: 'POSE', requestId: nextFrame.requestId, captureEpoch: nextFrame.captureEpoch,
      timestampMs: 100, landmarks: [], worldLandmarks: [], frameWidth: 1280, frameHeight: 720,
    };
    worker.emit(poseReply);
    await expect(nextSample).resolves.toEqual(poseReply);
  });

  it('marks samples spanning both sides of a fallback as a mixed-configuration run', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const worker = new FakeWorker();
    const session = new PoseWorkerSession(worker as unknown as Worker, 'GPU');
    const initialization = session.initialize('/wasm', '/pose-full.task', '/pose-lite.task');
    worker.emit({ type: 'READY', delegate: 'GPU' });
    await initialization;

    const emitSample = async (timestampMs: number) => {
      const sample = session.detect({ close: vi.fn() } as unknown as ImageBitmap, timestampMs);
      const frame = worker.messages.filter((message) => message.type === 'FRAME').at(-1);
      if (frame?.type !== 'FRAME') throw new Error('Expected a frame request.');
      worker.emit({
        type: 'POSE', requestId: frame.requestId, captureEpoch: frame.captureEpoch,
        timestampMs, landmarks: [], worldLandmarks: [], frameWidth: 640, frameHeight: 360,
      });
      await expect(sample).resolves.toBeDefined();
    };

    // The latency-fallback sequence: successful GPU replies arrive before the fallback notice.
    for (const timestampMs of [0, 33, 66, 100, 133]) await emitSample(timestampMs);
    expect(session.hasMixedConfigurationSamples).toBe(false);
    expect(() => session.assertSingleConfigurationRun()).not.toThrow();

    worker.emit({ type: 'FALLBACK', from: 'GPU', to: 'CPU', reason: 'GPU slow' });
    await emitSample(166);
    expect(session.hasMixedConfigurationSamples).toBe(true);
    expect(session.sampledDelegate).toBeUndefined();
    expect(() => session.assertSingleConfigurationRun()).toThrow(/mixed-configuration replay/);
  });

  it('keeps a fallback without later samples a pure primary-delegate run', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const worker = new FakeWorker();
    const session = new PoseWorkerSession(worker as unknown as Worker, 'GPU');
    const initialization = session.initialize('/wasm', '/pose-full.task', '/pose-lite.task');
    worker.emit({ type: 'READY', delegate: 'GPU' });
    await initialization;

    const sample = session.detect({ close: vi.fn() } as unknown as ImageBitmap, 0);
    const frame = worker.messages.filter((message) => message.type === 'FRAME').at(-1);
    if (frame?.type !== 'FRAME') throw new Error('Expected a frame request.');
    worker.emit({
      type: 'POSE', requestId: frame.requestId, captureEpoch: frame.captureEpoch,
      timestampMs: 0, landmarks: [], worldLandmarks: [], frameWidth: 640, frameHeight: 360,
    });
    await expect(sample).resolves.toBeDefined();

    // GPU fails on the final frame: it is dropped after the switch and no CPU sample is ever collected.
    worker.emit({ type: 'FALLBACK', from: 'GPU', to: 'CPU', reason: 'GPU failed' });
    expect(session.delegate).toBe('CPU');
    expect(session.sampledDelegate).toBe('GPU');
    expect(session.hasMixedConfigurationSamples).toBe(false);
    expect(() => session.assertSingleConfigurationRun()).not.toThrow();
  });

  it('rejects a frame when CPU inference fails after fallback', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const worker = new FakeWorker();
    const session = new PoseWorkerSession(worker as unknown as Worker, 'GPU');
    const initialization = session.initialize('/wasm', '/pose.task');
    worker.emit({ type: 'READY', delegate: 'GPU' });
    await initialization;

    const sample = session.detect({ close: vi.fn() } as unknown as ImageBitmap, 0);
    const frame = worker.messages.filter((message) => message.type === 'FRAME').at(-1);
    if (frame?.type !== 'FRAME') throw new Error('Expected a frame request.');
    worker.emit({
      type: 'ERROR', stage: 'detect', fatal: true, requestId: frame.requestId,
      captureEpoch: frame.captureEpoch, message: 'GPU and CPU inference failed.',
    });

    await expect(sample).rejects.toThrow('GPU and CPU inference failed.');
  });
});
