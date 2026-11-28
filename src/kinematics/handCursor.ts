import {
  OneEuroFilter,
  RotationalFlickDetector,
  type Hand,
  type OneEuroOptions,
  type PalmBasis,
  type Point3,
  type RotationalFlickOptions,
  type RotationalFlickPhase,
  type RotationalFlickRejection,
  type RotationalFlickState,
  type RotationalHandShape,
} from '@wii/spatial-core';
import { clamp } from './math';

export interface MenuHandSnapshot {
  timestampMs: number;
  landmarks: readonly Point3[];
  handedness?: Hand | 'Left' | 'Right';
  /** bitmap.height / bitmap.width; corrige distâncias normalizadas fora do quadrado. */
  aspectY?: number;
  /** Métricas 3D da mão no espaço da câmera, necessárias apenas para o flick rotacional. */
  worldLandmarks?: readonly Point3[];
  /** O gesto rotacional só é alimentado quando a HomeMenu expõe a roda interativa. */
  rotationEnabled?: boolean;
}

export interface HandCursorZone {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface HandCursorOptions {
  activeZone?: HandCursorZone;
  syncDurationMs?: number;
  maxFrameGapMs?: number;
  lossGraceMs?: number;
  pointerAnchor?: 'tip' | 'midIndex' | 'middleMcp';
  smoothing?: OneEuroOptions;
  pinchOnRatio?: number;
  pinchOffRatio?: number;
  pinchCooldownMs?: number;
  /** Tempo mínimo com os dedos juntos antes de confirmar um clique. */
  pinchPressMs?: number;
  backHoldMs?: number;
  fistEnterStraightness?: number;
  fistReleaseStraightness?: number;
  rotation?: RotationalFlickOptions;
}

export interface HandCursorState {
  visible: boolean;
  /** Posição horizontal normalizada da tela; a UI multiplica pela largura da viewport. */
  x: number;
  /** Posição vertical normalizada da tela; a UI multiplica pela altura da viewport. */
  y: number;
  syncProgress: number;
  synced: boolean;
  pinching: boolean;
  /** Pulso de clique confirmado na ativação da pinça; não indica a soltura física dos dedos. */
  pinchRelease: boolean;
  backProgress: number;
  activeZone: HandCursorZone;
  rotationPhase: RotationalFlickPhase;
  /** Velocidade sanitizada que o carrossel pode consumir, em deg/s. */
  rotationAngularVelocity: number;
  /** Velocidade física filtrada após sensibilidade, em deg/s; diagnóstico apenas. */
  rotationFilteredAngularVelocity: number;
  rotationRawAngularVelocity: number;
  rotationDirection: -1 | 0 | 1;
  rotationCurvature: number;
  rotationHandShape: RotationalHandShape;
  rotationRejectReason?: RotationalFlickRejection;
  rotationDtMs?: number;
  rotationOrientation?: PalmBasis;
}

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;
const FINGERS = [
  [INDEX_MCP, INDEX_PIP, 7, INDEX_TIP],
  [MIDDLE_MCP, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
] as const;
const DEFAULT_ZONE: HandCursorZone = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
/** Light on purpose: MediaPipe's VIDEO mode already smooths the landmarks. */
const DEFAULT_HAND_SMOOTHING: OneEuroOptions = { minCutoff: 2.2, beta: 2.0, derivativeCutoff: 1.0 };
const SCALE_MIN = 0.1;
const SCALE_MAX = 0.3;
const MAX_MARGIN = 0.27;
const SCALE_TAU_MS = 1200;
/** Smaller scale changes leave the active zone alone, so tilting the palm does not move the cursor. */
const SCALE_DEADBAND = 0.015;
/** Shorter observation gaps keep the pointer filters and hand scale: late inference, not a new hand. */
const FILTER_RESET_GAP_MS = 500;

/** A sync survives missing frames this short: they neither hide the cursor nor stop its count. */
const PRESENCE_GAP_MS = 150;

/**
 * True once a rotation is committed: the cursor freezes and hover is suspended. A mere candidate
 * or a cancelled one must not make the cursor stick, though neither may click or go back.
 */
export function rotationBlocksHandInput(phase: RotationalFlickPhase): boolean {
  return phase !== 'IDLE' && phase !== 'ROTATION_CANDIDATE' && phase !== 'CANCELLED';
}

function finite(point: Point3 | undefined): point is Point3 {
  return point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function imageDistance(a: Point3, b: Point3, aspectY: number): number {
  return Math.hypot(a.x - b.x, (a.y - b.y) * aspectY);
}

function usableHand(points: readonly Point3[], aspectY: number): boolean {
  if (points.length < 21) return false;
  for (let index = 0; index < 21; index++) if (!finite(points[index])) return false;
  if (imageDistance(points[WRIST]!, points[MIDDLE_MCP]!, aspectY) < 0.03) return false;
  const xs = points.slice(0, 21).map((point) => point.x);
  const ys = points.slice(0, 21).map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = (Math.max(...ys) - Math.min(...ys)) * aspectY;
  const boxRatio = width / Math.max(height, 1e-6);
  return boxRatio >= 0.25 && boxRatio <= 3.5;
}

function pinchRatio(points: readonly Point3[], aspectY: number): number {
  const scale = imageDistance(points[WRIST]!, points[MIDDLE_MCP]!, aspectY);
  if (scale <= 1e-6) return Number.POSITIVE_INFINITY;
  return imageDistance(points[THUMB_TIP]!, points[INDEX_TIP]!, aspectY) / scale;
}

function fingerStraightness(
  points: readonly Point3[],
  chain: readonly [number, number, number, number],
  aspectY: number,
): number | undefined {
  const [mcp, pip, dip, tip] = chain;
  const segments =
    imageDistance(points[mcp]!, points[pip]!, aspectY) +
    imageDistance(points[pip]!, points[dip]!, aspectY) +
    imageDistance(points[dip]!, points[tip]!, aspectY);
  if (segments <= 1e-6) return undefined;
  return imageDistance(points[mcp]!, points[tip]!, aspectY) / segments;
}

function maxFingerStraightness(points: readonly Point3[], aspectY: number): number | undefined {
  const values = FINGERS.map((chain) => fingerStraightness(points, chain, aspectY));
  if (values.some((value) => value === undefined)) return undefined;
  return Math.max(...(values as number[]));
}

function closedFist(
  points: readonly Point3[],
  active: boolean,
  enterStraightness: number,
  releaseStraightness: number,
  aspectY: number,
): boolean {
  const straightness = maxFingerStraightness(points, aspectY);
  if (straightness === undefined) return false;
  if (active) return straightness < releaseStraightness;
  return straightness < enterStraightness;
}

function validZone(zone: HandCursorZone): boolean {
  return (
    zone.minX >= 0 &&
    zone.minX < zone.maxX &&
    zone.maxX <= 1 &&
    zone.minY >= 0 &&
    zone.minY < zone.maxY &&
    zone.maxY <= 1
  );
}

export class HandCursorDetector {
  private readonly initialZone: HandCursorZone;
  private activeZone: HandCursorZone;
  private readonly fixedZone: boolean;
  private smoothedScale?: number;
  private zoneScale?: number;
  private readonly syncDurationMs: number;
  private readonly maxFrameGapMs: number;
  private readonly lossGraceMs: number;
  private readonly pointerAnchor: 'tip' | 'midIndex' | 'middleMcp';
  private readonly backHoldMs: number;
  private readonly fistEnterStraightness: number;
  private readonly fistReleaseStraightness: number;
  private readonly xFilter: OneEuroFilter;
  private readonly yFilter: OneEuroFilter;
  private readonly pinchOnRatio: number;
  private readonly pinchOffRatio: number;
  private readonly pinchCooldownMs: number;
  private readonly pinchPressMs: number;
  private readonly rotationDetector: RotationalFlickDetector;
  private pinchActive = false;
  private pinchCandidateSinceMs?: number;
  private presenceMs = 0;
  private synced = false;
  private lostSinceMs?: number;
  private missingSinceMs?: number;
  private lastTimestampMs?: number;
  private frozenPosition?: { x: number; y: number };
  private lastFreePosition?: { x: number; y: number };
  private lastPosition?: { x: number; y: number };
  private backSinceMs?: number;
  private fistActive = false;
  private pinchNeedsRelease = false;
  private fistNeedsOpen = false;
  private lastPinchClickAt = Number.NEGATIVE_INFINITY;

  constructor(options: HandCursorOptions = {}) {
    this.initialZone = { ...(options.activeZone ?? DEFAULT_ZONE) };
    if (!validZone(this.initialZone)) throw new Error('Hand cursor active zone must be inside 0..1 with min < max');
    this.activeZone = { ...this.initialZone };
    this.fixedZone = options.activeZone !== undefined;
    this.syncDurationMs = options.syncDurationMs ?? 200;
    this.maxFrameGapMs = options.maxFrameGapMs ?? 250;
    this.lossGraceMs = options.lossGraceMs ?? 650;
    this.pointerAnchor = options.pointerAnchor ?? 'middleMcp';
    this.backHoldMs = options.backHoldMs ?? 500;
    this.fistEnterStraightness = options.fistEnterStraightness ?? 0.65;
    this.fistReleaseStraightness = options.fistReleaseStraightness ?? 0.8;
    if (this.fistEnterStraightness >= this.fistReleaseStraightness)
      throw new Error('Fist enter straightness must be below release straightness');
    this.pinchOnRatio = options.pinchOnRatio ?? 0.25;
    this.pinchOffRatio = options.pinchOffRatio ?? 0.45;
    if (this.pinchOnRatio >= this.pinchOffRatio) throw new Error('Pinch on-ratio must be below the off-ratio');
    this.pinchCooldownMs = options.pinchCooldownMs ?? 250;
    this.pinchPressMs = options.pinchPressMs ?? 90;
    this.xFilter = new OneEuroFilter(options.smoothing ?? DEFAULT_HAND_SMOOTHING);
    this.yFilter = new OneEuroFilter(options.smoothing ?? DEFAULT_HAND_SMOOTHING);
    // A imagem inferida não é espelhada, mas a prévia e o cursor são. O sinal negativo faz
    // velocidade positiva significar rotação horária na experiência visual do usuário.
    this.rotationDetector = new RotationalFlickDetector({ sensitivity: -1, ...(options.rotation ?? {}) });
  }

  update(snapshot: MenuHandSnapshot): HandCursorState {
    const aspectY = snapshot.aspectY ?? 1;
    // The handedness score is not a landmark confidence (it drops as the hand turns or closes),
    // so geometry alone decides whether the hand is usable.
    if (!usableHand(snapshot.landmarks, aspectY)) return this.missing(snapshot);

    const points = snapshot.landmarks;
    const timestampMs = snapshot.timestampMs;
    if (this.lostSinceMs !== undefined && timestampMs - this.lostSinceMs >= this.lossGraceMs) {
      this.synced = false;
      this.presenceMs = 0;
      this.smoothedScale = undefined;
    }
    const raw = this.pointer(points);
    const gap = this.lastTimestampMs === undefined ? 0 : timestampMs - this.lastTimestampMs;
    const absenceMs = this.missingSinceMs === undefined ? 0 : timestampMs - this.missingSinceMs;
    const countedPresenceGap = absenceMs > PRESENCE_GAP_MS ? 0 : gap;
    const brokenTimeline = this.lastTimestampMs !== undefined && (gap < 0 || gap > this.maxFrameGapMs);
    if (gap < 0 || gap > Math.max(FILTER_RESET_GAP_MS, this.maxFrameGapMs)) {
      this.xFilter.reset();
      this.yFilter.reset();
      this.smoothedScale = undefined;
    }
    // Held gestures rearm much sooner than the filters reset: unobserved time must never
    // complete a click or a back gesture.
    if (brokenTimeline) {
      if (gap < 0) this.presenceMs = 0;
      this.lastFreePosition = undefined;
      this.pinchActive = false;
      this.pinchCandidateSinceMs = undefined;
      this.pinchNeedsRelease = true;
      this.fistActive = false;
      this.fistNeedsOpen = true;
      this.backSinceMs = undefined;
    }
    this.lastTimestampMs = timestampMs;
    this.lostSinceMs = undefined;
    this.missingSinceMs = undefined;

    const justSynced = !this.synced && this.updateSync(countedPresenceGap);
    if (justSynced) {
      this.xFilter.reset();
      this.yFilter.reset();
    }

    if (!this.fixedZone) {
      const rawScale = Math.max(
        imageDistance(points[WRIST]!, points[MIDDLE_MCP]!, aspectY),
        imageDistance(points[INDEX_MCP]!, points[PINKY_MCP]!, aspectY),
      );
      if (this.smoothedScale === undefined) {
        this.smoothedScale = rawScale;
        this.zoneScale = rawScale;
      } else {
        const alpha = 1 - Math.exp(-Math.max(gap, 0) / SCALE_TAU_MS);
        this.smoothedScale += alpha * (rawScale - this.smoothedScale);
      }
      if (this.zoneScale === undefined || Math.abs(this.smoothedScale - this.zoneScale) > SCALE_DEADBAND)
        this.zoneScale = this.smoothedScale;
      const margin = clamp((this.zoneScale - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * MAX_MARGIN;
      this.activeZone = { minX: margin, maxX: 1 - margin, minY: margin, maxY: 1 - margin };
    }

    const mapped = this.mapToScreen(raw);
    const smoothX = this.xFilter.filter(mapped.x, timestampMs);
    const smoothY = this.yFilter.filter(mapped.y, timestampMs);

    const rotation = this.updateRotation(snapshot, true);
    const rotationBlocking = rotationBlocksHandInput(rotation.phase);

    const straightness = maxFingerStraightness(points, aspectY);
    if (straightness !== undefined && straightness >= this.fistReleaseStraightness) this.fistNeedsOpen = false;

    let pinching = false;
    let pinchCandidate = false;
    let pinchRelease = false;
    let backProgress = 0;
    let fist = false;
    if (this.synced) {
      const updatePinch = () => {
        const ratio = pinchRatio(points, aspectY);
        if (this.pinchNeedsRelease) {
          this.pinchActive = false;
          this.pinchCandidateSinceMs = undefined;
          if (ratio >= this.pinchOffRatio) this.pinchNeedsRelease = false;
          return;
        }
        if (this.pinchActive) {
          if (ratio >= this.pinchOffRatio) this.pinchActive = false;
          pinching = this.pinchActive;
          return;
        }
        if (ratio > this.pinchOnRatio) {
          this.pinchCandidateSinceMs = undefined;
          return;
        }
        this.pinchCandidateSinceMs ??= timestampMs;
        if (timestampMs - this.pinchCandidateSinceMs < this.pinchPressMs) {
          pinchCandidate = true;
          return;
        }
        this.pinchCandidateSinceMs = undefined;
        this.pinchActive = true;
        pinching = true;
        if (timestampMs - this.lastPinchClickAt >= this.pinchCooldownMs) {
          this.lastPinchClickAt = timestampMs;
          pinchRelease = true;
        }
      };
      // Any rotation activity rearms click and back, so a flick in progress never triggers them.
      if (rotation.phase !== 'IDLE') {
        this.pinchActive = false;
        this.pinchCandidateSinceMs = undefined;
        this.pinchNeedsRelease = true;
        this.fistActive = false;
        this.fistNeedsOpen = true;
        this.backSinceMs = undefined;
      } else if (this.fistActive) {
        this.fistActive = closedFist(points, true, this.fistEnterStraightness, this.fistReleaseStraightness, aspectY);
        fist = this.fistActive;
        if (fist) {
          this.pinchActive = false;
          this.pinchCandidateSinceMs = undefined;
          this.pinchNeedsRelease = true;
          this.backSinceMs ??= timestampMs;
          backProgress = clamp((timestampMs - this.backSinceMs) / this.backHoldMs);
        } else {
          this.backSinceMs = undefined;
          updatePinch();
        }
      } else {
        const pinchWasActive = this.pinchActive;
        updatePinch();
        this.backSinceMs = undefined;
        if (
          pinching &&
          !pinchWasActive &&
          closedFist(points, false, this.fistEnterStraightness, this.fistReleaseStraightness, aspectY)
        ) {
          pinching = false;
          pinchRelease = false;
          this.pinchActive = false;
          this.pinchCandidateSinceMs = undefined;
          this.pinchNeedsRelease = true;
          this.fistActive = true;
          fist = true;
          this.backSinceMs = timestampMs;
        }
        if (!pinching && !fist && !this.fistNeedsOpen) {
          this.fistActive = closedFist(
            points,
            false,
            this.fistEnterStraightness,
            this.fistReleaseStraightness,
            aspectY,
          );
          fist = this.fistActive;
          if (fist) {
            this.pinchActive = false;
            this.pinchCandidateSinceMs = undefined;
            this.pinchNeedsRelease = true;
            this.backSinceMs = timestampMs;
          }
        }
      }
    } else {
      this.pinchActive = false;
      this.pinchCandidateSinceMs = undefined;
      this.pinchNeedsRelease = true;
      this.fistNeedsOpen = true;
      this.backSinceMs = undefined;
      this.fistActive = false;
    }

    const candidate = { x: clamp(smoothX), y: clamp(smoothY) };
    if (pinching || pinchCandidate || fist || rotationBlocking) this.frozenPosition ??= this.lastFreePosition ?? candidate;
    else this.frozenPosition = undefined;
    const position = this.frozenPosition ?? candidate;
    if (!pinching && !pinchCandidate && !fist && !rotationBlocking) this.lastFreePosition = candidate;
    this.lastPosition = position;
    return {
      // Visible while still syncing, so the progress ring can be seen.
      visible: true,
      x: position.x,
      y: position.y,
      syncProgress: this.synced ? 1 : this.syncProgress(),
      synced: this.synced,
      pinching,
      pinchRelease,
      backProgress,
      activeZone: { ...this.activeZone },
      ...this.rotationOutput(rotation),
    };
  }

  reset(): void {
    this.synced = false;
    this.presenceMs = 0;
    this.activeZone = { ...this.initialZone };
    this.smoothedScale = undefined;
    this.lostSinceMs = undefined;
    this.missingSinceMs = undefined;
    this.lastTimestampMs = undefined;
    this.frozenPosition = undefined;
    this.lastFreePosition = undefined;
    this.lastPosition = undefined;
    this.backSinceMs = undefined;
    this.fistActive = false;
    this.pinchNeedsRelease = false;
    this.fistNeedsOpen = false;
    this.lastPinchClickAt = Number.NEGATIVE_INFINITY;
    this.xFilter.reset();
    this.yFilter.reset();
    this.pinchActive = false;
    this.pinchCandidateSinceMs = undefined;
    this.rotationDetector.reset();
  }

  private missing(snapshot: MenuHandSnapshot): HandCursorState {
    const timestampMs = snapshot.timestampMs;
    const rotation = this.updateRotation(snapshot, false);
    this.missingSinceMs ??= timestampMs;
    if (this.synced) {
      this.lostSinceMs ??= timestampMs;
      if (timestampMs - this.lostSinceMs >= this.lossGraceMs) {
        this.synced = false;
        this.presenceMs = 0;
        this.smoothedScale = undefined;
      }
    }
    this.pinchActive = false;
    this.pinchCandidateSinceMs = undefined;
    this.pinchNeedsRelease = true;
    this.fistNeedsOpen = true;
    this.frozenPosition = undefined;
    this.lastFreePosition = undefined;
    this.backSinceMs = undefined;
    this.fistActive = false;
    const position = this.lastPosition ?? { x: 0, y: 0 };
    const stillSyncing =
      !this.synced && this.lastPosition !== undefined && timestampMs - this.missingSinceMs <= PRESENCE_GAP_MS;
    return {
      visible: this.synced || stillSyncing,
      x: position.x,
      y: position.y,
      syncProgress: this.synced ? 1 : stillSyncing ? this.syncProgress() : 0,
      synced: this.synced,
      pinching: false,
      pinchRelease: false,
      backProgress: 0,
      activeZone: { ...this.activeZone },
      ...this.rotationOutput(rotation),
    };
  }

  private updateRotation(snapshot: MenuHandSnapshot, useWorldLandmarks: boolean): RotationalFlickState {
    if (snapshot.rotationEnabled !== true) {
      return this.rotationDetector.update({ timestampMs: snapshot.timestampMs, enabled: false });
    }
    return this.rotationDetector.update({
      timestampMs: snapshot.timestampMs,
      worldLandmarks: useWorldLandmarks ? snapshot.worldLandmarks : undefined,
      handedness: snapshot.handedness,
    });
  }

  private rotationOutput(rotation: RotationalFlickState) {
    return {
      rotationPhase: rotation.phase,
      rotationAngularVelocity: rotation.controlAngularVelocityDegPerSec,
      rotationFilteredAngularVelocity: rotation.angularVelocityDegPerSec,
      rotationRawAngularVelocity: rotation.rawAngularVelocityDegPerSec,
      rotationDirection: rotation.direction,
      rotationCurvature: rotation.curvature,
      rotationHandShape: rotation.handShape,
      rotationRejectReason: rotation.rejectionReason,
      rotationDtMs: rotation.dtMs,
      rotationOrientation: rotation.orientation,
    };
  }

  private pointer(points: readonly Point3[]): { x: number; y: number } {
    if (this.pointerAnchor === 'middleMcp') return { x: 1 - points[MIDDLE_MCP]!.x, y: points[MIDDLE_MCP]!.y };
    const tip = points[INDEX_TIP]!;
    const base = points[INDEX_MCP]!;
    const cameraX = this.pointerAnchor === 'tip' ? tip.x : (tip.x + base.x) / 2;
    const cameraY = this.pointerAnchor === 'tip' ? tip.y : (tip.y + base.y) / 2;
    return { x: 1 - cameraX, y: cameraY };
  }

  private mapToScreen(point: { x: number; y: number }): { x: number; y: number } {
    return {
      x: (point.x - this.activeZone.minX) / (this.activeZone.maxX - this.activeZone.minX),
      y: (point.y - this.activeZone.minY) / (this.activeZone.maxY - this.activeZone.minY),
    };
  }

  private syncProgress(): number {
    return clamp(this.presenceMs / this.syncDurationMs);
  }

  private updateSync(frameGapMs: number): boolean {
    this.presenceMs += Math.min(Math.max(frameGapMs, 0), 100);
    if (this.presenceMs < this.syncDurationMs) return false;
    this.synced = true;
    return true;
  }
}
