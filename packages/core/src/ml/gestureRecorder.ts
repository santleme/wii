export interface GestureRecorderOptions {
  minFrames?: number;
  maxFrames?: number;
}

/** Records a bounded sequence of numeric feature vectors without depending on a camera or UI. */
export class GestureRecorder {
  private readonly minFrames: number;
  private readonly maxFrames: number;
  private frames: number[][] = [];
  private dimension?: number;
  private recording = false;

  constructor(options: GestureRecorderOptions = {}) {
    this.minFrames = options.minFrames ?? 5;
    this.maxFrames = options.maxFrames ?? 120;
    if (!Number.isInteger(this.minFrames) || this.minFrames < 1) {
      throw new RangeError('minFrames must be a positive integer.');
    }
    if (!Number.isInteger(this.maxFrames) || this.maxFrames < this.minFrames) {
      throw new RangeError('maxFrames must be an integer greater than or equal to minFrames.');
    }
  }

  get isRecording(): boolean {
    return this.recording;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  start(): void {
    this.frames = [];
    this.dimension = undefined;
    this.recording = true;
  }

  addFrame(features: readonly number[]): boolean {
    if (!this.recording || this.frames.length >= this.maxFrames) return false;
    if (features.length === 0 || features.some((value) => !Number.isFinite(value))) {
      throw new RangeError('Gesture frames must contain finite feature values.');
    }
    if (this.dimension !== undefined && features.length !== this.dimension) {
      // Recoverable caller error: report it, but keep the frames already recorded —
      // cancelling here would destroy a whole take over one malformed frame.
      throw new RangeError('Gesture feature dimension changed while recording.');
    }
    this.dimension ??= features.length;
    this.frames.push([...features]);
    return true;
  }

  finish(): number[][] | undefined {
    this.recording = false;
    const recording = this.frames.length >= this.minFrames ? this.frames.map((frame) => [...frame]) : undefined;
    this.frames = [];
    this.dimension = undefined;
    return recording;
  }

  cancel(): void {
    this.recording = false;
    this.frames = [];
    this.dimension = undefined;
  }
}
