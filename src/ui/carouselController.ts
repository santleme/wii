import type { RotationalFlickPhase } from '@wii/spatial-core';

export type CarouselControlMode = 'idle' | 'driving' | 'momentum' | 'braking' | 'snapping';

export interface CarouselGestureSample {
  phase: RotationalFlickPhase;
  /** Signed hand rotation already arbitrated by the gesture detector, in deg/s. */
  angularVelocityDegPerSec: number;
}

export interface CarouselControllerOptions {
  slotCount: number;
  initialTurn?: number;
  /** Carousel degrees per input degree. The sign is deliberate and configurable. */
  sensitivity?: number;
  /** Wheel angular speed ceiling; the design target is one visual revolution per second. */
  maxSpeedDegPerSec?: number;
  /** Exponential response time while the hand is actively driving the wheel. */
  driveResponseMs?: number;
  /** Exponential momentum decay time while the hand returns in RECOVERY. */
  recoveryDecayMs?: number;
  /** Exponential response time for an open-palm brake. */
  brakeResponseMs?: number;
  /** Fixed ease-in-out snap duration. */
  snapDurationMs?: number;
  /** Passive momentum may snap once it falls below this speed. */
  snapStartSpeedDegPerSec?: number;
  /** Reduced motion removes inertia-heavy settling and makes the snap effectively immediate. */
  reducedMotion?: boolean;
}

export interface CarouselStepResult {
  turn: number;
  /** Integer front channel derived from Math.round(turn), wrapped into 0..slotCount-1. */
  front: number;
  /** Current wheel angular velocity in visual deg/s. During snapping this is measured from interpolation. */
  velocityDegPerSec: number;
  mode: CarouselControlMode;
  /** True while the controller owns per-frame wheel placement instead of static React placement. */
  controlling: boolean;
  frontChanged: boolean;
  /** True on the frame where momentum/snap finishes and React should receive the final integer turn. */
  settled: boolean;
  dtMs: number;
}

const DEFAULTS = {
  sensitivity: 1,
  maxSpeedDegPerSec: 360,
  driveResponseMs: 90,
  recoveryDecayMs: 320,
  brakeResponseMs: 42,
  snapDurationMs: 220,
  snapStartSpeedDegPerSec: 18,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}

function easeInOut(progress: number): number {
  return progress * progress * (3 - 2 * progress);
}

interface SnapState {
  fromTurn: number;
  targetTurn: number;
  elapsedMs: number;
  durationMs: number;
}

/**
 * Frame-rate-independent wheel physics. The class owns continuous fractional turn state while a
 * gesture is active; callers render `turn` directly and synchronize React only on front/settled edges.
 */
export class CarouselController {
  private readonly slotCount: number;
  private readonly sensitivity: number;
  private readonly maxSpeedDegPerSec: number;
  private readonly driveResponseMs: number;
  private readonly recoveryDecayMs: number;
  private readonly brakeResponseMs: number;
  private readonly snapDurationMs: number;
  private readonly snapStartSpeedDegPerSec: number;
  private reducedMotion: boolean;
  private turn: number;
  private velocityDegPerSec = 0;
  private mode: CarouselControlMode = 'idle';
  private snap?: SnapState;
  private front: number;

  constructor(options: CarouselControllerOptions) {
    if (!Number.isInteger(options.slotCount) || options.slotCount <= 0)
      throw new Error('Carousel slotCount must be a positive integer');
    this.slotCount = options.slotCount;
    this.sensitivity = options.sensitivity ?? DEFAULTS.sensitivity;
    this.maxSpeedDegPerSec = options.maxSpeedDegPerSec ?? DEFAULTS.maxSpeedDegPerSec;
    this.driveResponseMs = options.driveResponseMs ?? DEFAULTS.driveResponseMs;
    this.recoveryDecayMs = options.recoveryDecayMs ?? DEFAULTS.recoveryDecayMs;
    this.brakeResponseMs = options.brakeResponseMs ?? DEFAULTS.brakeResponseMs;
    this.snapDurationMs = options.snapDurationMs ?? DEFAULTS.snapDurationMs;
    this.snapStartSpeedDegPerSec = options.snapStartSpeedDegPerSec ?? DEFAULTS.snapStartSpeedDegPerSec;
    this.reducedMotion = options.reducedMotion ?? false;
    if (!Number.isFinite(this.sensitivity) || this.sensitivity === 0)
      throw new Error('Carousel sensitivity must be a finite non-zero number');
    for (const [name, value] of [
      ['maxSpeedDegPerSec', this.maxSpeedDegPerSec],
      ['driveResponseMs', this.driveResponseMs],
      ['recoveryDecayMs', this.recoveryDecayMs],
      ['brakeResponseMs', this.brakeResponseMs],
      ['snapDurationMs', this.snapDurationMs],
      ['snapStartSpeedDegPerSec', this.snapStartSpeedDegPerSec],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`Carousel ${name} must be a positive finite number`);
    }
    this.turn = options.initialTurn ?? 0;
    if (!Number.isFinite(this.turn)) throw new Error('Carousel initialTurn must be finite');
    this.front = this.frontForTurn(this.turn);
  }

  get currentTurn(): number {
    return this.turn;
  }

  get isControlling(): boolean {
    return this.mode !== 'idle';
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.reducedMotion = reducedMotion;
  }

  /** External mouse/keyboard ownership sync: cancels gesture momentum and snap without inventing motion. */
  syncTurn(turn: number): void {
    if (!Number.isFinite(turn)) throw new Error('Carousel turn must be finite');
    this.turn = turn;
    this.velocityDegPerSec = 0;
    this.mode = 'idle';
    this.snap = undefined;
    this.front = this.frontForTurn(turn);
  }

  step(dtMs: number, gesture: CarouselGestureSample): CarouselStepResult {
    if (!Number.isFinite(dtMs) || dtMs < 0) throw new RangeError('Carousel dtMs must be a finite non-negative number');
    if (!Number.isFinite(gesture.angularVelocityDegPerSec))
      throw new RangeError('Carousel angular velocity must be finite');
    // rAF timestamps are real, but tab visibility can create an enormous first delta. Bounding that
    // one delta keeps physics stable while preserving exact timing inside normal 8–120 Hz operation.
    const boundedDtMs = Math.min(dtMs, 100);
    const dtSeconds = boundedDtMs / 1000;
    const wasControlling = this.mode !== 'idle';
    const previousTurn = this.turn;
    let completedSnap = false;

    if (this.snap) {
      this.advanceSnap(boundedDtMs);
      completedSnap = this.snap === undefined;
    } else {
      this.applyGesturePhysics(boundedDtMs, gesture);
      this.integrate(dtSeconds);
      completedSnap = this.maybeStartSnap(gesture);
    }

    const measuredVelocity =
      this.snap && dtSeconds > 0
        ? ((this.turn - previousTurn) * 360) / this.slotCount / dtSeconds
        : this.velocityDegPerSec;
    const nextFront = this.frontForTurn(this.turn);
    const frontChanged = nextFront !== this.front;
    this.front = nextFront;
    const controlling = this.mode !== 'idle';
    const settled = completedSnap || (wasControlling && !controlling);
    return {
      turn: this.turn,
      front: nextFront,
      velocityDegPerSec: measuredVelocity,
      mode: this.mode,
      controlling,
      frontChanged,
      settled,
      dtMs: boundedDtMs,
    };
  }

  private applyGesturePhysics(dtMs: number, gesture: CarouselGestureSample): void {
    const inputSpeed = clamp(
      gesture.angularVelocityDegPerSec * this.sensitivity,
      -this.maxSpeedDegPerSec,
      this.maxSpeedDegPerSec,
    );
    if (gesture.phase === 'ROTATING') {
      this.mode = 'driving';
      this.approachVelocity(inputSpeed, dtMs, this.driveResponseMs);
      return;
    }
    if (gesture.phase === 'BRAKING' || gesture.phase === 'SNAP_TO_CARD') {
      this.mode = 'braking';
      this.approachVelocity(0, dtMs, this.brakeResponseMs);
      return;
    }

    const hasMomentum = Math.abs(this.velocityDegPerSec) > 0.01;
    if (this.reducedMotion) {
      // Reduced motion removes the recovery tail; intentional driving above is still direct control.
      this.velocityDegPerSec = 0;
      this.mode = 'idle';
    } else if (hasMomentum) {
      this.mode = 'momentum';
      this.velocityDegPerSec *= Math.exp(-dtMs / this.recoveryDecayMs);
      if (Math.abs(this.velocityDegPerSec) <= 0.01) this.velocityDegPerSec = 0;
    } else {
      this.velocityDegPerSec = 0;
      this.mode = 'idle';
    }
  }

  private integrate(dtSeconds: number): void {
    this.turn += (this.velocityDegPerSec / 360) * this.slotCount * dtSeconds;
  }

  private maybeStartSnap(gesture: CarouselGestureSample): boolean {
    if (this.snap) return false;
    const targetTurn = Math.round(this.turn);
    const alignmentErrorDeg = ((targetTurn - this.turn) * 360) / this.slotCount;
    if (Math.abs(alignmentErrorDeg) < 1e-6 && Math.abs(this.velocityDegPerSec) < 0.01) {
      this.turn = targetTurn;
      this.velocityDegPerSec = 0;
      this.mode = 'idle';
      return false;
    }

    const snapRequested = gesture.phase === 'SNAP_TO_CARD';
    const passiveSettle =
      gesture.phase !== 'BRAKING' &&
      gesture.phase !== 'ROTATING' &&
      Math.abs(this.velocityDegPerSec) <= this.snapStartSpeedDegPerSec &&
      Math.abs(alignmentErrorDeg) >= 1e-6;
    if (!snapRequested && !passiveSettle) return false;
    return this.beginSnap(targetTurn);
  }

  private beginSnap(targetTurn: number): boolean {
    if (this.reducedMotion) {
      this.turn = targetTurn;
      this.velocityDegPerSec = 0;
      this.mode = 'idle';
      this.snap = undefined;
      return true;
    }
    this.mode = 'snapping';
    this.velocityDegPerSec = 0;
    this.snap = {
      fromTurn: this.turn,
      targetTurn,
      elapsedMs: 0,
      durationMs: clamp(this.snapDurationMs, 180, 250),
    };
    return false;
  }

  private advanceSnap(dtMs: number): void {
    const snap = this.snap;
    if (!snap) return;
    snap.elapsedMs += dtMs;
    const progress = clamp(snap.elapsedMs / snap.durationMs, 0, 1);
    this.turn = snap.fromTurn + (snap.targetTurn - snap.fromTurn) * easeInOut(progress);
    if (progress >= 1) {
      this.turn = snap.targetTurn;
      this.snap = undefined;
      this.mode = 'idle';
    }
  }

  private approachVelocity(targetDegPerSec: number, dtMs: number, responseMs: number): void {
    const alpha = 1 - Math.exp(-dtMs / responseMs);
    this.velocityDegPerSec += (targetDegPerSec - this.velocityDegPerSec) * alpha;
  }

  private frontForTurn(turn: number): number {
    return positiveModulo(Math.round(turn), this.slotCount);
  }
}
