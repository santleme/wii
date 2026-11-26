import type { CalibrationProfile, ContinuousControls, Hand, PoseSnapshot, SportActionEvent, TrackingState } from '../cv/protocol';
import { CadenceTracker } from './cadenceTracker';
import { JumpDetector } from './jumpDetector';
import { LaneLeanDetector } from './postureSignals';
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
const COAST_TIMEOUT_MS = 600;
const COAST_HALF_LIFE_MS = 150;
/** Below this the carried speed is indistinguishable from stopped; the coast ends in a clean zero. */
const COAST_MIN_SPEED01 = 0.02;

export class ActionPipeline {
  private readonly bodyGate = new TrackingGate();
  /** One gate and one vertical channel for the torso core: cadence and jump read the same frame's sample. */
  private readonly torsoGate = new TrackingGate([11, 12, 23, 24]);
  private readonly torsoChannel = new TorsoVerticalChannel();
  private readonly laneGate = new TrackingGate([11, 12, 23, 24], 'world');
  private readonly cadence = new CadenceTracker();
  private readonly jump = new JumpDetector();
  private readonly lean = new LaneLeanDetector();
  /** One detector per wrist: whichever arm swings is the racket hand. */
  private readonly swings = ([['right', 16], ['left', 15]] as const).map(([hand, wrist]) => (
    { hand, wrist, gate: new TrackingGate([], 'world'), detector: new SwingDetector(hand) }
  ));
  private lastSwingAt = Number.NEGATIVE_INFINITY;
  /** Confirmed swing held back while the other wrist still has one in flight, so the stronger wins. */
  private heldSwing?: { swing: SwingSignal; hand: Hand; heldSince: number };
  private nextId = 1;
  /** True while the last emitted sprint event left the game moving. */
  private sprinting = false;
  /** Last moving sprint measurement and when it was taken — the input coasting decays from. */
  private coast?: { speed01: number; cadenceSpm: number; measuredAt: number };

  update(snapshot: PoseSnapshot, calibration?: CalibrationProfile): { snapshot: PoseSnapshot; events: SportActionEvent[]; controls: ContinuousControls; kinematicsMs: number } {
    const start = performance.now();
    const body = this.bodyGate.evaluate(snapshot);
    const current = { ...snapshot, trackingState: body.state, bodyConfidence: body.confidence };
    const events: SportActionEvent[] = [];
    let controls: ContinuousControls = { sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'lost' };

    const torsoTracking = this.torsoGate.evaluate(snapshot);
    controls = { ...controls, trackingState: torsoTracking.state };
    if (torsoTracking.state === 'tracked') {
      const sample = this.torsoChannel.update(current, this.jump.suppressesCadence);
      const jumped = sample ? this.jump.update(sample) : false;
      const cadence = this.cadence.update(sample, snapshot.timestampMs, this.jump.suppressesCadence);
      controls = { sprintSpeed01: cadence.speed01, cadenceSpm: cadence.cadenceSpm, trackingState: 'tracked' };
      const base = this.eventBase(snapshot, torsoTracking.confidence);
      events.push({ ...base, id: this.nextId++, type: 'sprint', speed01: cadence.speed01, cadenceSpm: cadence.cadenceSpm });
      this.sprinting = cadence.speed01 > 0;
      this.coast = cadence.speed01 > 0
        ? { speed01: cadence.speed01, cadenceSpm: cadence.cadenceSpm, measuredAt: snapshot.timestampMs }
        : undefined;
      if (cadence.step) events.push({ ...base, id: this.nextId++, type: 'step', side: cadence.step });
      if (jumped) events.push({ ...base, id: this.nextId++, type: 'jump' });
    } else {
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

    const laneTracking = this.laneGate.evaluate(snapshot);
    const laneReady = calibration !== undefined && (calibration.readiness?.neutral01 ?? 1) >= 0.65;
    if (!laneReady) this.lean.reset();
    else if (laneTracking.state === 'tracked') {
      const lane = this.lean.update(current, calibration);
      if (lane) events.push({ ...this.eventBase(snapshot, laneTracking.confidence), id: this.nextId++, type: 'lane', direction: lane });
    } else if (laneTracking.state === 'lost') this.lean.reset();

    const swingScaleReady = calibration !== undefined && (calibration.readiness?.scale01 ?? 1) >= 0.5;
    if (!swingScaleReady) this.heldSwing = undefined;
    const results = this.swings.map(({ wrist, gate, detector, hand }) => {
      const tracking = gate.evaluate(snapshot, [11, 12, 23, 24, wrist], 'world');
      if (tracking.state === 'lost' || !swingScaleReady) detector.reset();
      else if (tracking.state === 'degraded') detector.interruptRearm();
      const output = calibration && swingScaleReady && tracking.state === 'tracked' ? detector.update(current, calibration) : undefined;
      // The onset bypasses arbitration and the refractory on purpose: it is the real-time,
      // unconfirmed channel — the game's cue to start the stroke animation now, not proof of a hit.
      if (output?.kind === 'onset') {
        events.push({ ...this.eventBase(snapshot, tracking.confidence), id: this.nextId++, type: 'swing-start', hand });
      }
      const swing = output?.kind === 'confirmed' ? output : undefined;
      return { hand, tracked: tracking.state === 'tracked', swing };
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
        events.push({ ...this.eventBase(snapshot, confidence), id: this.nextId++, type: 'swing', ...action, peakTimestampMs });
      }
    }

    return { snapshot: current, events, controls, kinematicsMs: performance.now() - start };
  }

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

  /** Returns the events the game still needs, such as stopping a sprint in progress. */
  reset(): SportActionEvent[] {
    const stopped = this.stopSprint(performance.now(), 0, 'lost');
    this.bodyGate.reset(); this.torsoGate.reset(); this.laneGate.reset(); this.swings.forEach(({ gate }) => { gate.reset(); });
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

  private resetDetectors(): void { this.cadence.reset(); this.jump.reset(); this.torsoChannel.reset(); this.lean.reset(); this.swings.forEach(({ detector }) => { detector.reset(); }); this.lastSwingAt = Number.NEGATIVE_INFINITY; this.heldSwing = undefined; }
}
