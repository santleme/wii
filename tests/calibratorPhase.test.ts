import { describe, expect, it } from 'vitest';
import { AdaptiveCalibrator, type CalibratorPhase } from '../src/cv/adaptiveCalibrator';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { pose, poseWithWorldShoulderWidth } from './fixtures/syntheticPose';

/**
 * The calibrator's phase is derived from the timers and estimates it already keeps, and
 * the pipeline spends the 'calibrating' tracking state while that phase lasts. These
 * tests walk the estimator through each regime and assert the name it reports, then pin
 * the wiring: only a would-be 'degraded' frame is relabeled, never a tracked or lost one.
 */
function phasesSeen(calibrator: AdaptiveCalibrator, frames: ReturnType<typeof pose>[], laneZone: -1 | 0 | 1): CalibratorPhase[] {
  const seen: CalibratorPhase[] = [];
  for (const frame of frames) {
    calibrator.update(frame, laneZone);
    if (seen.at(-1) !== calibrator.phase) seen.push(calibrator.phase);
  }
  return seen;
}

function centered(from: number, to: number) {
  const frames = [];
  for (let t = from; t <= to; t += 35) frames.push(pose(t));
  return frames;
}

function displaced(from: number, to: number) {
  const frames = [];
  for (let t = from; t <= to; t += 35) frames.push(pose(t, { shiftUserRightSw: 0.3 }));
  return frames;
}

describe('calibrator phase', () => {
  it('collects until the first profile publishes, then publishes', () => {
    const calibrator = new AdaptiveCalibrator();
    expect(calibrator.phase).toBe('collecting');
    expect(phasesSeen(calibrator, centered(0, 300), 0)).toEqual(['collecting']);
    expect(phasesSeen(calibrator, centered(335, 1400), 0)).toEqual(['collecting', 'publishing']);
  });

  it('freezes the center while posture evidence is starved off-center', () => {
    const calibrator = new AdaptiveCalibrator();
    phasesSeen(calibrator, centered(0, 1400), 0);
    const seen = phasesSeen(calibrator, displaced(1435, 20000), 1);

    expect(seen).toEqual(['publishing', 'center-frozen']);
    expect(calibrator.phase).toBe('center-frozen');
    // The frozen center is the published one: starvation held it, it did not drift.
    const profile = calibrator.update(pose(20035, { shiftUserRightSw: 0.3 }), 1);
    expect(profile!.image.shoulderCenterX0).toBeCloseTo(0.5, 2);
  });

  it('relocates after sustained starvation, then settles back to publishing', () => {
    const calibrator = new AdaptiveCalibrator();
    phasesSeen(calibrator, centered(0, 1400), 0);
    const seen = phasesSeen(calibrator, displaced(1435, 55000), 1);

    // The full lifecycle of a player who quietly moved house: the center freezes while
    // the absence is still ambiguous, relocation reopens admission past half a minute,
    // the hurried blend reads as a change-point while it converges, then quiet again.
    expect(seen).toEqual(['publishing', 'center-frozen', 'relocating', 'change-point', 'publishing']);
    expect(calibrator.phase).toBe('publishing');
  });

  it('names a sustained scale disagreement a change-point until the blend catches up', () => {
    const calibrator = new AdaptiveCalibrator();
    phasesSeen(calibrator, centered(0, 1400), 0);
    const wide = [];
    for (let t = 1435; t <= 16000; t += 35) wide.push(poseWithWorldShoulderWidth(t, 0.62));
    const seen = phasesSeen(calibrator, wide, 0);

    expect(seen).toEqual(['publishing', 'change-point', 'publishing']);
    const profile = calibrator.update(poseWithWorldShoulderWidth(16035, 0.62), 0);
    expect(profile!.world.shoulderWidth).toBeGreaterThan(0.55);
  });

  it('returns to collecting on reset', () => {
    const calibrator = new AdaptiveCalibrator();
    phasesSeen(calibrator, centered(0, 1400), 0);
    expect(calibrator.phase).toBe('publishing');
    calibrator.reset();
    expect(calibrator.phase).toBe('collecting');
  });
});

describe('calibrating tracking state', () => {
  it('labels a would-be degraded frame calibrating while the calibrator collects', () => {
    const pipeline = new ActionPipeline();
    const first = pipeline.update(pose(0), undefined, true);
    expect(first.snapshot.trackingState).toBe('calibrating');
    // Only the session snapshot is relabeled: the controls keep the gate's own state,
    // because games make coasting decisions from it.
    expect(first.controls.trackingState).toBe('degraded');
  });

  it('keeps the gate state when the calibrator is no longer collecting', () => {
    const pipeline = new ActionPipeline();
    expect(pipeline.update(pose(0), undefined, false).snapshot.trackingState).toBe('degraded');
    // The default (no flag) is the pre-wiring behavior.
    const unflagged = new ActionPipeline();
    expect(unflagged.update(pose(0)).snapshot.trackingState).toBe('degraded');
  });

  it('never downgrades a tracked frame, and never relabels a lost one', () => {
    const pipeline = new ActionPipeline();
    let state;
    for (let t = 0; t <= 350; t += 35) state = pipeline.update(pose(t), undefined, true).snapshot.trackingState;
    expect(state).toBe('tracked');

    const blind = new ActionPipeline();
    const hidden = pose(0, { hiddenLandmarks: [11, 12, 23, 24] });
    expect(blind.update(hidden, undefined, true).snapshot.trackingState).toBe('lost');
  });

  it('follows the calibrator across a session: calibrating first, gate states after', () => {
    const calibrator = new AdaptiveCalibrator();
    const pipeline = new ActionPipeline();
    let profile;
    const states: string[] = [];
    for (let t = 0; t <= 1400; t += 35) {
      const frame = pose(t);
      profile = calibrator.update(frame, 0) ?? profile;
      const { snapshot } = pipeline.update(frame, profile, calibrator.phase === 'collecting');
      if (states.at(-1) !== snapshot.trackingState) states.push(snapshot.trackingState);
    }
    // The gate confirms tracking within a few frames, long before the first profile
    // publishes (~700 ms): those tracked frames are never relabeled, so the session
    // shows a brief calibrating opening and then plain tracked.
    expect(states).toEqual(['calibrating', 'tracked']);
    expect(calibrator.phase).toBe('publishing');
  });
});
