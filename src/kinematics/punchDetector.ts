import type { CalibrationProfile, Hand, Point3, PoseSnapshot, PunchMeasurement, PunchTrajectorySample } from '@wii/spatial-core';
import { OneEuroFilter } from '@wii/spatial-core';
import { BODY_JOINTS } from './bodyFeatures';
import { bodyLocalPoint, bodyBasis, type BodyBasis } from './bodyFrame';
import { clamp, isFinitePoint, landmarkConfidence } from './math';

export interface PunchSignal {
  power01: number;
  confidence: number;
  peakTimestampMs: number;
  /** Frame where the onset conditions were met. */
  onsetTimestampMs: number;
  measurement: PunchMeasurement;
}

export interface PunchDiagnostics {
  readonly onsets: number;
  readonly confirmed: number;
  readonly timedOut: number;
  readonly missingExtension: number;
  readonly missingTravel: number;
  readonly sampleGaps: number;
  readonly invalidSamples: number;
}

/**
 * Same contract as SwingOutput: `onset` is the unconfirmed real-time notice, for animation only;
 * `confirmed` is the measured punch, emitted once extension and forward travel are both proven.
 */
export type PunchOutput =
  | { kind: 'onset'; timestampMs: number }
  | ({ kind: 'confirmed' } & PunchSignal);

/**
 * Punch thresholds. Speeds and travel are in shoulder widths (per second); elbow values are the
 * articulation cosine, +1 meaning a straight arm. The confirmation chain is validated against
 * the UTD-MHAD front-boxing floor (tests/utdMhadBoxing.test.ts): measurements must reach back to
 * where the motion started and past the first retracting frame, because compact punches end
 * physically at their own extension peak and the filtered signals lag it.
 */
export const PUNCH_THRESHOLDS = {
  /** Forward wrist speed and elbow opening rate that must coincide to start a punch. */
  onsetForwardSpeed: 1.5,
  onsetElbowCosineRatePerSec: 0.5,
  /** Peak forward speed that reads as power 1. */
  fullPowerForwardSpeed: 6,
  /** Extension and travel a punch must reach. Travel sits below a 0.35-width short jab: at 15 fps
   * the first moving sample is slower than the onset speed and falls outside the measure.
   * The cosine bar is what an extended arm MEASURES at production conditions, not what it
   * geometrically is: punching toward the camera is the worst case of monocular reconstruction
   * (the arm foreshortens along the optical axis and depth noise collapses the angle), so real
   * full extensions peak at 0.2-0.4 in the raw signal of the 11 fps reference recording. The
   * threshold sweep against the floors — user recording, UTD positives, UTD negatives — showed
   * identical false-positive counts at 0.65, 0.2 and none at all, with recall doubling at 0.2:
   * the speed onset, the travel bar and the retraction close are what guard precision. */
  confirmElbowCosine: 0.2,
  confirmForwardTravel: 0.25,
  maxDurationMs: 350,
  /** The punch ends once speed falls to this share of its peak, or the wrist comes back this fast. */
  deceleratedPeakRatio: 0.65,
  retractingForwardSpeed: -0.5,
  /** Re-arm by retraction: elbow bent past this for the dwell. */
  retractedElbowCosine: 0.4,
  retractedDwellMs: 80,
  /** Re-arm by rest, for players who barely retract: forward speed below this for the dwell. */
  restForwardSpeed: 0.8,
  restDwellMs: 250,
  refractoryMs: 250,
  /** A longer gap between samples restarts the detector. */
  maxSampleGapMs: 200,
  /** The onset fires once the wrist is already fast, so the first part of the course happened
   * before it. The measurement walks back this far looking for where the forward motion started. */
  originWalkBackMs: 300,
  /** Noise tolerance while walking the monotonic filtered forward series backwards. */
  originWalkBackEpsilon: 0.02,
  /** The walk-back never crosses a sample this extended: punches start chambered, elbow bent. */
  walkBackMaxElbowCosine: 0.5,
  /** Maximal extension physically coincides with the start of the retraction, and the filtered
   * signals lag it by a frame or two: an unconfirmed punch is granted this long past the first
   * retracting sample before its window is evaluated. Confirmed punches still close at once. */
  retractionGraceMs: 120,
} as const;
// Much lighter than SwingDetector's smoothing: a jab spans only 2-5 samples, and a 1 Hz cutoff
// would lag it below both confirmation thresholds.
const FILTER_OPTIONS = { minCutoff: 4, beta: 1, derivativeCutoff: 1 };

interface PendingPunch {
  startedAt: number;
  /** Body basis frozen at onset: shape features are measured in it, immune to torso rotation. */
  frozenBasis?: BodyBasis;
  /** The onset sample's index inside `samples` — the walked-back origin samples come before it. */
  onsetIndex: number;
  /** First sample retracting fast; set once, never cleared — a second extension is another punch. */
  retractingSinceMs?: number;
  /** Forward position on the sample before onset: where the motion started. */
  originForward: number;
  peak: { speed: number; confidence: number; timestampMs: number; sample: PunchTrajectorySample };
  /** Extension and travel were both met on one sample inside the window. */
  reached: boolean;
  sawExtension: boolean;
  sawTravel: boolean;
  samples: PunchTrajectorySample[];
}

function distance(a: PunchTrajectorySample, b: PunchTrajectorySample): number {
  return Math.hypot(b.lateral - a.lateral, b.vertical - a.vertical, b.forward - a.forward);
}

/** Wrist position projected onto the frozen onset basis, in shoulder widths; forward toward camera. */
function projectFrozen(wrist: Point3, basis: BodyBasis, scale: number): { lateral: number; vertical: number; forward: number } {
  const dot = (axis: Point3) => wrist.x * axis.x + wrist.y * axis.y + wrist.z * axis.z;
  return {
    lateral: dot(basis.side) / scale,
    vertical: dot(basis.up) / scale,
    forward: -dot(basis.depth) / scale,
  };
}

function measurePunch(pending: PendingPunch): PunchMeasurement {
  const samples = [...pending.samples];
  const origin = samples[0]!;
  const end = samples.at(-1)!;
  const contact = samples.reduce((best, sample) => (sample.forward > best.forward ? sample : best), origin);
  let pathLength = 0;
  for (let index = 1; index < samples.length; index += 1) pathLength += distance(samples[index - 1]!, samples[index]!);
  return {
    samples,
    onsetIndex: pending.onsetIndex,
    origin,
    speedPeak: pending.peak.sample,
    contact,
    end,
    durationMs: end.timestampMs - origin.timestampMs,
    forwardTravel: contact.forward - origin.forward,
    lateralExcursion: Math.max(...samples.map((sample) => sample.lateral)) - Math.min(...samples.map((sample) => sample.lateral)),
    verticalRise: Math.max(...samples.map((sample) => sample.vertical)) - origin.vertical,
    pathLength,
    netDisplacement: distance(origin, contact),
    // Same evidence the confirmation chain trusts: the raw cosine counts, because the filtered one lags brief extensions below their peak.
    maxElbowCosine: Math.max(...samples.map((sample) => Math.max(sample.elbowCosine, sample.rawElbowCosine ?? sample.elbowCosine))),
  };
}

function elbowCosine(shoulder: Point3, elbow: Point3, wrist: Point3): number | undefined {
  const upper = { x: elbow.x - shoulder.x, y: elbow.y - shoulder.y, z: elbow.z - shoulder.z };
  const fore = { x: wrist.x - elbow.x, y: wrist.y - elbow.y, z: wrist.z - elbow.z };
  const lengths = Math.hypot(upper.x, upper.y, upper.z) * Math.hypot(fore.x, fore.y, fore.z);
  if (lengths <= 1e-8) return undefined;
  return clamp((upper.x * fore.x + upper.y * fore.y + upper.z * fore.z) / lengths, -1, 1);
}

/**
 * Guard stance limits, relative to each wrist's own shoulder in shoulder widths. Tunable guesses,
 * checked only against synthetic poses.
 */
export const GUARD_THRESHOLDS = {
  /** Wrist height window: from just below the shoulder up to around the forehead. */
  minWristHeight: -0.35,
  maxWristHeight: 0.9,
  /** Sideways distance from the shoulder; wider than this the fist is not covering anything. */
  maxWristSide: 0.8,
  /** The arm must be folded: an extended arm at shoulder height is a punch, not a guard. */
  maxElbowCosine: 0.3,
  minConfidence: 0.5,
} as const;

/** True when both fists are up near shoulder or chin height with the arms folded. */
export function isGuardingPose(snapshot: PoseSnapshot, calibration: CalibrationProfile): boolean {
  const world = snapshot.worldLandmarks;
  const [leftShoulder, rightShoulder, leftHip, rightHip] = [world[11], world[12], world[23], world[24]];
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return false;
  return BODY_JOINTS.slice(0, 2).every(([, shoulderIndex, elbowIndex, wristIndex]) => {
    const shoulder = world[shoulderIndex];
    const elbow = world[elbowIndex];
    const wrist = world[wristIndex];
    if (!shoulder || !elbow || !wrist) return false;
    if (landmarkConfidence(shoulder, elbow, wrist) < GUARD_THRESHOLDS.minConfidence) return false;
    const local = bodyLocalPoint(wrist, shoulder, leftShoulder, rightShoulder, leftHip, rightHip, calibration.world.shoulderWidth);
    const cosine = elbowCosine(shoulder, elbow, wrist);
    return local !== undefined && cosine !== undefined
      && local.y >= GUARD_THRESHOLDS.minWristHeight && local.y <= GUARD_THRESHOLDS.maxWristHeight
      && Math.abs(local.x) <= GUARD_THRESHOLDS.maxWristSide
      && cosine <= GUARD_THRESHOLDS.maxElbowCosine;
  });
}

export class PunchDetector {
  /** How far the wrist must travel forward to confirm; override after measuring the player. */
  minTravel: number = PUNCH_THRESHOLDS.confirmForwardTravel;
  constructor(private readonly hand: Hand) {}

  private readonly forwardFilter = new OneEuroFilter(FILTER_OPTIONS);
  private readonly elbowFilter = new OneEuroFilter(FILTER_OPTIONS);
  private previous?: { forward: number; cosine: number; time: number; sample?: PunchTrajectorySample };
  /** Recent filtered samples, oldest first, for walking the punch's origin back before its onset. */
  private recent: { forward: number; time: number; sample: PunchTrajectorySample; worldWrist: Point3 }[] = [];
  private mode: 'ready' | 'punch' | 'return' = 'ready';
  private pending?: PendingPunch;
  private lastPunchAt = Number.NEGATIVE_INFINITY;
  private onsets = 0;
  private confirmed = 0;
  private timedOut = 0;
  private missingExtension = 0;
  private missingTravel = 0;
  private sampleGaps = 0;
  private invalidSamples = 0;
  private retractedSince?: number;
  private restSince?: number;

  /**
   * `suppressOnset` vetoes only the ready→punch transition: the torso reference frame is in
   * fast motion (a duck, a fast rise), so wrist-relative measurements are torso-dominated.
   * The series keeps flowing so in-flight windows still close on their own evidence.
   */
  update(snapshot: PoseSnapshot, calibration: CalibrationProfile, suppressOnset = false): PunchOutput | undefined {
    const world = snapshot.worldLandmarks;
    const [, shoulderIndex, elbowIndex, wristIndex] = BODY_JOINTS[this.hand === 'right' ? 1 : 0];
    const shoulder = world[shoulderIndex];
    const elbow = world[elbowIndex];
    const wrist = world[wristIndex];
    const leftShoulder = world[11];
    const rightShoulder = world[12];
    const leftHip = world[23];
    const rightHip = world[24];
    if (!isFinitePoint(shoulder) || !isFinitePoint(elbow) || !isFinitePoint(wrist) || !isFinitePoint(leftShoulder)
      || !isFinitePoint(rightShoulder) || !isFinitePoint(leftHip) || !isFinitePoint(rightHip)) { this.invalidSamples += 1; this.reset(); return undefined; }
    const localWrist = bodyLocalPoint(wrist, shoulder, leftShoulder, rightShoulder, leftHip, rightHip, calibration.world.shoulderWidth);
    const rawCosine = elbowCosine(shoulder, elbow, wrist);
    if (!localWrist || rawCosine === undefined) { this.invalidSamples += 1; this.reset(); return undefined; }

    const time = snapshot.timestampMs;
    // Velocity across a long gap is meaningless: restart the chain and demand a fresh re-arm.
    if (this.previous && time - this.previous.time > PUNCH_THRESHOLDS.maxSampleGapMs) {
      this.sampleGaps += 1;
      this.reset();
    }
    const confidence = landmarkConfidence(leftShoulder, rightShoulder, leftHip, rightHip, elbow, wrist);
    const current = {
      // Body depth points away from the camera when facing it, so forward is decreasing local z.
      forward: this.forwardFilter.filter(-localWrist.z, time),
      cosine: this.elbowFilter.filter(rawCosine, time),
      time,
      sample: undefined as PunchTrajectorySample | undefined,
    };
    current.sample = {
      timestampMs: time,
      lateral: localWrist.x,
      vertical: localWrist.y,
      forward: current.forward,
      elbowCosine: current.cosine,
      rawElbowCosine: rawCosine,
      confidence,
    };
    const sample = current.sample;
    const previous = this.previous;
    this.previous = current;
    this.recent.push({ forward: current.forward, time, sample, worldWrist: wrist });
    while (this.recent[0] && time - this.recent[0].time > PUNCH_THRESHOLDS.originWalkBackMs) this.recent.shift();
    if (!previous?.sample) return undefined;

    const dt = Math.max((time - previous.time) / 1000, 1 / 120);
    const speed = (current.forward - previous.forward) / dt;

    if (this.mode === 'ready') {
      const extending = (current.cosine - previous.cosine) / dt >= PUNCH_THRESHOLDS.onsetElbowCosineRatePerSec;
      if (suppressOnset || !extending || speed < PUNCH_THRESHOLDS.onsetForwardSpeed || time - this.lastPunchAt < PUNCH_THRESHOLDS.refractoryMs) return undefined;
      this.onsets += 1;
      // The wrist was already fast when the onset fired: walk the filtered series backwards while
      // it keeps decreasing and measure the course from where the forward motion really started.
      const originSamples = [previous.sample, sample];
      let originForward = previous.forward;
      for (let index = this.recent.length - 2; index > 0; index -= 1) {
        const entry = this.recent[index]!;
        const earlier = this.recent[index - 1]!;
        if (entry.forward < originForward + PUNCH_THRESHOLDS.originWalkBackEpsilon && earlier.forward <= entry.forward + PUNCH_THRESHOLDS.originWalkBackEpsilon) {
          originForward = earlier.forward;
          originSamples.unshift(earlier.sample);
        } else break;
      }
      const scale = calibration.world.shoulderWidth;
      const frozenBasis = bodyBasis(leftShoulder, rightShoulder, leftHip, rightHip);
      if (frozenBasis) {
        for (const entry of this.recent) {
          if (originSamples.includes(entry.sample)) entry.sample.frozen = projectFrozen(entry.worldWrist, frozenBasis, scale);
        }
        sample.frozen = projectFrozen(wrist, frozenBasis, scale);
      }
      this.pending = {
        startedAt: time,
        frozenBasis,
        onsetIndex: originSamples.length - 1,
        originForward,
        peak: { speed, confidence, timestampMs: time, sample },
        reached: false,
        sawExtension: current.cosine >= PUNCH_THRESHOLDS.confirmElbowCosine,
        sawTravel: current.forward - originForward >= this.minTravel,
        samples: originSamples,
      };
      this.mode = 'punch';
      this.lastPunchAt = time;
      return { kind: 'onset', timestampMs: time };
    }

    if (this.mode === 'punch' && this.pending) {
      const pending = this.pending;
      if (pending.frozenBasis) sample.frozen = projectFrozen(wrist, pending.frozenBasis, calibration.world.shoulderWidth);
      pending.samples.push(sample);
      const ageMs = time - pending.startedAt;
      if (speed > pending.peak.speed) pending.peak = { speed, confidence, timestampMs: time, sample };
      const extended = current.cosine >= PUNCH_THRESHOLDS.confirmElbowCosine;
      const travelled = current.forward - pending.originForward >= this.minTravel;
      pending.sawExtension ||= extended;
      pending.sawTravel ||= travelled;
      if (ageMs <= PUNCH_THRESHOLDS.maxDurationMs && extended && travelled) pending.reached = true;
      const retracting = speed <= PUNCH_THRESHOLDS.retractingForwardSpeed;
      if (retracting) pending.retractingSinceMs ??= time;
      const decelerated = pending.reached && speed <= pending.peak.speed * PUNCH_THRESHOLDS.deceleratedPeakRatio;
      // A confirmed punch ends as soon as it physically does; an unconfirmed one is granted the
      // retraction grace, because its extension peak only shows in the lagged filters then.
      const graceOver = pending.retractingSinceMs !== undefined && time - pending.retractingSinceMs >= PUNCH_THRESHOLDS.retractionGraceMs;
      const closedOnRetraction = pending.reached ? retracting : graceOver;
      if (!closedOnRetraction && !decelerated && ageMs < PUNCH_THRESHOLDS.maxDurationMs) return undefined;

      if (!pending.reached) {
        // Borderline evaluation at close: extension and travel both peak at contact, so the
        // maxima over the window measure the same instant without fragile same-sample timing.
        const peakCosine = Math.max(...pending.samples.map((pendingSample) => Math.max(pendingSample.elbowCosine, pendingSample.rawElbowCosine ?? 0)));
        const peakTravel = Math.max(...pending.samples.map((pendingSample) => pendingSample.forward)) - pending.originForward;
        if (peakCosine >= PUNCH_THRESHOLDS.confirmElbowCosine && peakTravel >= this.minTravel) {
          pending.reached = true;
          pending.sawExtension = true;
          pending.sawTravel = true;
        }
      }
      if (ageMs >= PUNCH_THRESHOLDS.maxDurationMs && !pending.reached) this.timedOut += 1;
      if (!pending.sawExtension) this.missingExtension += 1;
      if (!pending.sawTravel) this.missingTravel += 1;
      const measurement = measurePunch(pending);
      this.pending = undefined;
      this.retractedSince = undefined;
      this.restSince = undefined;
      this.mode = 'return';
      if (!pending.reached) return undefined;
      this.confirmed += 1;
      return {
        kind: 'confirmed',
        power01: clamp((pending.peak.speed - PUNCH_THRESHOLDS.onsetForwardSpeed) / (PUNCH_THRESHOLDS.fullPowerForwardSpeed - PUNCH_THRESHOLDS.onsetForwardSpeed)),
        confidence: pending.peak.confidence,
        peakTimestampMs: pending.peak.timestampMs,
        onsetTimestampMs: pending.startedAt,
        measurement,
      };
    }

    if (current.cosine < PUNCH_THRESHOLDS.retractedElbowCosine) this.retractedSince ??= time;
    else this.retractedSince = undefined;
    if (Math.abs(speed) < PUNCH_THRESHOLDS.restForwardSpeed) this.restSince ??= time;
    else this.restSince = undefined;
    const retracted = this.retractedSince !== undefined && time - this.retractedSince >= PUNCH_THRESHOLDS.retractedDwellMs;
    const rested = this.restSince !== undefined && time - this.restSince >= PUNCH_THRESHOLDS.restDwellMs;
    if (retracted || rested) {
      this.mode = 'ready';
      this.interruptRearm();
    }
    return undefined;
  }

  get diagnostics(): PunchDiagnostics {
    return {
      onsets: this.onsets,
      confirmed: this.confirmed,
      timedOut: this.timedOut,
      missingExtension: this.missingExtension,
      missingTravel: this.missingTravel,
      sampleGaps: this.sampleGaps,
      invalidSamples: this.invalidSamples,
    };
  }

  resetDiagnostics(): void {
    this.onsets = 0; this.confirmed = 0; this.timedOut = 0; this.missingExtension = 0; this.missingTravel = 0; this.sampleGaps = 0; this.invalidSamples = 0;
  }

  /** Explicitly rejected/degraded samples break re-arm continuity even when no valid sample reaches this detector. */
  interruptRearm(): void { this.retractedSince = undefined; this.restSince = undefined; }

  reset(): void { this.forwardFilter.reset(); this.elbowFilter.reset(); this.previous = undefined; this.recent = []; this.mode = 'return'; this.pending = undefined; this.lastPunchAt = Number.NEGATIVE_INFINITY; this.interruptRearm(); }
}
