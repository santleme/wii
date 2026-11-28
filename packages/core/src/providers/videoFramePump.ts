const HAVE_CURRENT_DATA = 2;

type VideoFrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface VideoFramePumpCallbacks {
  /** Resolves when this frame has finished at the consumer's processing seam. */
  onFrame(timestampMs: number): Promise<void>;
  onError(error: Error): void;
}

/** Schedules fresh video frames and serializes asynchronous processing without retaining frame buffers. */
export class VideoFramePump {
  private generation = 0;
  private inFlight?: object;
  private video?: VideoFrameCallbackVideo;
  private callbacks?: VideoFramePumpCallbacks;
  private callbackId?: number;
  private rafId?: number;
  private lastVideoTime = -1;
  private lastTimestamp = 0;

  start(video: HTMLVideoElement, callbacks: VideoFramePumpCallbacks): void {
    this.stop();
    this.video = video as VideoFrameCallbackVideo;
    this.callbacks = callbacks;
    this.lastVideoTime = -1;
    this.schedule(this.generation);
  }

  stop(): void {
    this.generation += 1;
    const video = this.video;
    if (this.callbackId !== undefined) video?.cancelVideoFrameCallback?.(this.callbackId);
    if (this.rafId !== undefined) window.cancelAnimationFrame(this.rafId);
    this.callbackId = undefined;
    this.rafId = undefined;
    this.video = undefined;
    this.callbacks = undefined;
  }

  private schedule(generation: number): void {
    const video = this.video;
    if (generation !== this.generation || !video) return;

    if (typeof video.requestVideoFrameCallback === 'function') {
      this.callbackId = video.requestVideoFrameCallback((now) => {
        if (generation !== this.generation) return;
        this.callbackId = undefined;
        this.schedule(generation);
        this.processFrame(generation, now);
      });
      return;
    }

    this.rafId = window.requestAnimationFrame(() => {
      if (generation !== this.generation) return;
      this.rafId = undefined;
      this.schedule(generation);
      if (video.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = video.currentTime;
      this.processFrame(generation, performance.now());
    });
  }

  private processFrame(generation: number, now: number): void {
    const video = this.video;
    const callbacks = this.callbacks;
    if (generation !== this.generation || !video || !callbacks || this.inFlight) return;
    if (video.readyState < HAVE_CURRENT_DATA) return;

    const timestampMs = Math.max(now, this.lastTimestamp + 0.01);
    this.lastTimestamp = timestampMs;
    const flight = {};
    this.inFlight = flight;
    void this.runFrame(generation, flight, callbacks, timestampMs);
  }

  private async runFrame(
    generation: number,
    flight: object,
    callbacks: VideoFramePumpCallbacks,
    timestampMs: number,
  ): Promise<void> {
    try {
      await callbacks.onFrame(timestampMs);
    } catch (error) {
      if (generation === this.generation) {
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (this.inFlight === flight) this.inFlight = undefined;
    }
  }
}
