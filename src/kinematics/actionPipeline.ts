import type { CalibrationProfile, ContinuousControls, Hand, PoseSnapshot, SportActionEvent, TrackingState } from '@wii/spatial-core';
import { LateralDashTracker, PunchInFlight } from './boxingLocomotion';
import { CadenceTracker } from './cadenceTracker';
import { upsideDown } from './framing';
import { IntensityMeter } from './intensity';
import { JumpDetector } from './jumpDetector';
import { DodgeZoneTracker, DuckTracker, LanePositionTracker, RingDepthTracker } from './postureSignals';
import { isGuardingPose, PunchDetector, type PunchDiagnostics } from './punchDetector';
import { classifyPunch } from './punchClassifier';
import { type ArmMotion, ArmMotionDetector } from './armMotion';
import { SWING_MAX_DURATION_MS, SwingDetector, type SwingSignal } from './swingDetector';
import { TorsoVerticalChannel } from './torsoVertical';
import { TrackingGate } from './trackingGate';

/**
 * Coasting through a tracking blackout, after the Meta First Steps hand-tracking algorithm:
 * never drop the input in a step function and never interpolate toward bad data — carry the
 * last measured speed forward with damping instead. The half-life is short because running
 * in place is not ballistic: 150 ms halves the carried speed, so after the 600 ms timeout
 * the runner has glided to a stop rather than frozen mid-stride. Detectors keep their state
 * through the whole window — only a sustained 'lost' (the gate's own 800 ms blackout) resets
 * them, so a blur burst no longer wipes the cadence memory the run depends on.
 */
const UPPER_BODY_ANCHOR = [11, 12] as const;
const COAST_TIMEOUT_MS = 600;
const COAST_HALF_LIFE_MS = 150;
/** Below this the carried speed is indistinguishable from stopped; the coast ends in a clean zero. */
const COAST_MIN_SPEED01 = 0.02;

export interface SwingTracking {
  scaleReady: boolean;
  wrists: readonly { hand: Hand; tracked: boolean; pending: boolean; arbitrating: boolean }[];
}

export class ActionPipeline {
  /** Shoulder-anchored: hips sit at the bottom edge of a laptop webcam frame or behind the swinging arms. */
  private readonly bodyGate = new TrackingGate(UPPER_BODY_ANCHOR);
  /** One gate and one vertical channel for the torso core: cadence and jump read the same frame's sample. */
  private readonly torsoGate = new TrackingGate(UPPER_BODY_ANCHOR);
  private readonly torsoChannel = new TorsoVerticalChannel();
  private readonly cadence = new CadenceTracker();
  private readonly jump = new JumpDetector();
  private readonly intensity = new IntensityMeter();
  private readonly lanePosition = new LanePositionTracker();
  private readonly dodge = new DodgeZoneTracker();
  /** Boxing's footwork measures the whole torso, which the shared torso gate no longer requires. */
  private readonly footworkGate = new TrackingGate([11, 12, 23, 24]);
  private readonly ringDepth = new RingDepthTracker();
  private readonly lateralDash = new LateralDashTracker();
  private readonly duckTracker = new DuckTracker();
  private readonly punchInFlight = new PunchInFlight();
  /** One detector per wrist: whichever arm swings is the racket hand. */
  private readonly swings = ([['right', 16], ['left', 15]] as const).map(([hand, wrist]) => (
    { hand, wrist, gate: new TrackingGate([], 'world'), detector: new SwingDetector(hand) }
  ));
  /** One detector per arm. No cross-hand arbitration: a one-two is two real punches. */
  private readonly punches = ([['right', 14, 16], ['left', 13, 15]] as const).map(([hand, elbow, wrist]) => (
    { hand, elbow, wrist, gate: new TrackingGate([], 'world'), detector: new PunchDetector(hand) }
  ));
  private lastSwingAt = Number.NEGATIVE_INFINITY;
  private readonly arms = [new ArmMotionDetector('right'), new ArmMotionDetector('left')];
  /** Confirmed swing held back while the other wrist still has one in flight, so the stronger wins. */
  private heldSwing?: { swing: SwingSignal; hand: Hand; heldSince: number };
  private nextId = 1;
  /** True while the last emitted sprint event left the game moving. */
  private sprinting = false;
  /** Last moving sprint measurement and when it was taken — the input coasting decays from. */
  private coast?: { speed01: number; cadenceSpm: number; measuredAt: number };

  /** How long a wrist movement must be to count as a stroke; undefined restores the default. */
  setStrokeTravel(travel: number): void {
    for (const { detector } of this.swings) detector.minTravel = travel;
  }

  /** How far a wrist must travel forward to confirm a punch; the boxing tutorial tunes it to the player. */
  setPunchTravel(travel: number): void {
    for (const { detector } of this.punches) detector.minTravel = travel;
  }

  resetSwings(): void {
    for (const { gate, detector } of this.swings) {
      gate.reset();
      detector.reset();
    }
    this.lastSwingAt = Number.NEGATIVE_INFINITY;
    this.heldSwing = undefined;
  }

  update(snapshot: PoseSnapshot, calibration?: CalibrationProfile, calibrating = false): { snapshot: PoseSnapshot; events: SportActionEvent[]; controls: ContinuousControls; rawEffort: number; effortSampleAtMs: number | null; armMotions: ArmMotion[]; swingTracking: SwingTracking } {
    // An impossible skeleton is a frame without a player, so every gate treats it as a blackout.
    if (upsideDown(snapshot)) snapshot = { ...snapshot, landmarks: [], worldLandmarks: [] };
    const body = this.bodyGate.evaluate(snapshot);
    // While the calibrator is still collecting, a frame the body gate can only call
    // 'degraded' is more honestly 'calibrating' — the state the TrackingState union has
    // always had and nothing emitted. Only the session snapshot is relabeled: gate
    // results, events and controls keep the gates' own states, because games make
    // coasting decisions from them, and every reader of the snapshot state tests
    // 'tracked'/'lost', so a calibrating frame behaves exactly as the degraded frame
    // it replaces. A tracked frame is never relabeled, and neither is a lost one.
    const current = { ...snapshot, trackingState: calibrating && body.state === 'degraded' ? 'calibrating' as const : body.state, bodyConfidence: body.confidence };
    const events: SportActionEvent[] = [];
    let controls: ContinuousControls = { sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'lost' };

    let rawEffort: number;
    const torsoTracking = this.torsoGate.evaluate(snapshot);
    controls = { ...controls, trackingState: torsoTracking.state };
    const shouldersConfident = Boolean(
      snapshot.landmarks[11]
      && snapshot.landmarks[12]
      && (snapshot.landmarks[11]!.visibility ?? 0) >= 0.7
      && (snapshot.landmarks[12]!.visibility ?? 0) >= 0.7
      && (snapshot.landmarks[11]!.presence ?? 0) >= 0.7
      && (snapshot.landmarks[12]!.presence ?? 0) >= 0.7,
    );
    const oneHipVisible = Boolean(
      snapshot.landmarks[23]
      && snapshot.landmarks[24]
      && Math.max(snapshot.landmarks[23]!.visibility ?? 0, snapshot.landmarks[24]!.visibility ?? 0) >= 0.5
      && Math.min(snapshot.landmarks[23]!.visibility ?? 0, snapshot.landmarks[24]!.visibility ?? 0) < 0.5,
    );
    if (torsoTracking.state === 'tracked' || (shouldersConfident && oneHipVisible)) {
      const sample = this.torsoChannel.update(current);
      const jumped = sample ? this.jump.update(sample) : false;
      const body = sample?.shoulders;
      const cadence = this.cadence.update(sample, snapshot.timestampMs, this.jump.suppressesCadence);
      rawEffort = this.intensity.update(snapshot.timestampMs, body && { ...body, shoulders: (body.left + body.right) / 2 }, cadence.running);
      controls = { sprintSpeed01: cadence.speed01, cadenceSpm: cadence.cadenceSpm, trackingState: 'tracked' };
      const base = this.eventBase(snapshot, Math.max(torsoTracking.confidence, 0.55));
      events.push({ ...base, id: this.nextId++, type: 'sprint', speed01: cadence.speed01, cadenceSpm: cadence.cadenceSpm });
      this.sprinting = cadence.speed01 > 0;
      this.coast = cadence.speed01 > 0
        ? { speed01: cadence.speed01, cadenceSpm: cadence.cadenceSpm, measuredAt: snapshot.timestampMs }
        : undefined;
      if (cadence.step) events.push({ ...base, id: this.nextId++, type: 'step', side: cadence.step });
      if (jumped) events.push({ ...base, id: this.nextId++, type: 'jump' });
    } else {
      rawEffort = this.intensity.update(snapshot.timestampMs);
      const coasted = this.coastSprint(snapshot, torsoTracking);
      if (coasted) {
        events.push(coasted);
        controls = { sprintSpeed01: coasted.speed01, cadenceSpm: coasted.cadenceSpm, trackingState: torsoTracking.state };
      } else {
        events.push(...this.stopSprint(snapshot.timestampMs, torsoTracking.confidence, torsoTracking.state));
      }
      if (torsoTracking.state === 'lost') {
        this.cadence.reset();
        this.jump.reset();
        this.torsoChannel.reset();
        this.coast = undefined;
      }
    }

    // Lane control reads the shoulder line in image space, so it stays active whenever the
    // torso gate is tracked OR both shoulders are clearly visible (even if hips are cropped).
    if (torsoTracking.state === 'tracked' || shouldersConfident) {
      const zone = this.lanePosition.update(current);
      if (zone !== undefined) controls = { ...controls, laneZone: zone };
    }

    const swingScaleReady = calibration !== undefined && (calibration.readiness?.scale01 ?? 1) >= 0.5;
    if (!swingScaleReady) this.heldSwing = undefined;
    const results = this.swings.map(({ wrist, gate, detector, hand }) => {
      const worldHipsVisible = Boolean(
        snapshot.worldLandmarks[23]
        && snapshot.worldLandmarks[24]
        && Math.min(
          snapshot.worldLandmarks[23]!.visibility ?? snapshot.worldLandmarks[23]!.presence ?? 0,
          snapshot.worldLandmarks[24]!.visibility ?? snapshot.worldLandmarks[24]!.presence ?? 0,
        ) >= 0.35,
      );
      const swingLandmarks = worldHipsVisible ? [11, 12, 23, 24, wrist] : [11, 12, wrist];
      const tracking = gate.evaluate(snapshot, swingLandmarks, 'world');
      if (tracking.state === 'lost' || !swingScaleReady) detector.reset();
      // A degraded gate still feeds the detector, which skips weak frames itself: the gate stays degraded
      // for a good half second after one blurred frame, which is a whole stroke.
      const output = swingScaleReady && tracking.state !== 'lost' ? detector.update(current) : undefined;
      // The onset bypasses arbitration and the refractory on purpose: it is the real-time,
      // unconfirmed channel — the game's cue to start the stroke animation now, not proof of a hit.
      if (output?.kind === 'onset') {
        events.push({ ...this.eventBase(snapshot, tracking.confidence), id: this.nextId++, type: 'swing-start', hand, side: output.side });
      }
      const swing = output?.kind === 'confirmed' ? output : undefined;
      return { hand, tracked: tracking.state === 'tracked', pending: detector.hasPending(), swing };
    });
    // A held swing whose own wrist is no longer tracked is stale: discard it rather than
    // release a "tracked" hit into a dead pose. Losing only the rival is different — it
    // resolves the arbitration and the held swing goes out.
    const held = this.heldSwing;
    if (held && results.some((result) => result.hand === held.hand && !result.tracked)) this.heldSwing = undefined;
    // The strongest swing wins, not the first to confirm: confirmations inside the 400 ms
    // refractory are discarded at admission, and while a wrist still has a swing in flight
    // the rival's confirmation waits for it — bounded by the rival's own max duration.
    const eligible = snapshot.timestampMs - this.lastSwingAt >= 400;
    const pool = [
      ...(this.heldSwing ? [{ swing: this.heldSwing.swing, hand: this.heldSwing.hand }] : []),
      ...results.flatMap((result) => (result.swing && eligible ? [{ swing: result.swing, hand: result.hand }] : [])),
    ];
    const [best] = pool.sort((a, b) => b.swing.power01 - a.swing.power01);
    if (best) {
      const rivalInFlight = this.swings.some(({ detector }) => detector.hasPending());
      const holdExpired = this.heldSwing !== undefined && snapshot.timestampMs - this.heldSwing.heldSince >= SWING_MAX_DURATION_MS;
      if (rivalInFlight && !holdExpired) {
        this.heldSwing = { swing: best.swing, hand: best.hand, heldSince: this.heldSwing?.heldSince ?? snapshot.timestampMs };
      } else {
        this.heldSwing = undefined;
        this.lastSwingAt = snapshot.timestampMs;
        const { confidence, peakTimestampMs, ...action } = best.swing;
        delete (action as { kind?: unknown }).kind; // runtime-only detector discriminant, not protocol
        events.push({ ...this.eventBase(snapshot, confidence), id: this.nextId++, type: 'swing', hand: best.hand, ...action, peakTimestampMs });
      }
    }

    const footworkTracked = this.footworkGate.evaluate(snapshot).state === 'tracked';
    if (calibration && swingScaleReady && footworkTracked) {
      controls = { ...controls, guard: isGuardingPose(current, calibration) };
    }

    for (const { hand, elbow, wrist, gate, detector } of this.punches) {
      const tracking = gate.evaluate(snapshot, [11, 12, 23, 24, elbow, wrist], 'world');
      if (tracking.state === 'lost' || !swingScaleReady) detector.reset();
      else if (tracking.state === 'degraded') detector.interruptRearm();
      if (!calibration || !swingScaleReady || tracking.state === 'lost') continue;
      const output = detector.update(current, calibration);
      if (output?.kind === 'onset') {
        this.punchInFlight.start(hand, snapshot.timestampMs);
        events.push({ ...this.eventBase(snapshot, tracking.confidence), id: this.nextId++, type: 'punch-start', hand });
      } else if (output?.kind === 'confirmed') {
        const { power01, confidence, peakTimestampMs, onsetTimestampMs, measurement } = output;
        const classification = classifyPunch(measurement);
        this.punchInFlight.end(hand);
        events.push({
          ...this.eventBase(snapshot, confidence),
          id: this.nextId++,
          type: 'punch',
          hand,
          power01,
          peakTimestampMs,
          onsetTimestampMs,
          punchKind: classification.punchKind,
          punchTargetZone: classification.targetZone,
          measurement,
        });
      }
    }

    // Boxing's footwork signals need the calibrated neutral, and read the torso the vertical channel does.
    if (calibration && (calibration.readiness?.neutral01 ?? 1) >= 0.65 && footworkTracked) {
      const dodge = this.dodge.update(current, calibration);
      if (dodge !== undefined) controls = { ...controls, dodgeZone: dodge };
      // Read after the punch detectors, so the frame of a punch onset is already frozen.
      const punching = this.punchInFlight.active(snapshot.timestampMs);
      const depth = this.ringDepth.update(current, calibration, punching);
      if (depth !== undefined) controls = { ...controls, ringDepthMove: depth, ringDepth01: this.ringDepth.approach01 };
      const dash = this.lateralDash.update(current, punching);
      if (dash !== undefined) controls = { ...controls, lateralDash: dash };
      const duck = this.duckTracker.update(current, punching);
      if (duck !== undefined) controls = { ...controls, duck };
    }

    return { snapshot: current, events, controls, rawEffort, effortSampleAtMs: this.intensity.sampleAtMs, armMotions: this.arms.flatMap((arm) => arm.update(current) ?? []), swingTracking: { scaleReady: swingScaleReady, wrists: results.map(({ hand, tracked, pending }) => ({ hand, tracked, pending, arbitrating: this.heldSwing?.hand === hand })) } };
  }

  /**
   * The lane zone the tracker currently believes the body occupies. Calibration uses it as
   * context: while the zone is center no lane is held, so band displacements are stance rather
   * than control input. One frame stale by the time the next calibration update consumes it,
   * which is meaningless for a statistical admission decision.
   */
  /** Aggregated punch confirmation diagnostics, keyed by hand, for evaluation harnesses. */
  get punchDiagnostics(): Readonly<Record<Hand, PunchDiagnostics>> {
    return Object.fromEntries(this.punches.map(({ hand, detector }) => [hand, detector.diagnostics])) as Record<Hand, PunchDiagnostics>;
  }

  get laneZone(): -1 | 0 | 1 { return this.lanePosition.currentZone; }

  get dodgeZone(): -1 | 0 | 1 { return this.dodge.currentZone; }

  /**
   * The sprint event a blackout frame still owes the game: the last measured speed carried
   * forward with exponential damping, or nothing once the coast has run out — the final
   * stop is emitted by the caller through stopSprint, exactly once.
   */
  private coastSprint(snapshot: PoseSnapshot, torsoTracking: { state: TrackingState; confidence: number }): (SportActionEvent & { type: 'sprint' }) | undefined {
    if (!this.coast || !this.sprinting) return undefined;
    const sinceMeasured = snapshot.timestampMs - this.coast.measuredAt;
    const speed01 = this.coast.speed01 * 0.5 ** (sinceMeasured / COAST_HALF_LIFE_MS);
    if (sinceMeasured > COAST_TIMEOUT_MS || speed01 < COAST_MIN_SPEED01) return undefined;
    const cadenceSpm = this.coast.cadenceSpm * 0.5 ** (sinceMeasured / COAST_HALF_LIFE_MS);
    return {
      timestampMs: snapshot.timestampMs,
      confidence: torsoTracking.confidence,
      trackingState: torsoTracking.state,
      source: 'cv',
      id: this.nextId++,
      type: 'sprint',
      speed01,
      cadenceSpm,
    };
  }

  /** A new run: the player may be standing somewhere else, so the lane center is measured again. */
  recenterLane(): void { this.lanePosition.reset(); }

  /** Returns the events the game still needs, such as stopping a sprint in progress. */
  reset(timestampMs: number): SportActionEvent[] {
    const stopped = this.stopSprint(timestampMs, 0, 'lost');
    this.bodyGate.reset(); this.torsoGate.reset(); this.swings.forEach(({ gate }) => { gate.reset(); }); this.punches.forEach(({ gate }) => { gate.reset(); });
    this.resetDetectors();
    this.coast = undefined;
    return stopped;
  }

  private stopSprint(timestampMs: number, confidence: number, trackingState: TrackingState): SportActionEvent[] {
    if (!this.sprinting) return [];
    this.sprinting = false;
    return [{ timestampMs, confidence, trackingState, source: 'cv', id: this.nextId++, type: 'sprint', speed01: 0, cadenceSpm: 0 }];
  }

  private eventBase(snapshot: PoseSnapshot, confidence: number) {
    return { timestampMs: snapshot.timestampMs, confidence, trackingState: 'tracked' as const, source: 'cv' as const };
  }

  private resetDetectors(): void { this.arms.forEach((arm) => { arm.reset(); }); this.cadence.reset(); this.jump.reset(); this.intensity.reset(); this.torsoChannel.reset(); this.lanePosition.reset(); this.dodge.reset(); this.footworkGate.reset(); this.ringDepth.reset(); this.lateralDash.reset(); this.duckTracker.reset(); this.punchInFlight.reset(); this.punches.forEach(({ detector }) => { detector.reset(); }); this.swings.forEach(({ detector }) => { detector.reset(); }); this.lastSwingAt = Number.NEGATIVE_INFINITY; this.heldSwing = undefined; }
}
