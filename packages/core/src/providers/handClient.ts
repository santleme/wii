import type { Delegate } from '../types';
import type { HandSnapshot, HandWorkerReply, HandWorkerRequest } from './handProtocol';

export interface HandClientCallbacks {
  onStatus(status: 'loading' | 'ready' | 'fallback' | 'error', detail: string): void;
}

export interface HandClientAssets {
  wasmBaseUrl: string;
  modelUrl: string;
}

interface PendingFrame {
  requestId: number;
  resolve(snapshot: HandSnapshot | undefined): void;
}

/** Owns the hand-model worker and accepts transferred frames from a host capture loop. */
export class HandClient {
  private worker?: Worker;
  private ready = false;
  private activeDelegate?: Delegate;
  private initPromise?: Promise<void>;
  private resolveInit?: () => void;
  private rejectInit?: (error: Error) => void;
  private initializationTimeout?: number;
  private inFlight?: PendingFrame;
  private nextRequestId = 1;
  private lastTimestamp?: number;
  private callbacks?: HandClientCallbacks;

  constructor(private readonly assets: HandClientAssets) {}

  get isReady(): boolean {
    return this.ready;
  }

  get delegate(): Delegate | undefined {
    return this.activeDelegate;
  }

  init(callbacks: HandClientCallbacks, preferred: Delegate = 'GPU'): Promise<void> {
    this.callbacks = callbacks;
    if (this.ready) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    this.callbacks.onStatus('loading', 'Carregando MediaPipe Hand Landmarker e modelo local…');
    let worker: Worker;
    try {
      worker = new Worker(new URL('./hand.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      const initializationError = error instanceof Error ? error : new Error(String(error));
      this.callbacks.onStatus('error', initializationError.message);
      return Promise.reject(initializationError);
    }
    this.worker = worker;
    const initialization = new Promise<void>((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
      this.initializationTimeout = window.setTimeout(() => {
        this.failInitialization(worker, new Error('Inicialização do Hand Landmarker excedeu 30 segundos.'));
      }, 30_000);
    });
    this.initPromise = initialization;

    worker.onmessage = (event: MessageEvent<HandWorkerReply>) => {
      if (this.worker !== worker) return;
      const message = event.data;
      if (message.type === 'READY') {
        this.ready = true;
        this.activeDelegate = message.delegate;
        this.finishInitialization();
        this.callbacks?.onStatus('ready', `Hand Landmarker pronto · ${message.delegate}`);
      } else if (message.type === 'FALLBACK') {
        this.activeDelegate = message.to;
        this.callbacks?.onStatus('fallback', 'GPU indisponível; usando CPU.');
      } else if (message.type === 'ERROR') {
        if (message.stage === 'init') {
          this.failInitialization(worker, new Error(message.message));
          return;
        }
        if (this.inFlight?.requestId !== message.requestId) return;
        this.releaseFrame(message.requestId);
        this.callbacks?.onStatus(message.fatal ? 'error' : 'fallback', message.message);
        if (message.fatal) this.dispose();
      } else if (message.type === 'HAND') {
        if (this.inFlight?.requestId !== message.requestId) return;
        this.releaseFrame(message.requestId, { timestampMs: message.timestampMs, hands: message.hands });
      }
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      const error = new Error(event.message || 'Falha no Worker do Hand Landmarker.');
      if (!this.ready) {
        this.failInitialization(worker, error);
        return;
      }
      this.callbacks?.onStatus('error', error.message);
      this.dispose();
    };

    try {
      worker.postMessage({ type: 'INIT', delegate: preferred, ...this.assets } satisfies HandWorkerRequest);
    } catch (error) {
      this.failInitialization(worker, error instanceof Error ? error : new Error(String(error)));
    }
    return initialization;
  }

  /**
   * Processes at most one frame at a time. The bitmap is transferred and closed by the worker when
   * accepted; otherwise it is closed here. Busy frames are dropped instead of queued.
   */
  processFrame(bitmap: ImageBitmap | VideoFrame, timestampMs: number): Promise<HandSnapshot | undefined> {
    if (!Number.isFinite(timestampMs) || timestampMs < 0) {
      bitmap.close();
      return Promise.reject(new RangeError('Frame timestamp must be a finite, non-negative number.'));
    }
    if (!this.worker || !this.ready || this.inFlight) {
      bitmap.close();
      return Promise.resolve(undefined);
    }

    const requestId = this.nextRequestId++;
    const monotonicTimestamp =
      this.lastTimestamp === undefined ? timestampMs : Math.max(timestampMs, this.lastTimestamp + 0.01);
    this.lastTimestamp = monotonicTimestamp;
    const worker = this.worker;
    return new Promise((resolve) => {
      this.inFlight = { requestId, resolve };
      try {
        worker.postMessage(
          { type: 'FRAME', requestId, timestampMs: monotonicTimestamp, bitmap } satisfies HandWorkerRequest,
          [bitmap],
        );
      } catch (error) {
        bitmap.close();
        this.releaseFrame(requestId);
        this.callbacks?.onStatus('error', error instanceof Error ? error.message : String(error));
      }
    });
  }

  dispose(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.ready = false;
    this.activeDelegate = undefined;
    this.lastTimestamp = undefined;
    this.finishInitialization(new Error('Hand Landmarker foi descartado durante a inicialização.'));
    worker?.postMessage({ type: 'DISPOSE' } satisfies HandWorkerRequest);
    worker?.terminate();
    this.releaseFrame(this.inFlight?.requestId);
    this.initPromise = undefined;
    this.callbacks = undefined;
  }

  private releaseFrame(requestId: number | undefined, snapshot?: HandSnapshot): void {
    if (requestId === undefined || this.inFlight?.requestId !== requestId) return;
    const pending = this.inFlight;
    this.inFlight = undefined;
    pending.resolve(snapshot);
  }

  private finishInitialization(error?: Error): void {
    if (this.initializationTimeout !== undefined) window.clearTimeout(this.initializationTimeout);
    this.initializationTimeout = undefined;
    const resolve = this.resolveInit;
    const reject = this.rejectInit;
    this.resolveInit = undefined;
    this.rejectInit = undefined;
    if (error) reject?.(error);
    else resolve?.();
  }

  private failInitialization(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.callbacks?.onStatus('error', error.message);
    this.finishInitialization(error);
    this.worker = undefined;
    this.ready = false;
    this.activeDelegate = undefined;
    this.initPromise = undefined;
    worker.terminate();
  }
}
