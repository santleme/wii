import type { CalibrationProfile, Hand, Point3, PoseSnapshot } from './protocol';
import { OneEuroFilter } from '@wii/spatial-core';
import { bodyLocalPoint } from '../kinematics/bodyFrame';
import { EXIT_LANE_SW } from '../kinematics/postureSignals';
import { clamp, distance3, isFinitePoint, landmarkConfidence, median, midpoint } from '../kinematics/math';

const UPPER_CORE = [11, 12] as const;
const WRIST_INDEX: Record<Hand, 15 | 16> = { left: 15, right: 16 };
const MIN_CONFIDENCE = 0.55;
const CORE_WINDOW_MS = 8000;
const WRIST_WINDOW_MS = 12000;
const MIN_PUBLISH_SPAN_MS = 700;
const MIN_CORE_SAMPLES = 10;
const MAX_CORE_OBSERVATION_GAP_MS = 200;
const MIN_CORE_COVERED_MS = 500;
const CORE_COVERAGE_RATIO = 0.65;
const UPDATE_INTERVAL_MS = 250;
/** Sustained starvation of near-center evidence before the player is treated as relocated, not leaning. */
const CENTER_RELOCATION_MS = 30000;
/** Below this much weighted posture evidence the neutral estimate does not publish — control input is not posture. */
const MIN_CENTER_EVIDENCE = 2;
/** Center-x mode bins in normalized image units — smaller than shoulder-jitter so noise clouds cluster. */
const CENTER_BIN = 0.005;
const CENTER_CLUSTER_RADIUS = 0.01;
const SCALE_ALPHA = 0.02;
const POSE_ALPHA = 0.015;
const CHANGE_POINT_POSE_ALPHA = 0.06;
const CHANGE_POINT_SCALE_ALPHA = 0.08;
const WRIST_ALPHA = 0.06;
const CHANGE_POINT_EVIDENCE_MS = 10000;
const WRIST_LOW_SPEED_BODY_WIDTHS_PER_SEC = 0.8;
const WRIST_CLUSTER_RADIUS_BODY_WIDTHS = 0.28;
const WRIST_MAX_DISPERSION_BODY_WIDTHS = 0.2;
const WRIST_EPISODE_GAP_MS = 700;
const WRIST_OBSERVATION_INTERVAL_MS = 50;
const WRIST_SINGLE_EPISODE_MIN_SPAN_MS = 2500;

interface CoreObservation {
  timestampMs: number;
  confidence: number;
  shoulderWidth: number;
  /** Shoulder-center x in normalized image coordinates — the lane-control neutral evidence. */
  shoulderCenterX: number;
  /** Image-space shoulder width of the same frame; normalizes center deviations scale-free. */
  imageShoulderWidth: number;
  /**
   * The lane zone when this frame was captured. Admission is a property of the moment the
   * evidence was produced — never of the present — or returning to center would retroactively
   * admit every held-lane sample still inside the rolling window and the mode would chase it.
   */
  laneZone: -1 | 0 | 1;
}

interface CoreFrameValidity {
  timestampMs: number;
  valid: boolean;
}

interface WristObservation {
  timestampMs: number;
  confidence: number;
  point: Point3;
}

interface WristState {
  filters: { x: OneEuroFilter; y: OneEuroFilter; z: OneEuroFilter };
  previous?: { timestampMs: number; point: Point3 };
  observations: WristObservation[];
}

function blend(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function confident(point: Point3 | undefined): point is Point3 {
  return isFinitePoint(point) && landmarkConfidence(point) >= MIN_CONFIDENCE;
}

/** Histogram mode followed by a local median; better than a mean when gameplay alternates postures. */
function scalarMode(
  samples: readonly { value: number; confidence: number }[],
  binWidth: number,
  clusterRadius: number,
): { value: number; strength01: number; dispersion: number } | undefined {
  if (!samples.length) return undefined;
  const bins = new Map<number, number>();
  const totalWeight = samples.reduce((sum, sample) => sum + sample.confidence, 0);
  for (const sample of samples) {
    const bin = Math.round(sample.value / binWidth);
    bins.set(bin, (bins.get(bin) ?? 0) + sample.confidence);
  }
  const [bestBin] = [...bins.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const center = bestBin * binWidth;
  // Zero-confidence samples are gated-out control input, not posture: they must not pull the
  // median even when they fall inside the winning bin's image-space cluster.
  const cluster = samples.filter((sample) => sample.confidence > 0 && Math.abs(sample.value - center) <= clusterRadius);
  const value = median(cluster.map((sample) => sample.value));
  const clusterWeight = cluster.reduce((sum, sample) => sum + sample.confidence, 0);
  return {
    value,
    strength01: totalWeight > 0 ? clamp(clusterWeight / totalWeight) : 0,
    dispersion: median(cluster.map((sample) => Math.abs(sample.value - value))),
  };
}

function coveredDurationMs(samples: readonly CoreFrameValidity[], startMs: number, endMs: number): number {
  let covered = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const weight = (previous.valid ? 0.5 : 0) + (current.valid ? 0.5 : 0);
    if (weight === 0) continue;
    const gap = current.timestampMs - previous.timestampMs;
    if (gap <= 0 || gap > MAX_CORE_OBSERVATION_GAP_MS) continue;
    covered += (Math.min(endMs, current.timestampMs) - Math.max(startMs, previous.timestampMs)) * weight;
  }
  return Math.max(0, covered);
}

function makeWristState(): WristState {
  return {
    filters: { x: new OneEuroFilter(), y: new OneEuroFilter(), z: new OneEuroFilter() },
    observations: [],
  };
}

/**
 * Implicit, online calibration. Instead of asking for a calibration pose, the estimator treats
 * gameplay itself as a stream of noisy evidence: constant quantities (shoulder width) use robust
 * rolling medians; neutral posture uses temporal consensus/mode estimation; wrist ready positions
 * use recurrent low-speed spatial clusters. Published references move slowly, so detection uses a
 * stable scale while the model keeps improving invisibly in the background.
 */
export class AdaptiveCalibrator {
  private coreObservations: CoreObservation[] = [];
  private coreFrameValidity: CoreFrameValidity[] = [];
  private readonly wrists: Record<Hand, WristState> = { left: makeWristState(), right: makeWristState() };
  private published?: CalibrationProfile;
  private lastPublishAt = Number.NEGATIVE_INFINITY;
  private scaleDisagreementSince?: number;
  private poseDisagreementSince?: number;
  private centerStarvedSince?: number;
  private laneZone: -1 | 0 | 1 = 0;
  private centerBandSw = EXIT_LANE_SW;

  /**
   * Consumes one frame. `laneZone` is the lane state machine's current zone: it is the only
   * reliable discriminator between stance and control input inside the hysteresis band — while
   * the zone is center, no lane is held, so a band displacement must be the player's stance.
   * `centerBandSw` is that machine's return-to-center displacement: boxing's dodge is far tighter.
   */
  update(snapshot: PoseSnapshot, laneZone: -1 | 0 | 1, centerBandSw = EXIT_LANE_SW): CalibrationProfile | undefined {
    this.centerBandSw = centerBandSw;
    const now = snapshot.timestampMs;
    this.laneZone = laneZone;
    const core = this.extractCore(snapshot);
    this.coreFrameValidity.push({ timestampMs: now, valid: core !== undefined });
    if (core) {
      this.coreObservations.push(core);
      this.observeWrists(snapshot);
    }
    this.prune(now);

    if (!this.hasEnoughCore()) return this.published;
    if (now - this.lastPublishAt < UPDATE_INTERVAL_MS) return this.published;

    const estimate = this.estimate(now);
    if (!estimate) return this.published;
    this.published = this.published ? this.blendProfile(this.published, estimate, now) : estimate;
    this.lastPublishAt = now;
    return this.published;
  }

  private extractCore(snapshot: PoseSnapshot): CoreObservation | undefined {
    const image = snapshot.landmarks;
    const world = snapshot.worldLandmarks;
    const imageShoulders = UPPER_CORE.map((index) => image[index]);
    const worldShoulders = UPPER_CORE.map((index) => world[index]);
    if (!imageShoulders.every(confident) || !worldShoulders.every(confident)) return undefined;

    const leftShoulder = image[11]!;
    const rightShoulder = image[12]!;
    const leftHip = image[23];
    const rightHip = image[24];
    const worldLeftShoulder = world[11]!;
    const worldRightShoulder = world[12]!;
    const worldLeftHip = world[23];
    const worldRightHip = world[24];
    const aspect = snapshot.frameHeight / snapshot.frameWidth;
    const imageShoulderWidth = Math.hypot(leftShoulder.x - rightShoulder.x, (leftShoulder.y - rightShoulder.y) * aspect);
    const shoulderWidth = distance3(worldLeftShoulder, worldRightShoulder);
    if (imageShoulderWidth < 0.03 || shoulderWidth < 0.03) return undefined;
    if (confident(leftHip) && confident(rightHip)) {
      const shoulderCenter = midpoint(leftShoulder, rightShoulder);
      const hipCenter = midpoint(leftHip, rightHip);
      if (Math.abs(hipCenter.y - shoulderCenter.y) < 0.03) return undefined;
    }

    const corePoints: Point3[] = [worldLeftShoulder, worldRightShoulder, leftShoulder, rightShoulder];
    if (confident(worldLeftHip) && confident(worldRightHip) && confident(leftHip) && confident(rightHip)) {
      corePoints.push(worldLeftHip, worldRightHip, leftHip, rightHip);
    }

    return {
      timestampMs: snapshot.timestampMs,
      confidence: landmarkConfidence(...corePoints),
      shoulderWidth,
      shoulderCenterX: (leftShoulder.x + rightShoulder.x) / 2,
      imageShoulderWidth,
      laneZone: this.laneZone,
    };
  }

  private observeWrists(snapshot: PoseSnapshot): void {
    const scale = this.published?.world.shoulderWidth ?? median(this.coreObservations.map((sample) => sample.shoulderWidth));
    for (const hand of ['left', 'right'] as const) {
      const index = WRIST_INDEX[hand];
      const wrist = snapshot.worldLandmarks[index];
      const imageWrist = snapshot.landmarks[index];
      if (!confident(wrist) || !confident(imageWrist)) {
        this.wrists[hand].previous = undefined;
        continue;
      }
      const shoulder = snapshot.worldLandmarks[hand === 'left' ? 11 : 12];
      const local = shoulder && bodyLocalPoint(
        wrist,
        shoulder,
        snapshot.worldLandmarks[11]!,
        snapshot.worldLandmarks[12]!,
        snapshot.worldLandmarks[23]!,
        snapshot.worldLandmarks[24]!,
        scale,
      );
      if (!local) continue;
      const filters = this.wrists[hand].filters;
      // Evidence must match the swing detector's reference frame: body-relative shoulder-width
      // units. Whole-body bobbing or yaw therefore does not masquerade as wrist motion.
      const filtered = {
        x: filters.x.filter(local.x, snapshot.timestampMs),
        y: filters.y.filter(local.y, snapshot.timestampMs),
        z: filters.z.filter(local.z, snapshot.timestampMs),
      };
      const previous = this.wrists[hand].previous;
      const gapMs = previous ? snapshot.timestampMs - previous.timestampMs : 0;
      const speed = previous && gapMs > 0 && gapMs <= 150
        ? distance3(filtered, previous.point) / (gapMs / 1000)
        : undefined;
      this.wrists[hand].previous = { timestampMs: snapshot.timestampMs, point: filtered };
      if (speed === undefined || speed >= WRIST_LOW_SPEED_BODY_WIDTHS_PER_SEC) continue;
      const observations = this.wrists[hand].observations;
      const lastObservation = observations.at(-1);
      if (lastObservation !== undefined && snapshot.timestampMs - lastObservation.timestampMs < WRIST_OBSERVATION_INTERVAL_MS) continue;
      observations.push({
        timestampMs: snapshot.timestampMs,
        confidence: landmarkConfidence(wrist, imageWrist),
        point: filtered,
      });
    }
  }

  private prune(now: number): void {
    this.coreObservations = this.coreObservations.filter((sample) => now - sample.timestampMs <= CORE_WINDOW_MS);
    this.coreFrameValidity = this.coreFrameValidity.filter((sample) => now - sample.timestampMs <= CORE_WINDOW_MS);
    for (const hand of ['left', 'right'] as const) {
      this.wrists[hand].observations = this.wrists[hand].observations.filter((sample) => now - sample.timestampMs <= WRIST_WINDOW_MS);
    }
  }

  private coreCoverage(): { spanMs: number; coveredMs: number; ratio: number } {
    const first = this.coreObservations[0]?.timestampMs ?? 0;
    const last = this.coreObservations.at(-1)?.timestampMs ?? 0;
    const spanMs = Math.max(0, last - first);
    const coveredMs = coveredDurationMs(this.coreFrameValidity, first, last);
    return { spanMs, coveredMs, ratio: spanMs > 0 ? coveredMs / spanMs : 0 };
  }

  private hasEnoughCore(): boolean {
    if (this.coreObservations.length < MIN_CORE_SAMPLES) return false;
    const coverage = this.coreCoverage();
    return coverage.spanMs >= MIN_PUBLISH_SPAN_MS
      && coverage.coveredMs >= MIN_CORE_COVERED_MS
      && coverage.ratio >= CORE_COVERAGE_RATIO;
  }

  private estimate(now: number): CalibrationProfile | undefined {
    const shoulderWidth = median(this.coreObservations.map((sample) => sample.shoulderWidth));
    if (!Number.isFinite(shoulderWidth) || shoulderWidth <= 0) return undefined;

    const priorCenterX = this.published?.image.shoulderCenterX0;
    // Neutral evidence is posture, never control input: inside an active side lane everything
    // is control and contributes nothing — otherwise a long hold would recentre the reference
    // and the return to center would read as the opposite lane.
    const deviations = this.coreObservations.map((sample) => ({
      sample,
      deviationSw: priorCenterX === undefined ? 0 : Math.abs(sample.shoulderCenterX - priorCenterX) / sample.imageShoulderWidth,
    }));
    // The lane zone is the discriminator the bare distance cannot be: inside the hysteresis
    // band (between EXIT and ENTER) a displacement is control input when a lane is active, but
    // it is the player's stance when the zone is center — no lane was ever entered to hold.
    // Zone-center evidence is therefore admitted at any deviation: transitory dodge frames leak
    // in, but they are brief and symmetric while stance is sustained, and the mode is consensus.
    const isPosture = (deviationSw: number, laneZone: number) => deviationSw < this.centerBandSw || laneZone === 0;
    const admitted = deviations.filter(({ sample, deviationSw }) => isPosture(deviationSw, sample.laneZone)).length;
    // Escape hatch: if almost nothing counts as neutral evidence for a long stretch, the player
    // is not holding a lane — nobody holds one for half a minute — they physically moved, and
    // the gate reference is what is wrong. Admission reopens and the change-point blend hurries.
    const admissionRatio = deviations.length > 0 ? admitted / deviations.length : 1;
    if (priorCenterX === undefined || admissionRatio >= 0.1) this.centerStarvedSince = undefined;
    else this.centerStarvedSince ??= now;
    const relocating = this.centerStarvedSince !== undefined && now - this.centerStarvedSince >= CENTER_RELOCATION_MS;
    const centerSamples = deviations.map(({ sample, deviationSw }) => ({
      value: sample.shoulderCenterX,
      confidence: sample.confidence * (relocating || isPosture(deviationSw, sample.laneZone) ? 1 : 0),
    }));
    // No posture evidence means no center estimate: with every near-center sample gated out,
    // a zero-weight mode would still report the held lane position as neutral and the blend
    // would chase it. But only the center freezes — scale and wrist references have their own
    // evidence and keep publishing, or a tennis player standing off-center would never learn
    // a wrist reference. The neutral readiness freezes with the center it describes.
    const centerEvidence = centerSamples.reduce((sum, sample) => sum + sample.confidence, 0);
    const freezeCenter = centerEvidence < MIN_CENTER_EVIDENCE;
    if (freezeCenter && !this.published) return undefined;
    const neutralMode = freezeCenter ? undefined : scalarMode(centerSamples, CENTER_BIN, CENTER_CLUSTER_RADIUS);
    if (!freezeCenter && !neutralMode) return undefined;
    const shoulderCenterX0 = freezeCenter ? this.published!.image.shoulderCenterX0 : neutralMode!.value;

    const readyWristLocal: Partial<Record<Hand, Point3>> = {};
    for (const hand of ['left', 'right'] as const) {
      const reference = this.estimateWrist(hand);
      if (reference) readyWristLocal[hand] = reference;
    }

    const coverage = this.coreCoverage();
    const widthMad = median(this.coreObservations.map((sample) => Math.abs(sample.shoulderWidth - shoulderWidth)));
    const scaleDispersion01 = clamp(1 - widthMad / (shoulderWidth * 0.12));
    const localDispersion01 = neutralMode ? clamp(1 - neutralMode.dispersion / 0.02) : 0;
    const freshNeutral01 = neutralMode
      ? clamp(coverage.coveredMs / 2500) * clamp(coverage.ratio / CORE_COVERAGE_RATIO)
        * (0.15 + 0.7 * neutralMode.strength01 + 0.15 * localDispersion01)
      : (this.published?.readiness?.neutral01 ?? 0);
    const readiness = {
      scale01: clamp(coverage.spanMs / MIN_PUBLISH_SPAN_MS) * clamp(coverage.ratio / CORE_COVERAGE_RATIO) * scaleDispersion01,
      neutral01: freshNeutral01,
    };
    return {
      version: 3,
      world: {
        shoulderWidth,
        readyWristLocal: Object.keys(readyWristLocal).length ? readyWristLocal : undefined,
      },
      image: { shoulderCenterX0, shoulderWidth0: median(this.coreObservations.map((sample) => sample.imageShoulderWidth)) },
      readiness,
    };
  }

  private estimateWrist(hand: Hand): Point3 | undefined {
    const samples = this.wrists[hand].observations;
    if (samples.length < 12) return undefined;
    let best: { weight: number; point: Point3 } | undefined;
    for (const candidate of samples) {
      let weight = 0;
      for (const other of samples) {
        if (distance3(candidate.point, other.point) <= WRIST_CLUSTER_RADIUS_BODY_WIDTHS) weight += other.confidence;
      }
      if (!best || weight > best.weight) best = { weight, point: candidate.point };
    }
    if (!best) return undefined;
    const cluster = samples.filter((sample) => distance3(sample.point, best.point) <= WRIST_CLUSTER_RADIUS_BODY_WIDTHS);
    if (cluster.length < 10) return undefined;

    let episodes = 1;
    for (let index = 1; index < cluster.length; index += 1) {
      if (cluster[index]!.timestampMs - cluster[index - 1]!.timestampMs > WRIST_EPISODE_GAP_MS) episodes += 1;
    }
    const spanMs = cluster.at(-1)!.timestampMs - cluster[0]!.timestampMs;
    if (episodes < 2 && spanMs < WRIST_SINGLE_EPISODE_MIN_SPAN_MS) return undefined;

    const center = {
      x: median(cluster.map((sample) => sample.point.x)),
      y: median(cluster.map((sample) => sample.point.y)),
      z: median(cluster.map((sample) => sample.point.z)),
    };
    const dispersion = median(cluster.map((sample) => distance3(sample.point, center)));
    return dispersion <= WRIST_MAX_DISPERSION_BODY_WIDTHS ? center : undefined;
  }

  private blendProfile(current: CalibrationProfile, target: CalibrationProfile, now: number): CalibrationProfile {
    const scaleDelta = Math.abs(target.world.shoulderWidth - current.world.shoulderWidth) / current.world.shoulderWidth;
    const centerDelta = Math.abs(target.image.shoulderCenterX0 - current.image.shoulderCenterX0);
    if (scaleDelta > 0.15) this.scaleDisagreementSince ??= now;
    else this.scaleDisagreementSince = undefined;
    if (centerDelta > 0.015) this.poseDisagreementSince ??= now;
    else this.poseDisagreementSince = undefined;
    const scaleSustained = this.scaleDisagreementSince !== undefined && now - this.scaleDisagreementSince >= CHANGE_POINT_EVIDENCE_MS;
    const poseSustained = this.poseDisagreementSince !== undefined && now - this.poseDisagreementSince >= CHANGE_POINT_EVIDENCE_MS;
    const scaleAlpha = scaleSustained ? CHANGE_POINT_SCALE_ALPHA : SCALE_ALPHA;
    const poseAlpha = poseSustained ? CHANGE_POINT_POSE_ALPHA : POSE_ALPHA;
    const shoulderWidth = blend(current.world.shoulderWidth, target.world.shoulderWidth, scaleAlpha);
    const shoulderCenterX0 = blend(current.image.shoulderCenterX0, target.image.shoulderCenterX0, poseAlpha);

    const readyWristLocal: Partial<Record<Hand, Point3>> = { ...current.world.readyWristLocal };
    for (const hand of ['left', 'right'] as const) {
      const next = target.world.readyWristLocal?.[hand];
      if (!next) continue;
      const previous = readyWristLocal[hand];
      readyWristLocal[hand] = previous
        ? {
            x: blend(previous.x, next.x, WRIST_ALPHA),
            y: blend(previous.y, next.y, WRIST_ALPHA),
            z: blend(previous.z, next.z, WRIST_ALPHA),
          }
        : next;
    }

    return {
      version: 3,
      world: {
        shoulderWidth,
        readyWristLocal: Object.keys(readyWristLocal).length ? readyWristLocal : undefined,
      },
      // The depth reference does not follow the player: see CalibrationProfile.
      image: { shoulderCenterX0, shoulderWidth0: current.image.shoulderWidth0 ?? target.image.shoulderWidth0 },
      readiness: target.readiness,
    };
  }

  reset(): void {
    this.coreObservations = [];
    this.coreFrameValidity = [];
    this.wrists.left = makeWristState();
    this.wrists.right = makeWristState();
    this.published = undefined;
    this.lastPublishAt = Number.NEGATIVE_INFINITY;
    this.scaleDisagreementSince = undefined;
    this.poseDisagreementSince = undefined;
    this.centerStarvedSince = undefined;
  }
}
