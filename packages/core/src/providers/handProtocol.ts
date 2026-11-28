import type { Delegate, Hand, Point3 } from '../types';

export interface HandObservation {
  /** Landmark positions normalized to the input image dimensions. */
  landmarks: Point3[];
  /** Metric, hand-centered landmarks returned by MediaPipe. */
  worldLandmarks: Point3[];
  handedness?: Hand;
  /** Handedness classifier score; this is not a landmark visibility score. */
  handednessScore?: number;
}

export interface HandSnapshot {
  timestampMs: number;
  hands: HandObservation[];
}

export interface HandWorkerInit {
  type: 'INIT';
  wasmBaseUrl: string;
  modelUrl: string;
  delegate: Delegate;
}

export interface HandWorkerFrame {
  type: 'FRAME';
  requestId: number;
  timestampMs: number;
  /** Transferred to the worker, which closes it. */
  bitmap: ImageBitmap | VideoFrame;
}

export type HandWorkerRequest = HandWorkerInit | HandWorkerFrame | { type: 'DISPOSE' };

export type HandWorkerReply =
  | { type: 'READY'; delegate: Delegate }
  | { type: 'HAND'; requestId: number; timestampMs: number; hands: HandObservation[] }
  | { type: 'FALLBACK'; from: 'GPU'; to: 'CPU'; reason: string }
  | { type: 'ERROR'; stage: 'init'; fatal: true; message: string }
  | { type: 'ERROR'; stage: 'detect'; fatal: boolean; requestId: number; message: string };
