import type { CalibrationProfile, Hand, Point3, PoseSnapshot } from './protocol';
import { OneEuroFilter } from '@wii/spatial-core';
import { bodyLocalPoint, legsVertical } from '../kinematics/bodyFrame';
import { clamp, distance3, isFinitePoint, landmarkConfidence, median, midpoint } from '../kinematics/math';

const CORE = [11, 12, 23, 24] as const;
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
const VECTOR_CONSENSUS_DOT = Math.cos((15 * Math.PI) / 180);
const LEAN_BIN_RAD = 0.05;
const LEAN_CLUSTER_RADIUS_RAD = 0.1;
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
  torso: Point3;
  across: Point3;
  trunkUp: Point3;
  legUp?: Point3;
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

function subtract(a: Point3, b: Point3): Point3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(vector: Point3): Point3 | undefined {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(magnitude) || magnitude < 1e-6) return undefined;
  return { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude };
}

function blend(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function blendVector(a: Point3, b: Point3, alpha: number): Point3 | undefined {
  return normalize({
    x: blend(a.x, b.x, alpha),
    y: blend(a.y, b.y, alpha),
    z: blend(a.z, b.z, alpha),
  });
}

function blendAngle(a: number, b: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * alpha;
}

function angleDistance(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
}

function confident(point: Point3 | undefined): point is Point3 {
  return isFinitePoint(point) && landmarkConfidence(point) >= MIN_CONFIDENCE;
}

/** Dominant-vector consensus: a temporal RANSAC-like mode, robust to leans and transient noise. */
function vectorConsensus(samples: readonly { vector: Point3; confidence: number }[]): Point3 | undefined {
  let best: { weight: number; vector: Point3 } | undefined;
  for (const candidate of samples) {
    let weight = 0;
    for (const other of samples) {
      if (dot(candidate.vector, other.vector) >= VECTOR_CONSENSUS_DOT) weight += other.confidence;
    }
    if (!best || weight > best.weight) best = { weight, vector: candidate.vector };
  }
  if (!best) return undefined;
  const cluster = samples.filter((sample) => dot(sample.vector, best.vector) >= VECTOR_CONSENSUS_DOT);
  return normalize({
    x: cluster.reduce((sum, sample) => sum + sample.vector.x * sample.confidence, 0),
    y: cluster.reduce((sum, sample) => sum + sample.vector.y * sample.confidence, 0),
    z: cluster.reduce((sum, sample) => sum + sample.vector.z * sample.confidence, 0),
  });
}

/** Histogram mode followed by a local median; better than a mean when gameplay alternates postures. */
function scalarMode(samples: readonly { value: number; confidence: number }[]): { value: number; strength01: number; dispersion: number } | undefined {
  if (!samples.length) return undefined;
  const bins = new Map<number, number>();
  const totalWeight = samples.reduce((sum, sample) => sum + sample.confidence, 0);
  for (const sample of samples) {
    const bin = Math.round(sample.value / LEAN_BIN_RAD);
    bins.set(bin, (bins.get(bin) ?? 0) + sample.confidence);
  }
  const [bestBin] = [...bins.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const center = bestBin * LEAN_BIN_RAD;
  const cluster = samples.filter((sample) => Math.abs(sample.value - center) <= LEAN_CLUSTER_RADIUS_RAD);
  const value = median(cluster.map((sample) => sample.value));
  const clusterWeight = cluster.reduce((sum, sample) => sum + sample.confidence, 0);
  return {
    value,
    strength01: totalWeight > 0 ? clamp(clusterWeight / totalWeight) : 0,
    dispersion: median(cluster.map((sample) => Math.abs(sample.value - value))),
  };
}

function leanAngle(observation: CoreObservation, up: Point3): number | undefined {
  const upDirection = normalize(up);
  if (!upDirection) return undefined;
  const acrossUp = dot(observation.across, upDirection);
  const side = normalize({
    x: observation.across.x - upDirection.x * acrossUp,
    y: observation.across.y - upDirection.y * acrossUp,
    z: observation.across.z - upDirection.z * acrossUp,
  });
  if (!side) return undefined;
  return Math.atan2(dot(observation.torso, side), dot(observation.torso, upDirection));
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
  private verticalUsesLegs = false;
  private scaleDisagreementSince?: number;
  private poseDisagreementSince?: number;

  update(snapshot: PoseSnapshot): CalibrationProfile | undefined {
    const now = snapshot.timestampMs;
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
    const imageCore = CORE.map((index) => image[index]);
    const worldCore = CORE.map((index) => world[index]);
    if (!imageCore.every(confident) || !worldCore.every(confident)) return undefined;

    const leftShoulder = image[11]!;
    const rightShoulder = image[12]!;
    const leftHip = image[23]!;
    const rightHip = image[24]!;
    const worldLeftShoulder = world[11]!;
    const worldRightShoulder = world[12]!;
    const worldLeftHip = world[23]!;
    const worldRightHip = world[24]!;
    const shoulderCenter = midpoint(leftShoulder, rightShoulder);
    const hipCenter = midpoint(leftHip, rightHip);
    const torsoHeight = Math.abs(hipCenter.y - shoulderCenter.y);
    const imageShoulderWidth = Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y);
    const shoulderWidth = distance3(worldLeftShoulder, worldRightShoulder);
    if (torsoHeight < 0.03 || imageShoulderWidth < 0.03 || shoulderWidth < 0.03) return undefined;

    const worldShoulderCenter = midpoint(worldLeftShoulder, worldRightShoulder);
    const worldHipCenter = midpoint(worldLeftHip, worldRightHip);
    const torso = subtract(worldShoulderCenter, worldHipCenter);
    const trunkUp = normalize(torso);
    if (!trunkUp) return undefined;
    return {
      timestampMs: snapshot.timestampMs,
      confidence: landmarkConfidence(
        worldLeftShoulder, worldRightShoulder, worldLeftHip, worldRightHip,
        leftShoulder, rightShoulder, leftHip, rightHip,
      ),
      shoulderWidth,
      torso,
      across: subtract(worldRightShoulder, worldLeftShoulder),
      trunkUp,
      legUp: legsVertical(snapshot),
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

    const legSamples = this.coreObservations.flatMap((sample) => sample.legUp ? [{ vector: sample.legUp, confidence: sample.confidence }] : []);
    const legRatio = legSamples.length / this.coreObservations.length;
    if (!this.verticalUsesLegs && legSamples.length >= 8 && legRatio >= 0.2) this.verticalUsesLegs = true;
    if (this.verticalUsesLegs && (legSamples.length < 4 || legRatio < 0.1)) this.verticalUsesLegs = false;
    const verticalSamples = this.verticalUsesLegs
      ? legSamples
      : this.coreObservations.map((sample) => ({ vector: sample.trunkUp, confidence: sample.confidence }));
    const leanUp0 = vectorConsensus(verticalSamples);
    if (!leanUp0) return undefined;

    const priorLean = this.published?.world.torsoLeanRad0;
    const angles = this.coreObservations.flatMap((sample) => {
      const value = leanAngle(sample, leanUp0);
      if (value === undefined) return [];
      // Control input is evidence too, but a held lane lean must not be able to recentre the
      // neutral reference immediately. Deviations from the current posterior are downweighted;
      // sustained recurrent deviations still win as the rolling evidence accumulates.
      const priorDelta = priorLean === undefined ? 0 : angleDistance(value, priorLean);
      const uprightPrior = 1 / (1 + (value / 0.3) ** 2);
      const posteriorPrior = 1 / (1 + (priorDelta / 0.25) ** 2);
      const confidence = sample.confidence * uprightPrior * posteriorPrior;
      return [{ value, confidence }];
    });
    const neutralMode = scalarMode(angles);
    if (!neutralMode) return undefined;
    const torsoLeanRad0 = neutralMode.value;

    const readyWristLocal: Partial<Record<Hand, Point3>> = {};
    for (const hand of ['left', 'right'] as const) {
      const reference = this.estimateWrist(hand);
      if (reference) readyWristLocal[hand] = reference;
    }

    const coverage = this.coreCoverage();
    const widthMad = median(this.coreObservations.map((sample) => Math.abs(sample.shoulderWidth - shoulderWidth)));
    const scaleDispersion01 = clamp(1 - widthMad / (shoulderWidth * 0.12));
    const localDispersion01 = clamp(1 - neutralMode.dispersion / 0.12);
    const readiness = {
      scale01: clamp(coverage.spanMs / MIN_PUBLISH_SPAN_MS) * clamp(coverage.ratio / CORE_COVERAGE_RATIO) * scaleDispersion01,
      neutral01: clamp(coverage.coveredMs / 2500) * clamp(coverage.ratio / CORE_COVERAGE_RATIO)
        * (0.15 + 0.7 * neutralMode.strength01 + 0.15 * localDispersion01),
    };
    return {
      version: 3,
      completedAtMs: now,
      world: {
        shoulderWidth,
        leanUp0,
        torsoLeanRad0,
        readyWristLocal: Object.keys(readyWristLocal).length ? readyWristLocal : undefined,
      },
      quality: {
        validFrameRatio: clamp(coverage.ratio),
        medianConfidence: median(this.coreObservations.map((sample) => sample.confidence)),
      },
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
    const leanDelta = angleDistance(current.world.torsoLeanRad0, target.world.torsoLeanRad0);
    const upDelta = Math.acos(Math.max(-1, Math.min(1, dot(current.world.leanUp0, target.world.leanUp0))));
    if (scaleDelta > 0.15) this.scaleDisagreementSince ??= now;
    else this.scaleDisagreementSince = undefined;
    if (leanDelta > 0.2 || upDelta > 0.2) this.poseDisagreementSince ??= now;
    else this.poseDisagreementSince = undefined;
    const scaleSustained = this.scaleDisagreementSince !== undefined && now - this.scaleDisagreementSince >= CHANGE_POINT_EVIDENCE_MS;
    const poseSustained = this.poseDisagreementSince !== undefined && now - this.poseDisagreementSince >= CHANGE_POINT_EVIDENCE_MS;
    const scaleAlpha = scaleSustained ? CHANGE_POINT_SCALE_ALPHA : SCALE_ALPHA;
    const poseAlpha = poseSustained ? CHANGE_POINT_POSE_ALPHA : POSE_ALPHA;
    const shoulderWidth = blend(current.world.shoulderWidth, target.world.shoulderWidth, scaleAlpha);
    const leanUp0 = blendVector(current.world.leanUp0, target.world.leanUp0, poseAlpha) ?? target.world.leanUp0;
    const torsoLeanRad0 = blendAngle(current.world.torsoLeanRad0, target.world.torsoLeanRad0, poseAlpha);

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
      completedAtMs: now,
      world: {
        shoulderWidth,
        leanUp0,
        torsoLeanRad0,
        readyWristLocal: Object.keys(readyWristLocal).length ? readyWristLocal : undefined,
      },
      quality: target.quality,
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
    this.verticalUsesLegs = false;
    this.scaleDisagreementSince = undefined;
    this.poseDisagreementSince = undefined;
  }
}
