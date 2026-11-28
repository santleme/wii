import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from '@wii/spatial-core';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { landmarkConfidence } from '../src/kinematics/math';
import { calibration, pose, poseWithHipBounce } from './fixtures/syntheticPose';
import { cadenceHarness } from './fixtures/torsoHarness';

/** Feeds the pipeline with torso bounce at 150 spm between `from` and `until` — the run-in-place signal. */
function driveBounce(pipeline: ActionPipeline, profile: ReturnType<typeof calibration>, from: number, until: number, startAt = 0) {
  const hz = 150 / 60;
  for (let time = startAt; time <= until; time += 33) {
    const units = time >= from ? 0.04 * Math.sin((2 * Math.PI * hz * (time - from)) / 1000) : 0;
    const sway = time >= from ? 0.04 * Math.cos((2 * Math.PI * hz * (time - from)) / 1000) : 0;
    pipeline.update(poseWithHipBounce(time, units * 0.4, undefined, sway), profile);
  }
}

function withWorldConfidence(snapshot: ReturnType<typeof pose>, index: number, visibility: number, presence: number) {
  return {
    ...snapshot,
    worldLandmarks: snapshot.worldLandmarks.map((point, pointIndex) => pointIndex === index ? { ...point, visibility, presence } : point),
  };
}

describe('1-Euro filter', () => {
  it('reduces static jitter and follows a fast movement', () => {
    const filter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
    const noisy = [0, 0.02, -0.02, 0.01, -0.01, 0];
    const outputs = noisy.map((value, i) => filter.filter(value, i * 33));
    expect(Math.abs(outputs.at(-1)!)).toBeLessThan(0.02);
    const moved = filter.filter(1, 200);
    expect(moved).toBeGreaterThan(outputs.at(-1)!);
  });

  it('ignores a non-finite sample instead of poisoning every later output', () => {
    const filter = new OneEuroFilter({ minCutoff: 1, beta: 0.5, derivativeCutoff: 1 });
    expect(filter.filter(0, 0)).toBe(0);
    expect(filter.filter(Number.NaN, 33)).toBe(0);
    const after = filter.filter(0.5, 66);
    expect(Number.isFinite(after)).toBe(true);
    expect(after).toBeGreaterThan(0);
  });
});

describe('landmark confidence', () => {
  it('returns zero for no visible points and falls back to presence when visibility is omitted', () => {
    expect(landmarkConfidence()).toBe(0);
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, presence: 0.8 })).toBe(0.8);
  });

  it('returns zero for non-finite confidence instead of propagating it', () => {
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, visibility: Number.NaN })).toBe(0);
    // NaN masks a finite presence through Math.min; positive infinity masks it only when both are infinite.
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, visibility: Number.NaN, presence: 0.9 })).toBe(0);
    expect(landmarkConfidence({ x: 0, y: 0, z: 0, visibility: Number.POSITIVE_INFINITY, presence: 0.9 })).toBe(0.9);
  });
});

describe('cadence tracker', () => {
  it('counts steps from torso bounce and reports a bounded arcade speed', () => {
    const { feed } = cadenceHarness();
    const results = [];
    for (let time = 0; time <= 4000; time += 33) {
      const active = time >= 200 && time <= 3000;
      const units = active ? 0.04 * Math.sin((2 * Math.PI * 2.5 * (time - 200)) / 1000) : 0;
      results.push({ time, ...feed(poseWithHipBounce(time, units * 0.4)) });
    }
    const steps = results.filter((r) => r.step);
    expect(steps.length).toBeGreaterThan(3);
    const active = results.filter((r) => r.time > 1500 && r.time <= 3000);
    expect(active.every((r) => r.speed01 > 0)).toBe(true);
    expect(Math.max(...results.map((r) => r.speed01))).toBeLessThanOrEqual(1);
    expect(results.at(-1)!.cadenceSpm).toBe(0);
  });

  it('drops the previous cadence window after a long pause', () => {
    const { feed } = cadenceHarness();
    const hz = 2.5;
    const results = [];
    for (let time = 0; time <= 6000; time += 33) {
      const bouncing = (time >= 200 && time <= 2000) || (time >= 4600 && time <= 4700);
      const units = bouncing ? 0.04 * Math.sin((2 * Math.PI * hz * time) / 1000) : 0;
      results.push({ time, ...feed(poseWithHipBounce(time, units * 0.4)) });
    }
    // Steady bouncing establishes a cadence...
    expect(results.filter((r) => r.time > 1200 && r.time <= 2000).every((r) => r.speed01 > 0)).toBe(true);
    // ...it stops during the pause (within the 1.6-period stop deadline), and the brief
    // pulse afterwards cannot resurrect it.
    expect(results.filter((r) => r.time > 2800).every((r) => r.cadenceSpm === 0)).toBe(true);
  });
});

describe('action pipeline tracking gate', () => {
  it('keeps all discrete action signals quiet for a stationary jitter fixture', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const events = Array.from({ length: 90 }, (_, index) => {
      const jitter = index % 2 === 0 ? 0.015 : -0.015;
      return pipeline.update(pose(index * 33, { kneeLeft: jitter, kneeRight: -jitter, wristLateral: jitter / 10 }), profile).events;
    }).flat().filter((event) => event.type !== 'sprint');
    expect(events).toHaveLength(0);
  });

  it('does not emit sport actions while pose confidence is lost', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const visible = [pose(0), pose(33), pose(66)];
    visible.forEach((frame) => { pipeline.update(frame, profile); });
    const lost = [pose(100, { confidence: 0.1 }), pose(133, { confidence: 0.1 }), pose(166, { confidence: 0.1 }), pose(199, { confidence: 0.1 })];
    expect(lost.flatMap((frame) => pipeline.update(frame, profile).events)).toHaveLength(0);
  });

  it('keeps upper-body swings available when knees are outside the camera frame', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hiddenKnees = { hiddenLandmarks: [25, 26] } as const;
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time, hiddenKnees), profile); });
    pipeline.update(pose(100, { ...hiddenKnees, wristLateral: -0.3 }), profile);
    const result = pipeline.update(pose(133, { ...hiddenKnees, wristLateral: 0.2 }), profile);
    expect(result.snapshot.trackingState).toBe('tracked');
    expect(result.events.filter((event) => event.type === 'swing')).toHaveLength(1);
    expect(result.events.filter((event) => event.type === 'sprint').every((event) => event.speed01 === 0)).toBe(true);
  });

  it('preserves the step stream through a one-frame confidence dip', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const bounceAt = (time: number) => poseWithHipBounce(time, 0.04 * Math.sin((2 * Math.PI * hz * time) / 1000) * 0.4);
    for (let time = 0; time <= 1500; time += 33) pipeline.update(bounceAt(time), profile);
    const before = pipeline.update(bounceAt(1533), profile);
    expect(before.controls.trackingState).toBe('tracked');
    const degraded = pipeline.update(pose(1566, { confidence: 0.1 }), profile);
    // The run was under way, so one bad frame coasts it instead of stopping it.
    expect(degraded.controls.trackingState).toBe('degraded');
    expect(degraded.controls.sprintSpeed01).toBeGreaterThan(0.4);
    expect(degraded.events.filter((event) => event.type === 'step')).toHaveLength(0);
    // The gate needs three consecutive good frames to leave 'degraded' — and no spurious
    // step fires out of the dip itself.
    const recovery = [1599, 1632, 1665].map((time) => pipeline.update(bounceAt(time), profile));
    expect(recovery.at(-1)!.controls.trackingState).toBe('tracked');
  });

  it('exposes neutral continuous sprint control as cadence tracking is lost', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    const active = pipeline.update(poseWithHipBounce(1079, 0), profile);
    expect(active.controls.sprintSpeed01).toBeGreaterThan(0);
    // A sustained blackout — past the gate's 800 ms window — ends in 'lost' with the
    // sprint fully stopped (the coast has long decayed by then).
    const blackout = [];
    for (let time = 1112; time <= 2000; time += 33) blackout.push(pipeline.update(pose(time, { hiddenLandmarks: [11, 12] }), profile));
    const lost = blackout.at(-1)!;
    expect(lost.controls).toMatchObject({ sprintSpeed01: 0, cadenceSpm: 0, trackingState: 'lost' });
  });

  it.each([
    ['hidden hips', 'degraded'],
    ['reset', 'lost'],
  ] as const)('stops the sprint exactly once on %s', (cause, state) => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    pipeline.update(poseWithHipBounce(1079, 0), profile);
    const after = [1112, 1145, 1178, 1211, 1244, 2000].flatMap((time) => {
      if (cause === 'reset') return pipeline.reset(time);
      return pipeline.update(pose(time, { hiddenLandmarks: [11, 12] }), profile).events;
    });
    const stops = after.filter((event) => event.type === 'sprint' && event.speed01 === 0);
    expect(stops).toHaveLength(1);
    // The stop rides whatever tracking state the frame carries when the coast runs out —
    // degraded early in the blackout, lost once the blackout is sustained.
    if (cause === 'reset') {
      expect(stops[0]).toMatchObject({ timestampMs: 1112, speed01: 0, cadenceSpm: 0, trackingState: state });
    }
    else expect(stops[0]?.trackingState).not.toBe('tracked');
  });

  it('coasts the sprint with damping through a brief blackout instead of dropping it in a step', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    const active = pipeline.update(poseWithHipBounce(1079, 0), profile);
    const speedBefore = active.controls.sprintSpeed01;
    expect(speedBefore).toBeGreaterThan(0.3);
    // A ~200 ms blur burst: the speed must decay smoothly, never hitting zero — and no
    // stop event may fire.
    const burst = [1112, 1145, 1178, 1211, 1244, 1277].map((time) => pipeline.update(pose(time, { hiddenLandmarks: [11, 12] }), profile));
    const speeds = burst.map((result) => result.controls.sprintSpeed01);
    expect(speeds.every((speed) => speed > 0)).toBe(true);
    expect(speeds[0]!).toBeLessThan(speedBefore);
    expect(speeds.at(-1)!).toBeLessThan(speeds[0]!);
    // Half-life 150 ms: ~230 ms into the blackout the carried speed sits at roughly a third.
    expect(speeds.at(-1)!).toBeGreaterThan(speedBefore * 0.2);
    expect(speeds.at(-1)!).toBeLessThan(speedBefore * 0.6);
    expect(burst.flatMap((result) => result.events).filter((event) => event.type === 'sprint' && event.speed01 === 0)).toHaveLength(0);
    expect(burst.every((result) => result.controls.trackingState === 'degraded')).toBe(true);
  });

  it('keeps the cadence memory through a burst: the run re-engages within a few frames of return', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const bounceAt = (time: number) => poseWithHipBounce(time, 0.04 * Math.sin((2 * Math.PI * hz * (time - 66)) / 1000) * 0.4);
    driveBounce(pipeline, profile, 66, 1046);
    pipeline.update(bounceAt(1079), profile);
    // The player keeps running through a ~300 ms blackout the camera cannot see.
    for (let time = 1112; time <= 1400; time += 33) pipeline.update(pose(time, { hiddenLandmarks: [11, 12] }), profile);
    // Detectors were never reset: the cadence memory is warm, so measured cadence flows
    // within the first tracked frames — a from-scratch restart would emit nothing for
    // ~2 step intervals (~800 ms at 150 spm). The median-of-three then purges the
    // blackout-stretched intervals over the next few steps, converging back to full pace.
    const early = [1433, 1466, 1499, 1532].map((time) => pipeline.update(bounceAt(time), profile));
    expect(early.at(-1)!.controls.trackingState).toBe('tracked');
    expect(early.at(-1)!.controls.cadenceSpm).toBeGreaterThan(40);
    const settled = [];
    for (let time = 1565; time <= 2400; time += 33) settled.push(pipeline.update(bounceAt(time), profile));
    expect(Math.max(...settled.map((result) => result.controls.sprintSpeed01))).toBeGreaterThan(0.4);
  });

  it('ends the coast in a single clean stop when the blackout outlasts the timeout', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    pipeline.update(poseWithHipBounce(1079, 0), profile);
    // Beyond the 600 ms coast timeout the runner must be fully stopped — and the zero
    // emitted exactly once even though bad frames keep coming.
    const blackout = [];
    for (let time = 1112; time <= 1750; time += 33) blackout.push(pipeline.update(pose(time, { hiddenLandmarks: [11, 12] }), profile));
    const stops = blackout.flatMap((result) => result.events).filter((event) => event.type === 'sprint' && event.speed01 === 0);
    expect(stops).toHaveLength(1);
    expect(blackout.at(-1)!.controls.sprintSpeed01).toBe(0);
    // 600+ ms is still inside the gate's 800 ms blackout window: degraded, not lost —
    // the detectors survive even this.
    expect(blackout.at(-1)!.controls.trackingState).toBe('degraded');
  });

  it('keeps cadence running when calibration is removed mid-stream', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const bounceAt = (time: number) => poseWithHipBounce(time, 0.04 * Math.sin((2 * Math.PI * hz * (time - 66)) / 1000) * 0.4);
    for (let time = 0; time <= 1046; time += 33) pipeline.update(bounceAt(time), profile);

    const frames = [1079, 1112, 1145].map((time) => pipeline.update(bounceAt(time)));
    expect(frames.every((frame) => frame.controls.trackingState === 'tracked')).toBe(true);
    expect(frames.at(-1)!.controls.sprintSpeed01).toBeGreaterThan(0);
    expect(frames.flatMap((frame) => frame.events).filter((event) => event.type === 'sprint' && event.speed01 === 0)).toHaveLength(0);
  });

  it('keeps the sprint going when the knees leave the camera frame', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const events = [];
    for (let time = 0; time <= 2500; time += 33) {
      const units = time >= 66 ? 0.04 * Math.sin((2 * Math.PI * hz * (time - 66)) / 1000) : 0;
      const snapshot = poseWithHipBounce(time, units * 0.4);
      // Knees and ankles are out of frame the whole time — irrelevant for torso-driven cadence.
      const hiddenLegs = {
        ...snapshot,
        landmarks: snapshot.landmarks.map((point, index) => (index >= 25 ? { ...point, visibility: 0, presence: 0 } : point)),
      };
      events.push(...pipeline.update(hiddenLegs, profile).events);
    }
    const steps = events.filter((event) => event.type === 'step');
    expect(steps.length).toBeGreaterThan(3);
    expect(events.filter((event) => event.type === 'sprint').every((event) => event.trackingState === 'tracked')).toBe(true);
  });

  it('stamps sprint events with the torso gate state of their own frame, not a fixed tracked', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    // Exactly one hip below the visibility floor: the cadence branch still runs through the
    // shoulders-confident fallback while the torso gate needs its first frames to confirm.
    const weakHip = (time: number, bounce: number) => {
      const snapshot = poseWithHipBounce(time, bounce);
      snapshot.landmarks = snapshot.landmarks.map((point, index) =>
        index === 24 ? { ...point, visibility: 0.4, presence: 0.4 } : point);
      return snapshot;
    };
    const stamps: string[] = [];
    for (let time = 0; time <= 330; time += 33) {
      const bounce = 0.05 * Math.sin((2 * Math.PI * time) / 400);
      for (const event of pipeline.update(weakHip(time, bounce), profile).events) {
        if (event.type === 'sprint') stamps.push(`${event.timestampMs}:${event.trackingState}`);
      }
    }
    expect(stamps[0]).toBe('0:degraded');
    expect(stamps[1]).toBe('33:degraded');
    expect(stamps.at(-1)).toBe('330:tracked');
  });

  it('keeps a standstill measured on a tracked pose stamped as tracked', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    driveBounce(pipeline, profile, 66, 1046);
    pipeline.update(poseWithHipBounce(1079, 0), profile);
    const still = [1600, 1633].flatMap((time) => pipeline.update(pose(time), profile).events);
    expect(still.filter((event) => event.type === 'sprint')).toMatchObject([
      { speed01: 0, cadenceSpm: 0, trackingState: 'tracked' },
      { speed01: 0, cadenceSpm: 0, trackingState: 'tracked' },
    ]);
  });

  it('keeps the swing arc across a brief wrist occlusion and reports the gate confidence', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(withWorldConfidence(pose(99, { wristLateral: -0.3 }), 11, 0.6, 0.6), profile);
    pipeline.update(withWorldConfidence(pose(132, { wristLateral: -0.3 }), 16, 0.1, 0.1), profile);
    const events = [pose(165, { wristLateral: 0.2 }), pose(198, { wristLateral: 0.2 }), pose(231, { wristLateral: 0.2 })]
      .flatMap((frame) => pipeline.update(frame, profile).events);
    const swing = events.find((event) => event.type === 'swing');
    expect(swing).toMatchObject({ type: 'swing', confidence: 0.6 });
    expect(swing?.timestampMs).toBe(165);
    expect(swing?.type === 'swing' ? swing.peakTimestampMs : undefined).toBe(99);
  });

  it('keeps cadence events while filtering a small periodic hip bounce out of jump events', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const events = [];
    for (let time = 0; time <= 3000; time += 33) {
      const units = time >= 200 ? 0.05 * Math.sin((2 * Math.PI * time) / 500) : 0;
      events.push(...pipeline.update(poseWithHipBounce(time, units * 0.4), profile).events);
    }
    // The hip bounce IS the running signal now — cadence comes from the same channel that
    // the jump detector must reject as a jump.
    expect(events.filter((event) => event.type === 'step').length).toBeGreaterThan(3);
    expect(events.filter((event) => event.type === 'jump')).toHaveLength(0);
  });

  it('uses peak-frame confidence even when confidence is lower at confirmation time', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.3 }), profile);
    pipeline.update(withWorldConfidence(pose(132, { wristLateral: -0.3 }), 16, 0.1, 0.1), profile);
    const events = [pose(165, { wristLateral: 0.2 }), pose(198, { wristLateral: 0.2 }), withWorldConfidence(pose(231, { wristLateral: 0.2 }), 11, 0.6, 0.6)]
      .flatMap((frame) => pipeline.update(frame, profile).events);
    const swing = events.find((event) => event.type === 'swing');
    expect(swing).toMatchObject({ type: 'swing', confidence: 0.95, timestampMs: 165, peakTimestampMs: 99 });
  });

  it('uses landmark presence as well as visibility to gate a swing', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const lowPresence = (time: number, wristLateral = 0) => withWorldConfidence(pose(time, { wristLateral }), 11, 0.95, 0.4);
    [0, 33, 66].forEach((time) => { pipeline.update(lowPresence(time), profile); });
    pipeline.update(lowPresence(99, -0.3), profile);
    const result = pipeline.update(lowPresence(132, 0.2), profile);
    expect(result.events.filter((event) => event.type === 'swing')).toHaveLength(0);
  });

  it('keeps swings and tracking alive when only the hips are missing (shoulder-anchored gate)', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const missingHips = (time: number, wristLateral = 0) => {
      const snapshot = pose(time, { wristLateral });
      snapshot.landmarks = snapshot.landmarks.map((point, index) => [23, 24].includes(index) ? { ...point, visibility: 0.1, presence: 0.1 } : point);
      return snapshot;
    };
    [0, 33, 66].forEach((time) => { pipeline.update(missingHips(time), profile); });
    pipeline.update(missingHips(99, -0.3), profile);
    const recovery = pipeline.update(missingHips(132, 0.2), profile);
    const swing = recovery.events.find((event) => event.type === 'swing');
    expect(recovery.snapshot.trackingState).toBe('tracked');
    expect(swing).toMatchObject({ type: 'swing', trackingState: 'tracked' });
  });
});

describe('mão da raquete', () => {
  it.each(['wristLateral', 'leftWristLateral'] as const)('reconhece o golpe sem escolher a mão (%s)', (wrist) => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const frames = [pose(0), pose(33), pose(66), pose(99), pose(132, { [wrist]: -0.3 }), pose(165, { [wrist]: 0.2 }), pose(198, { [wrist]: 0.2 })];
    const swings = frames.flatMap((frame) => pipeline.update(frame, profile).events).filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
  });

  it('segura a confirmação enquanto a outra mão ainda voa e deixa o golpe mais forte vencer', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    // Weak right arc reverses and confirms fast; the left wrist starts a strong arc in the
    // same frame, so the right's confirmation is held instead of locking the left out.
    pipeline.update(pose(99, { wristLateral: -0.15 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.15 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    pipeline.update(pose(165, { leftWristLateral: 0.35 }), profile);
    pipeline.update(pose(198, { leftWristLateral: 0.55 }), profile);
    const released = pipeline.update(pose(231, { leftWristLateral: 0.2 }), profile);
    const swings = released.events.filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
    expect(swings[0]).toMatchObject({ side: 'forehand' });
    expect(swings[0]!.type === 'swing' && swings[0]!.power01).toBeGreaterThan(0.5);
  });

  it('descarta o golpe segurado quando a escala deixa de ser confiável antes da liberação', () => {
    const pipeline = new ActionPipeline();
    const ready = { ...calibration(), readiness: { scale01: 1, neutral01: 1 } };
    const unready = { ...calibration(), readiness: { scale01: 0, neutral01: 1 } };
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), ready); });
    pipeline.update(pose(99, { wristLateral: -0.15 }), ready);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.35 }), ready);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);

    const fallen = pipeline.update(pose(165, { wristLateral: 0.05, leftWristLateral: 0.35 }), unready);
    expect(fallen.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    const recovered = pipeline.update(pose(198, { wristLateral: 0.05, leftWristLateral: 0.35 }), ready);
    expect(recovered.events.filter((event) => event.type === 'swing')).toHaveLength(0);
  });

  it('solta o golpe segurado quando a mão rival perde o rastreamento sem confirmar', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.3, leftWristLateral: 0.3 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.1, leftWristLateral: 0.5 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    // Left wrist vanishes for good: once its gate crosses the sustained-blackout window
    // into lost the pending arc dies and the held swing emits.
    const frames = [];
    for (let time = 165; time <= 1100; time += 33) frames.push(time);
    const swings = frames
      .flatMap((time) => pipeline.update(withWorldConfidence(pose(time, { wristLateral: 0.1 }), 15, 0, 0), profile).events)
      .filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
  });

  it('desiste de esperar quando o rival fica degradado sem confirmar nem perder o rastreamento', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.3, leftWristLateral: 0.3 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.1, leftWristLateral: 0.5 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    // 3 bad + 1 good keeps the rival gate forever degraded: its pending arc is never updated,
    // never confirmed and never reset — only the hold bound frees the waiting swing.
    const flapping = (time: number) => (Math.floor((time - 165) / 33) % 4 === 3
      ? pose(time, { wristLateral: 0.1 })
      : withWorldConfidence(pose(time, { wristLateral: 0.1 }), 15, 0, 0));
    const frames = Array.from({ length: 15 }, (_, i) => 165 + i * 33);
    const swings = frames.flatMap((time) => pipeline.update(flapping(time), profile).events).filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(1);
  });

  it('descarta a confirmação dentro do bloqueio em vez de deixá-la disputar depois', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.3 }), profile);
    const first = pipeline.update(pose(132, { wristLateral: 0.2 }), profile);
    expect(first.events.filter((event) => event.type === 'swing')).toHaveLength(1);
    // The other arm swings and confirms inside the 400 ms block: dropped for good.
    const later = [165, 198, 231, 264, 297, 330, 600, 633].flatMap((time) => pipeline.update(
      pose(time, { wristLateral: 0.2, leftWristLateral: time >= 198 ? 0.5 : 0 }),
      profile,
    ).events);
    expect(later.filter((event) => event.type === 'swing')).toHaveLength(0);
  });

  it('descarta o golpe segurado quando o próprio pulso perde o rastreamento', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    [0, 33, 66].forEach((time) => { pipeline.update(pose(time), profile); });
    pipeline.update(pose(99, { wristLateral: -0.15, leftWristLateral: 0.15 }), profile);
    const held = pipeline.update(pose(132, { wristLateral: 0.05, leftWristLateral: 0.35 }), profile);
    expect(held.events.filter((event) => event.type === 'swing')).toHaveLength(0);
    // Both wrists vanish: the held swing's own basis is gone — it must be dropped, not released.
    const lost = (time: number) => withWorldConfidence(withWorldConfidence(pose(time, { wristLateral: 0.05 }), 15, 0, 0), 16, 0, 0);
    const frames = Array.from({ length: 10 }, (_, index) => 165 + index * 33);
    const swings = frames.flatMap((time) => pipeline.update(lost(time), profile).events).filter((event) => event.type === 'swing');
    expect(swings).toHaveLength(0);
  });
});

describe('action pipeline (upper-body only)', () => {
  /** Full torso-core visibility, legs and wrists absent in BOTH spaces the whole time. */
  const torsoOnly = (time: number, hipYOffset = 0) => {
    const snapshot = poseWithHipBounce(time, hipYOffset);
    return {
      ...snapshot,
      landmarks: snapshot.landmarks.map((point, index) => (index >= 25 || index === 15 || index === 16 ? { ...point, visibility: 0, presence: 0 } : point)),
      worldLandmarks: snapshot.worldLandmarks.map((point, index) => (index >= 25 || index === 15 || index === 16 ? { ...point, visibility: 0, presence: 0 } : point)),
    };
  };

  it('produces sprint and step events with legs and wrists absent the whole time', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 150 / 60;
    const events = [];
    for (let time = 0; time <= 3000; time += 33) {
      const units = time >= 200 ? 0.04 * Math.sin((2 * Math.PI * hz * (time - 200)) / 1000) : 0;
      events.push(...pipeline.update(torsoOnly(time, -units * 0.4), profile).events);
    }
    expect(events.filter((event) => event.type === 'step').length).toBeGreaterThan(3);
    expect(events.some((event) => event.type === 'sprint' && event.speed01 > 0)).toBe(true);
  });

  it('does not emit jumps for running bounce but does emit a mid-run jump, torso-only', () => {
    const pipeline = new ActionPipeline();
    const profile = calibration();
    const hz = 2.8;
    // Same physics-coherent shape as the detector tests: crouch, quadratic powered rise
    // (velocity peaks at liftoff), simplified hold and landing.
    const jumpAt = (timeMs: number) => {
      const t = timeMs - 3000;
      if (t < 0) return 0;
      if (t < 250) return -0.1 * Math.sin((Math.PI * t) / 250) * 0.5 - (0.1 * t) / 500;
      if (t < 430) { const u = (t - 250) / 180; return -0.1 + 0.35 * u * u; }
      if (t < 700) return 0.25;
      if (t < 1000) return 0.25 * (1 - (t - 700) / 300);
      return 0;
    };
    const events = [];
    for (let time = 0; time <= 5000; time += 33) {
      // Quiet standing first (arms the jump detector), then bounce, then bounce+jump.
      const bouncing = time >= 1000;
      const units = (bouncing ? 0.05 * Math.sin((2 * Math.PI * hz * (time - 1000)) / 1000) : 0) + jumpAt(time);
      events.push(...pipeline.update(torsoOnly(time, -units * 0.4), profile).events);
    }
    const jumps = events.filter((event) => event.type === 'jump');
    expect(jumps).toHaveLength(1);
    expect(jumps[0]!.timestampMs).toBeGreaterThan(3000);
    // No jump is emitted during the pure-bounce portion before 3000.
    expect(events.filter((event) => event.type === 'jump' && event.timestampMs < 3000)).toHaveLength(0);
  });
});

it('keeps the effort timestamp through low confidence and collapsed shoulders until a new velocity is measured', () => {
  const pipeline = new ActionPipeline();
  // The effort channel only measures while the bounce verdict trusts the run, so every frame
  // here keeps the torso oscillating at running cadence after an initial warm-up.
  const bouncing = (time: number, options?: Parameters<typeof pose>[1]) => {
    const base = pose(time, options);
    const dy = 0.016 * Math.sin((2 * Math.PI * 2.5 * time) / 1000);
    const dx = 0.04 * Math.cos((2 * Math.PI * 2.5 * time) / 1000);
    return { ...base, landmarks: base.landmarks.map((point, index) => [0, 11, 12, 23, 24].includes(index) ? { ...point, y: point.y + dy, x: point.x + dx } : point) };
  };
  for (let time = 0; time <= 1200; time += 33) pipeline.update(bouncing(time));
  for (const time of [1233, 1266, 1299, 1332]) pipeline.update(bouncing(time));
  const dim = pipeline.update(bouncing(1365, { confidence: 0.4 }));
  expect(dim.snapshot.trackingState).toBe('tracked');
  expect(dim.effortSampleAtMs).toBe(1332);

  const collapsed = bouncing(1398);
  const landmarks = [...collapsed.landmarks];
  landmarks[12] = { ...landmarks[11]! };
  expect(pipeline.update({ ...collapsed, landmarks }).effortSampleAtMs).toBe(1332);

  const recovered = pipeline.update(bouncing(1431, { wristVertical: 0.3 }));
  expect(recovered.effortSampleAtMs).toBe(1332);
  expect(pipeline.update(bouncing(1464, { wristVertical: 0.3 })).effortSampleAtMs).toBe(1464);
});
