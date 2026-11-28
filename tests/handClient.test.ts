import { afterEach, describe, expect, it, vi } from 'vitest';
import { HandClient } from '@wii/spatial-core';
import type { HandWorkerReply, HandWorkerRequest } from '@wii/spatial-core';
import { handSnapshot } from './fixtures/syntheticHand';

class FakeWorker {
  static instance: FakeWorker | undefined;
  onmessage: ((event: MessageEvent<HandWorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: HandWorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;

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

  terminate(): void {
    this.terminated = true;
  }

  reply(message: HandWorkerReply): void {
    this.onmessage?.({ data: message } as MessageEvent<HandWorkerReply>);
  }
}

describe('HandClient worker boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeWorker.instance = undefined;
  });

  it('serializes frame inference, transfers accepted bitmaps, drops busy frames, and preserves monotonic timestamps', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', { setTimeout, clearTimeout });

    const client = new HandClient({
      wasmBaseUrl: 'https://example.test/mediapipe/wasm-1.2.3',
      modelUrl: 'https://example.test/mediapipe/models/hand_landmarker.fbc2a300.task',
    });
    const onStatus = vi.fn();
    await client.init({ onStatus });
    const worker = FakeWorker.instance!;
    expect(worker.sent[0]).toMatchObject({
      type: 'INIT',
      wasmBaseUrl: 'https://example.test/mediapipe/wasm-1.2.3',
      modelUrl: 'https://example.test/mediapipe/models/hand_landmarker.fbc2a300.task',
    });
    const firstBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const secondBitmap = { close: vi.fn() } as unknown as ImageBitmap;

    const pending = client.processFrame(firstBitmap, 100);
    await expect(client.processFrame(secondBitmap, 101)).resolves.toBeUndefined();
    expect(secondBitmap.close).toHaveBeenCalledOnce();
    const firstFrame = worker.sent.find((message) => message.type === 'FRAME');
    expect(firstFrame).toMatchObject({ type: 'FRAME', timestampMs: 100 });
    expect(worker.transfers.at(-1)).toEqual([firstBitmap]);
    expect(firstBitmap.close).not.toHaveBeenCalled();
    if (firstFrame?.type !== 'FRAME') throw new Error('Expected a transferred hand frame');

    const expected = handSnapshot(100);
    worker.reply({ type: 'HAND', requestId: firstFrame.requestId + 1, timestampMs: 100, hands: expected.hands });
    worker.reply({ type: 'HAND', requestId: firstFrame.requestId, timestampMs: 100, hands: expected.hands });
    await expect(pending).resolves.toEqual(expected);

    const nextBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const nextPending = client.processFrame(nextBitmap, 99);
    const lastFrame = worker.sent.filter((message) => message.type === 'FRAME').at(-1);
    expect(lastFrame?.type === 'FRAME' && lastFrame.timestampMs).toBe(100.01);
    if (lastFrame?.type !== 'FRAME') throw new Error('Expected a second hand frame');
    worker.reply({ type: 'HAND', requestId: lastFrame.requestId, timestampMs: lastFrame.timestampMs, hands: [] });
    await expect(nextPending).resolves.toEqual({ timestampMs: 100.01, hands: [] });
    client.dispose();
  });

  it('settles an in-flight request when disposed and closes frames rejected before transfer', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', { setTimeout, clearTimeout });

    const client = new HandClient({ wasmBaseUrl: '/mediapipe/wasm-1.2.3', modelUrl: '/mediapipe/models/hand.task' });
    await client.init({ onStatus: vi.fn() });
    const worker = FakeWorker.instance!;
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const pending = client.processFrame(bitmap, 10);

    client.dispose();
    await expect(pending).resolves.toBeUndefined();
    expect(worker.terminated).toBe(true);
    expect(client.isReady).toBe(false);
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it('disposes the worker when a fatal error arrives after its hand result', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', { setTimeout, clearTimeout });

    const client = new HandClient({ wasmBaseUrl: '/mediapipe/wasm-1.2.3', modelUrl: '/mediapipe/models/hand.task' });
    const onStatus = vi.fn();
    await client.init({ onStatus });
    onStatus.mockClear();
    const worker = FakeWorker.instance!;

    const firstBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const firstPending = client.processFrame(firstBitmap, 10);
    const firstFrame = worker.sent.filter((message) => message.type === 'FRAME').at(-1);
    if (firstFrame?.type !== 'FRAME') throw new Error('Expected the first hand frame');
    worker.reply({ type: 'HAND', requestId: firstFrame.requestId, timestampMs: 10, hands: [] });
    await expect(firstPending).resolves.toEqual({ timestampMs: 10, hands: [] });

    const secondBitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const secondPending = client.processFrame(secondBitmap, 20);
    const secondFrame = worker.sent.filter((message) => message.type === 'FRAME').at(-1);
    if (secondFrame?.type !== 'FRAME') throw new Error('Expected the second hand frame');

    worker.reply({
      type: 'ERROR',
      stage: 'detect',
      fatal: true,
      requestId: firstFrame.requestId,
      message: 'CPU fallback failed after the hand result.',
    });

    expect(onStatus).toHaveBeenCalledWith('error', 'CPU fallback failed after the hand result.');
    expect(client.isReady).toBe(false);
    expect(worker.terminated).toBe(true);
    await expect(secondPending).resolves.toBeUndefined();
    expect(firstBitmap.close).not.toHaveBeenCalled();
    expect(secondBitmap.close).not.toHaveBeenCalled();
  });
});
