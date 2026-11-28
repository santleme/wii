import type { Delegate, PoseSnapshot, WorkerReply, WorkerRequest } from './poseProtocol';
import { VideoFramePump } from './videoFramePump';

export interface PoseClientCallbacks {
  onPose(snapshot: PoseSnapshot): void;
  onStatus(status: 'loading' | 'ready' | 'fallback' | 'error', detail: string): void;
}

export interface PoseClientAssets {
  wasmBaseUrl: string;
  modelUrl: string;
  cpuModelUrl?: string;
}

export class PoseClient {
  private worker?: Worker;
  private ready = false;
  private activeDelegate?: Delegate;
  private initPromise?: Promise<void>;
  private inFlight?: { requestId: number; captureEpoch: number; resolve(): void };
  private readonly capturePump = new VideoFramePump();
  private nextRequestId = 1;
  private captureEpoch = 0;
  private capturing = false;
  private callbacks?: PoseClientCallbacks;
  private resolveInitialization?: () => void;
  private rejectInitialization?: (error: Error) => void;

  constructor(private readonly assets: PoseClientAssets) {}

  get isReady(): boolean {
    return this.ready;
  }

  get delegate(): Delegate | undefined {
    return this.activeDelegate;
  }

  async init(callbacks: PoseClientCallbacks, preferred: Delegate = 'GPU'): Promise<void> {
    this.callbacks = callbacks;
    if (this.ready) return;
    let initialization = this.initPromise;
    if (!initialization) {
      initialization = this.spawn(preferred);
      this.initPromise = initialization;
    }
    try {
      await initialization;
    } catch (error) {
      if (this.initPromise === initialization) this.initPromise = undefined;
      throw error;
    }
  }

  beginCapture(video: HTMLVideoElement, callbacks: PoseClientCallbacks): void {
    this.callbacks = callbacks;
    if (!this.worker || !this.ready || this.capturing) return;
    this.captureEpoch += 1;
    const captureEpoch = this.captureEpoch;
    this.capturing = true;
    this.callbacks?.onStatus('ready', `MediaPipe pronto · ${this.activeDelegate} · capturando`);
    if (!this.capturing || captureEpoch !== this.captureEpoch || !this.worker || !this.ready) return;
    this.capturePump.start(video, {
      onFrame: (timestampMs) => this.capture(video, timestampMs),
      onError: (error) => {
        if (this.capturing) this.callbacks?.onStatus('error', error.message);
      },
    });
  }

  pauseCapture(): void {
    this.capturing = false;
    this.capturePump.stop();
  }

  dispose(): void {
    this.pauseCapture();
    this.worker?.postMessage({ type: 'DISPOSE' } satisfies WorkerRequest);
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = false;
    this.activeDelegate = undefined;
    const pendingFrame = this.inFlight;
    this.inFlight = undefined;
    pendingFrame?.resolve();
    this.initPromise = undefined;
    this.completeInitialization(new Error('PoseClient was disposed before initialization completed.'));
    this.callbacks = undefined;
  }

  private async spawn(preferred: Delegate): Promise<void> {
    this.callbacks?.onStatus('loading', 'Carregando MediaPipe e modelo local…');
    const worker = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    const initialized = new Promise<void>((resolve, reject) => {
      this.resolveInitialization = resolve;
      this.rejectInitialization = reject;
    });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (this.worker !== worker) return;
      const message = event.data;
      if (message.type === 'READY') {
        this.ready = true;
        this.activeDelegate = message.delegate;
        this.completeInitialization();
        this.callbacks?.onStatus('ready', `MediaPipe pronto · ${message.delegate}`);
      } else if (message.type === 'FALLBACK') {
        this.activeDelegate = message.to;
        this.callbacks?.onStatus('fallback', 'GPU indisponível; usando CPU.');
      } else if (message.type === 'ERROR') {
        // A fatal error belongs to the current worker, even after its frame was acknowledged.
        if (message.stage === 'detect' && !message.fatal) {
          if (this.inFlight?.requestId !== message.requestId || this.inFlight.captureEpoch !== message.captureEpoch) return;
          this.releaseFrame(message.requestId, message.captureEpoch);
          if (message.captureEpoch !== this.captureEpoch) return;
        }
        if (message.fatal) {
          const callbacks = this.callbacks;
          this.completeInitialization(new Error(message.message));
          this.dispose();
          callbacks?.onStatus('error', message.message);
        } else {
          this.callbacks?.onStatus('fallback', message.message);
        }
      } else if (message.type === 'POSE') {
        if (this.inFlight?.requestId !== message.requestId || this.inFlight.captureEpoch !== message.captureEpoch) return;
        this.releaseFrame(message.requestId, message.captureEpoch);
        if (!this.capturing || message.captureEpoch !== this.captureEpoch) return;
        this.callbacks?.onPose({
          timestampMs: message.timestampMs,
          landmarks: message.landmarks,
          worldLandmarks: message.worldLandmarks,
          trackingState: 'degraded',
          bodyConfidence: this.confidence(message.landmarks),
          frameWidth: message.frameWidth,
          frameHeight: message.frameHeight,
        });
      }
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      const error = new Error(event.message || 'Falha no Worker de visão.');
      this.callbacks?.onStatus('error', error.message);
      this.completeInitialization(error);
      this.dispose();
    };
    worker.postMessage({ type: 'INIT', delegate: preferred, ...this.assets } satisfies WorkerRequest);
    let initializationTimeout: number | undefined;
    try {
      await Promise.race([
        initialized,
        new Promise<never>((_resolve, reject) => {
          initializationTimeout = window.setTimeout(() => {
            const error = new Error('Inicialização do MediaPipe excedeu 30 segundos.');
            if (this.worker === worker) {
              this.callbacks?.onStatus('error', error.message);
              this.completeInitialization(error);
              this.dispose();
            }
            reject(error);
          }, 30_000);
        }),
      ]);
    } catch (error) {
      if (this.worker === worker) this.dispose();
      throw error;
    } finally {
      if (initializationTimeout !== undefined) window.clearTimeout(initializationTimeout);
    }
  }

  private completeInitialization(error?: Error): void {
    const resolve = this.resolveInitialization;
    const reject = this.rejectInitialization;
    this.resolveInitialization = undefined;
    this.rejectInitialization = undefined;
    if (error) reject?.(error);
    else resolve?.();
  }

  private async capture(video: HTMLVideoElement, timestampMs: number): Promise<void> {
    if (this.inFlight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const requestId = this.nextRequestId++;
    const captureEpoch = this.captureEpoch;
    const frameRequest = { requestId, captureEpoch };
    let resolveFrame!: () => void;
    const frameProcessed = new Promise<void>((resolve) => {
      resolveFrame = resolve;
    });
    this.inFlight = { ...frameRequest, resolve: resolveFrame };
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = video.videoWidth > 640
        ? await createImageBitmap(video, { resizeWidth: 640, resizeQuality: 'medium' })
        : await createImageBitmap(video);
      if (!this.capturing || captureEpoch !== this.captureEpoch || !this.worker) {
        bitmap.close();
        this.releaseFrame(requestId, captureEpoch);
        return;
      }
      this.worker.postMessage({ type: 'FRAME', ...frameRequest, timestampMs, bitmap } satisfies WorkerRequest, [bitmap]);
      bitmap = undefined;
      await frameProcessed;
    } catch (error) {
      bitmap?.close();
      this.releaseFrame(requestId, captureEpoch);
      throw error;
    }
  }

  private releaseFrame(requestId: number, captureEpoch: number): void {
    const pendingFrame = this.inFlight;
    if (pendingFrame?.requestId !== requestId || pendingFrame.captureEpoch !== captureEpoch) return;
    this.inFlight = undefined;
    pendingFrame.resolve();
  }

  private confidence(points: PoseSnapshot['landmarks']): number {
    // Upper-body shoulders [11, 12] anchor presence: running arms and high knees routinely
    // self-occlude the hips [23, 24] in a front-facing webcam without losing the player.
    const indices = [11, 12];
    if (indices.some((index) => !points[index])) return 0;
    return Math.min(...indices.map((index) => {
      const point = points[index]!;
      const visibility = point.visibility ?? point.presence ?? 0;
      const presence = point.presence ?? point.visibility ?? 0;
      const score = Math.min(visibility, presence);
      return Number.isFinite(score) ? score : 0;
    }));
  }
}
