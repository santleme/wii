import type { Delegate, WorkerReply, WorkerRequest } from '@wii/spatial-core';

type PoseReply = Extract<WorkerReply, { type: 'POSE' }>;

interface PendingFrame {
  resolve: (reply: PoseReply | undefined) => void;
  reject: (error: Error) => void;
  timeout: number;
}

export class PoseWorkerSession {
  private readonly pending = new Map<number, PendingFrame>();
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly readyPromise: Promise<void>;
  private requestId = 1;
  private effectiveDelegate: Delegate;
  /** Delegates that actually produced collected samples; worker messages arrive in emission order. */
  private readonly sampledDelegates = new Set<Delegate>();

  constructor(private readonly worker: Worker, preferredDelegate: Delegate) {
    this.effectiveDelegate = preferredDelegate;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => this.onMessage(data);
    worker.onerror = (event) => this.failAll(new Error(event.message || 'Pose worker failed.'));
  }

  get delegate(): Delegate {
    return this.effectiveDelegate;
  }

  get hasMixedConfigurationSamples(): boolean {
    return this.sampledDelegates.size > 1;
  }

  /** The delegate that produced every collected sample, or undefined when nothing was collected yet. */
  get sampledDelegate(): Delegate | undefined {
    return this.sampledDelegates.size === 1 ? [...this.sampledDelegates][0] : undefined;
  }

  assertSingleConfigurationRun(): void {
    if (!this.hasMixedConfigurationSamples) return;
    throw new Error('Pose samples span both GPU and CPU; this mixed-configuration replay cannot be used as a single-configuration reference. Rerun with a healthy GPU or choose CPU from the start.');
  }

  async initialize(wasmBaseUrl: string, modelUrl: string, cpuModelUrl?: string): Promise<Delegate> {
    this.worker.postMessage({
      type: 'INIT',
      delegate: this.effectiveDelegate,
      wasmBaseUrl,
      modelUrl,
      ...(cpuModelUrl ? { cpuModelUrl } : {}),
    } satisfies WorkerRequest);
    let timeout: number | undefined;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error('Pose worker initialization timed out.')), 30_000);
        }),
      ]);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
    return this.effectiveDelegate;
  }

  detect(bitmap: ImageBitmap, timestampMs: number): Promise<PoseReply | undefined> {
    const requestId = this.requestId++;
    const captureEpoch = 1;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Pose inference timed out at ${timestampMs} ms.`));
      }, 15_000);
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        this.worker.postMessage({ type: 'FRAME', requestId, captureEpoch, timestampMs, bitmap } satisfies WorkerRequest, [bitmap]);
      } catch (error) {
        window.clearTimeout(timeout);
        this.pending.delete(requestId);
        bitmap.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    try {
      this.worker.postMessage({ type: 'DISPOSE' } satisfies WorkerRequest);
    } finally {
      this.worker.terminate();
      this.failAll(new Error('Pose worker was disposed.'));
    }
  }

  private onMessage(message: WorkerReply): void {
    if (message.type === 'READY') {
      this.effectiveDelegate = message.delegate;
      this.settleReady();
    } else if (message.type === 'FALLBACK') {
      this.effectiveDelegate = message.to;
    } else if (message.type === 'ERROR') {
      const error = new Error(message.message);
      if (message.stage === 'init') {
        if (message.fatal) this.settleReady(error);
        return;
      }

      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      this.pending.delete(message.requestId);
      if (message.fatal) pending.reject(error);
      else pending.resolve(undefined);
    } else if (message.type === 'POSE') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.sampledDelegates.add(this.effectiveDelegate);
      window.clearTimeout(pending.timeout);
      this.pending.delete(message.requestId);
      pending.resolve(message);
    }
  }

  private settleReady(error?: Error): void {
    const resolve = this.readyResolve;
    const reject = this.readyReject;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    if (error) reject?.(error);
    else resolve?.();
  }

  private failAll(error: Error): void {
    this.settleReady(error);
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
