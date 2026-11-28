import type { Point3, PoseSnapshot } from '@wii/spatial-core';
import { landmarkConfidence, visibleImagePoint } from './math';

/** One frame of the upper body, in image units scaled so x and y share the shoulder width's units. */
export interface TorsoVerticalSample {
  timestampMs: number;
  /** Shoulder, head and wrist heights (image y, growing downward), shoulder-midpoint x, and the slowly measured shoulder width. */
  shoulders: { left: number; right: number; width: number; head: number; x: number; leftWrist: number; rightWrist: number };
}

const MIN_SHOULDER_WIDTH = 0.02;
const CORE_MIN_CONFIDENCE = 0.5;
/** The shoulder width is a scale, not a signal: it follows the player slowly. */
const WIDTH_FOLLOW = 0.03;
/**
 * Fast movement makes the tracker snap one shoulder onto the other for a frame: real recordings show
 * the width falling from 0.28 to 0.01. Such a frame is dropped. A player who really turned or moved
 * away stays narrow, so after this long the new width is believed.
 */
const BROKEN_WIDTH_RATIO = 0.6;
const BROKEN_PATIENCE_MS = 400;

function imageHeight(point: Point3 | undefined, aspect: number, confidence: number): number {
  return visibleImagePoint(point, confidence) ? point.y * aspect : Number.NaN;
}

/**
 * Shared upper-body channel: every running, walking, jumping and intensity detector reads the same
 * frame through it. Only the shoulders are required (hips sit at the bottom edge of a laptop
 * webcam or behind the swinging arms); frames with an unreadable or broken shoulder line give
 * no sample.
 */
export class TorsoVerticalChannel {
  private widthScale?: number;
  private brokenSince?: number;

  update(snapshot: PoseSnapshot): TorsoVerticalSample | undefined {
    const l = snapshot.landmarks;
    const leftShoulder = l[11];
    const rightShoulder = l[12];
    if (!leftShoulder || !rightShoulder) return undefined;
    if (landmarkConfidence(leftShoulder, rightShoulder) < CORE_MIN_CONFIDENCE) return undefined;
    const aspect = snapshot.frameHeight > 0 && snapshot.frameWidth > 0 ? snapshot.frameHeight / snapshot.frameWidth : 720 / 1280;
    const width = Math.hypot(leftShoulder.x - rightShoulder.x, (leftShoulder.y - rightShoulder.y) * aspect);
    const x = (leftShoulder.x + rightShoulder.x) / 2;
    if (!Number.isFinite(width) || !Number.isFinite(x) || !Number.isFinite(leftShoulder.y + rightShoulder.y)) return undefined;

    if (this.widthScale !== undefined && width < this.widthScale * BROKEN_WIDTH_RATIO) {
      this.brokenSince ??= snapshot.timestampMs;
      if (snapshot.timestampMs - this.brokenSince < BROKEN_PATIENCE_MS) return undefined;
      this.widthScale = undefined;
    }
    this.brokenSince = undefined;
    if (width >= MIN_SHOULDER_WIDTH) this.widthScale = this.widthScale === undefined ? width : this.widthScale + (width - this.widthScale) * WIDTH_FOLLOW;
    if (this.widthScale === undefined) return undefined;

    return {
      timestampMs: snapshot.timestampMs,
      shoulders: {
        left: leftShoulder.y * aspect,
        right: rightShoulder.y * aspect,
        width: this.widthScale,
        head: imageHeight(l[0], aspect, CORE_MIN_CONFIDENCE),
        x,
        leftWrist: imageHeight(l[15], aspect, 0.3),
        rightWrist: imageHeight(l[16], aspect, 0.3),
      },
    };
  }

  reset(): void { this.widthScale = this.brokenSince = undefined; }
}
