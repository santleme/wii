import type { HandClientCallbacks, HandClientAssets } from '../providers/handClient';
import { HandClient } from '../providers/handClient';
import type { HandSnapshot } from '../providers/handProtocol';
import { PoseClient } from '../providers/poseClient';
import type { PoseClientAssets } from '../providers/poseClient';
import type { Delegate, PoseSnapshot } from '../types';
import { VideoFramePump } from '../providers/videoFramePump';

export type PerceptionContext = 'hand' | 'pose';
export type RuntimeStatus = 'loading' | 'ready' | 'fallback' | 'error';

export type SpatialObservation =
  | { source: 'hand'; snapshot: HandSnapshot }
  | { source: 'pose'; snapshot: PoseSnapshot };

export interface PoseProviderCallbacks {
  onPose(snapshot: PoseSnapshot): void;
  onStatus(status: RuntimeStatus, detail: string): void;
}

export interface HandProviderClient {
  readonly isReady: boolean;
  init(callbacks: HandClientCallbacks, preferred?: Delegate): Promise<void>;
  /** Optional live capture seam; `dispose` must stop it. Older adapters may use processFrame instead. */
  beginCapture?(
    video: HTMLVideoElement,
    onHand: (snapshot: HandSnapshot, aspectY: number) => void,
    onError?: (error: Error) => void,
  ): void;
  processFrame(bitmap: ImageBitmap, timestampMs: number): Promise<HandSnapshot | undefined>;
  dispose(): void;
}

export interface PoseProviderClient {
  readonly isReady: boolean;
  init(callbacks: PoseProviderCallbacks, preferred?: Delegate): Promise<void>;
  beginCapture(video: HTMLVideoElement, callbacks: PoseProviderCallbacks): void;
  pauseCapture(): void;
  dispose(): void;
}

export interface SpatialRuntimeCallbacks {
  onObservation(observation: SpatialObservation): void;
  onStatus(context: PerceptionContext, status: RuntimeStatus, detail: string): void;
}

export interface SpatialRuntimeOptions extends SpatialRuntimeCallbacks {
  video: HTMLVideoElement;
  handAssets: HandClientAssets;
  poseAssets?: PoseClientAssets;
  preferredDelegate?: Delegate;
  createHandClient?: () => HandProviderClient;
  createPoseClient?: () => PoseProviderClient;
}

type ActiveProvider = { context: 'hand'; client: HandProviderClient } | { context: 'pose'; client: PoseProviderClient };

interface InitializationStatus {
  errorReported: boolean;
}

/** Switches headless perception contexts and forwards typed observations from the active provider. */
export class SpatialRuntime {
  private readonly video: HTMLVideoElement;
  private readonly handAssets: HandClientAssets;
  private readonly preferredDelegate: Delegate;
  private readonly callbacks: SpatialRuntimeCallbacks;
  private readonly createHandClient: () => HandProviderClient;
  private readonly createPoseClient?: () => PoseProviderClient;
  private handFramePump?: VideoFramePump;
  private active?: ActiveProvider;
  private generation = 0;
  private activation?: { context: PerceptionContext; generation: number; promise: Promise<boolean> };

  constructor(options: SpatialRuntimeOptions) {
    this.video = options.video;
    this.handAssets = options.handAssets;
    this.preferredDelegate = options.preferredDelegate ?? 'GPU';
    this.callbacks = { onObservation: options.onObservation, onStatus: options.onStatus };
    this.createHandClient = options.createHandClient ?? (() => new HandClient(this.handAssets));
    const poseAssets = options.poseAssets;
    this.createPoseClient = options.createPoseClient ?? (poseAssets ? () => new PoseClient(poseAssets) : undefined);
  }

  get activeContext(): PerceptionContext | undefined {
    return this.active?.client.isReady ? this.active.context : undefined;
  }

  activate(context: PerceptionContext): Promise<boolean> {
    if (this.active?.context === context && this.active.client.isReady) return Promise.resolve(true);
    if (this.activation?.context === context) return this.activation.promise;

    const generation = ++this.generation;
    this.activation = undefined;
    this.disposeActive();
    const promise = Promise.resolve().then(() => this.initializeContext(context, generation));
    this.activation = { context, generation, promise };
    const clearActivation = () => {
      if (this.activation?.generation === generation) this.activation = undefined;
    };
    void promise.then(clearActivation, clearActivation);
    return promise;
  }

  deactivate(): void {
    this.generation += 1;
    this.activation = undefined;
    this.disposeActive();
  }

  dispose(): void {
    this.deactivate();
  }

  private async initializeContext(context: PerceptionContext, generation: number): Promise<boolean> {
    let active: ActiveProvider;
    try {
      if (context === 'hand') {
        active = { context, client: this.createHandClient() };
      } else if (this.createPoseClient) {
        active = { context, client: this.createPoseClient() };
      } else {
        throw new Error('A pose provider adapter must be supplied to activate the pose context.');
      }
    } catch (error) {
      if (generation === this.generation) {
        this.callbacks.onStatus(context, 'error', error instanceof Error ? error.message : String(error));
      }
      return false;
    }
    this.active = active;

    const initializationStatus: InitializationStatus = { errorReported: false };
    let initialization: Promise<void>;
    try {
      if (active.context === 'hand') {
        initialization = active.client.init(
          this.handCallbacks(active, generation, initializationStatus),
          this.preferredDelegate,
        );
      } else {
        initialization = active.client.init(
          this.poseCallbacks(active, generation, initializationStatus),
          this.preferredDelegate,
        );
      }
      if (!this.isCurrent(active, generation)) active.client.dispose();
      await initialization;
    } catch (error) {
      if (this.isCurrent(active, generation)) {
        this.disposeActive();
        if (!initializationStatus.errorReported) {
          this.callbacks.onStatus(context, 'error', error instanceof Error ? error.message : String(error));
        }
      }
      return false;
    }

    if (!this.isCurrent(active, generation)) return false;
    if (!active.client.isReady) {
      this.disposeActive();
      if (!initializationStatus.errorReported) {
        this.callbacks.onStatus(
          context,
          'error',
          'Perception provider finished initialization without becoming ready.',
        );
      }
      return false;
    }
    if (active.context === 'pose') {
      active.client.beginCapture(this.video, this.poseCallbacks(active, generation));
    } else {
      this.startHandCapture(active, generation);
    }
    return true;
  }

  private handCallbacks(
    active: ActiveProvider,
    generation: number,
    initializationStatus: InitializationStatus,
  ): HandClientCallbacks {
    return {
      onStatus: (status, detail) => {
        if (status === 'error') initializationStatus.errorReported = true;
        if (this.isCurrent(active, generation)) this.callbacks.onStatus('hand', status, detail);
      },
    };
  }

  private poseCallbacks(
    active: ActiveProvider,
    generation: number,
    initializationStatus?: InitializationStatus,
  ): PoseProviderCallbacks {
    return {
      onPose: (snapshot) => {
        if (this.isCurrent(active, generation)) this.callbacks.onObservation({ source: 'pose', snapshot });
      },
      onStatus: (status, detail) => {
        if (status === 'error' && initializationStatus) initializationStatus.errorReported = true;
        if (this.isCurrent(active, generation)) this.callbacks.onStatus('pose', status, detail);
      },
    };
  }

  private isCurrent(active: ActiveProvider, generation: number): boolean {
    return this.active === active && this.generation === generation;
  }

  private startHandCapture(active: Extract<ActiveProvider, { context: 'hand' }>, generation: number): void {
    if (active.client.beginCapture) {
      active.client.beginCapture(
        this.video,
        (snapshot) => {
          if (this.isCurrent(active, generation)) this.callbacks.onObservation({ source: 'hand', snapshot });
        },
        (error) => {
          if (this.isCurrent(active, generation)) this.callbacks.onStatus('hand', 'error', error.message);
        },
      );
      return;
    }

    // Keep existing processFrame-only provider adapters working through the same scheduler.
    const pump = new VideoFramePump();
    this.handFramePump = pump;
    pump.start(this.video, {
      onFrame: async (timestampMs) => {
        if (!this.isCurrent(active, generation) || this.video.videoWidth <= 0 || this.video.videoHeight <= 0) return;
        let bitmap: ImageBitmap | undefined;
        try {
          bitmap = await createImageBitmap(this.video, { resizeWidth: 640, resizeQuality: 'low' });
          if (!this.isCurrent(active, generation)) return;
          const frame = bitmap;
          const processing = active.client.processFrame(frame, timestampMs);
          bitmap = undefined;
          const snapshot = await processing;
          if (snapshot && this.isCurrent(active, generation)) {
            this.callbacks.onObservation({ source: 'hand', snapshot });
          }
        } finally {
          bitmap?.close();
        }
      },
      onError: (error) => {
        if (this.isCurrent(active, generation)) this.callbacks.onStatus('hand', 'error', error.message);
      }
    });
  }

  private disposeActive(): void {
    this.handFramePump?.stop();
    this.handFramePump = undefined;
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    if (active.context === 'pose') {
      active.client.pauseCapture();
      active.client.dispose();
    } else {
      active.client.dispose();
    }
  }

}
