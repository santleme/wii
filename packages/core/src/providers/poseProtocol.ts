import type { Delegate, Hand, Point3, TrackingState } from '../types';

export type { Delegate, Hand, Point3, PoseSnapshot, TrackingState } from '../types';
export interface CalibrationProfile {
  version: 3;
  completedAtMs: number;
  world: {
    shoulderWidth: number;
    /**
     * Standing vertical captured from verified extended legs when available, otherwise from
     * the neutral trunk direction. Runtime lean is measured as a delta from the neutral pose.
     */
    leanUp0: Point3;
    /** Lateral trunk lean of the neutral calibration pose; runtime lean is reported as the delta from it. */
    torsoLeanRad0: number;
    /** Each wrist relative to its own shoulder; each hand has an independent optional reference. */
    readyWristLocal?: Partial<Record<Hand, Point3>>;
  };
  quality: { validFrameRatio: number; medianConfidence: number };
  /**
   * Per-control convergence, when the profile comes from an online estimator. Missing means
   * a traditionally completed profile, so consumers treat every control as ready.
   */
  readiness?: { scale01: number; neutral01: number };
}

export interface WorkerInit {
  type: 'INIT';
  wasmBaseUrl: string;
  modelUrl: string;
  delegate: Delegate;
}

export interface WorkerFrame {
  type: 'FRAME';
  /** Monotonic within a PoseClient; identifies this inference request. */
  requestId: number;
  /** Changes for each capture session; stale replies must not reach the active session. */
  captureEpoch: number;
  timestampMs: number;
  bitmap: ImageBitmap;
}

export type WorkerRequest = WorkerInit | WorkerFrame | { type: 'DISPOSE' };

export type WorkerReply =
  | { type: 'READY'; delegate: Delegate }
  | {
      type: 'POSE';
      requestId: number;
      captureEpoch: number;
      timestampMs: number;
      landmarks: Point3[];
      worldLandmarks: Point3[];
    }
  | { type: 'FALLBACK'; from: 'GPU'; to: 'CPU'; reason: string }
  | { type: 'ERROR'; stage: 'init'; fatal: boolean; message: string }
  | { type: 'ERROR'; stage: 'detect'; fatal: boolean; message: string; requestId: number; captureEpoch: number };

export type SportActionEvent =
  | ActionBase & { type: 'sprint'; speed01: number; cadenceSpm: number }
  | ActionBase & { type: 'step'; side: Hand }
  | ActionBase & { type: 'jump' }
  | ActionBase & { type: 'lane'; direction: 'left' | 'right' }
  /**
   * Unconfirmed real-time notice that a wrist crossed the swing onset threshold — emitted on the
   * crossing frame, ~100-400 ms before the swing confirms (if it ever does). Backswings and
   * aborted motions fire it too: use it for animation, never for adjudication.
   */
  | ActionBase & { type: 'swing-start'; hand: Hand }
  | ActionBase & {
      type: 'swing';
      side: 'forehand' | 'backhand';
      power01: number;
      peakTimestampMs?: number;
      /** Frame where the onset threshold was crossed; the stroke's physical start. */
      onsetTimestampMs?: number;
      /** Wrist height relative to its shoulder at the speed peak, in shoulder widths, up positive. */
      contactY: number;
      /** Vertical wrist speed at the peak in shoulder widths/s, up positive — topspin/slice proxy. */
      verticalSpeed: number;
    };

export interface ContinuousControls {
  /** Always neutral when cadence tracking is degraded or lost. */
  sprintSpeed01: number;
  cadenceSpm: number;
  trackingState: TrackingState;
}

interface ActionBase {
  id: number;
  /**
   * 'tracked' events carry the video-frame timestamp that confirmed the action; swing also carries its estimated
   * peak-frame timestamp. Control events — emitted because the action's landmarks could not be confirmed — are
   * stamped with the frame that revealed the loss, or the capture-stop time when no frame exists. Injected
   * 'keyboard' events carry their injection time.
   */
  timestampMs: number;
  /** Confidence is the minimum visibility/presence for landmarks used by this action; 0 when no frame contributed. */
  confidence: number;
  /**
   * 'tracked' marks an action measured on a tracked pose; any other state marks a control event emitted because
   * the action's landmarks could not be confirmed — the sprint stop is 'degraded'/'lost' when tracking decays
   * or capture stops. Calibration absence gates calibration-dependent controls, never torso cadence itself.
   */
  trackingState: TrackingState;
  /** 'cv' events come from the pose pipeline; 'keyboard' events are injected controls, not pose measurements. */
  source: 'cv' | 'keyboard';
}
