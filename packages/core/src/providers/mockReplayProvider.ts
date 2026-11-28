import type { HandSnapshot } from './handProtocol';

function cloneSnapshot(snapshot: HandSnapshot): HandSnapshot {
  return {
    timestampMs: snapshot.timestampMs,
    hands: snapshot.hands.map((hand) => ({
      ...hand,
      landmarks: hand.landmarks.map((point) => ({ ...point })),
      worldLandmarks: hand.worldLandmarks.map((point) => ({ ...point })),
    })),
  };
}

/** Sequential deterministic source for recorded hand snapshots; it does not access the camera or DOM. */
export class MockReplayProvider {
  private readonly frames: readonly HandSnapshot[];
  private cursor = 0;

  constructor(frames: readonly HandSnapshot[]) {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]!;
      if (!Number.isFinite(frame.timestampMs) || frame.timestampMs < 0) {
        throw new RangeError(`Replay frame ${index} has an invalid timestamp.`);
      }
      if (index > 0 && frame.timestampMs <= frames[index - 1]!.timestampMs) {
        throw new RangeError(`Replay timestamps must be strictly increasing (frame ${index}).`);
      }
    }
    this.frames = frames.map(cloneSnapshot);
  }

  get isComplete(): boolean {
    return this.cursor >= this.frames.length;
  }

  /** Frames consumed so far; mirrors PoseReplayProvider.frameIndex. */
  get frameIndex(): number {
    return this.cursor;
  }

  next(): HandSnapshot | undefined {
    const frame = this.frames[this.cursor];
    if (!frame) return undefined;
    this.cursor += 1;
    return cloneSnapshot(frame);
  }

  reset(): void {
    this.cursor = 0;
  }
}
