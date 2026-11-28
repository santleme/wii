import { describe, expect, it } from 'vitest';
import { LOST_AFTER_MS, TrackingGate } from '../src/kinematics/trackingGate';
import { pose } from './fixtures/syntheticPose';

const good = (timeMs: number) => pose(timeMs);
const bad = (timeMs: number) => pose(timeMs, { confidence: 0.1 });

describe('TrackingGate', () => {
  it('confirms tracked after three consecutive good frames', () => {
    const gate = new TrackingGate();
    expect(gate.evaluate(good(0)).state).toBe('degraded');
    expect(gate.evaluate(good(33)).state).toBe('degraded');
    expect(gate.evaluate(good(66)).state).toBe('tracked');
  });

  it('starts lost and stays lost when no good frame ever arrives', () => {
    const gate = new TrackingGate();
    expect(gate.evaluate(bad(0)).state).toBe('lost');
    expect(gate.evaluate(bad(33)).state).toBe('lost');
  });

  it('rides out a blur burst shorter than the blackout window', () => {
    const gate = new TrackingGate();
    [0, 33, 66].forEach((time) => { gate.evaluate(good(time)); });
    // ~250 ms of bad frames — a fast jump or motion-blur burst. The gate must not give up.
    for (let time = 100; time <= 350; time += 33) {
      expect(gate.evaluate(bad(time)).state).toBe('degraded');
    }
  });

  it('goes lost only after a sustained blackout measured on timestamps, not frames', () => {
    const gate = new TrackingGate();
    [0, 33, 66].forEach((time) => { gate.evaluate(good(time)); });
    const lastGood = 66;
    expect(gate.evaluate(bad(lastGood + LOST_AFTER_MS - 1)).state).toBe('degraded');
    expect(gate.evaluate(bad(lastGood + LOST_AFTER_MS)).state).toBe('lost');
  });

  it('grants the same grace at 15 fps as at 30 fps', () => {
    const gate = new TrackingGate();
    [0, 66, 133].forEach((time) => { gate.evaluate(good(time)); });
    // 15 fps: only 5 bad frames fit in 400 ms — a frame-count gate would already be lost.
    for (let time = 200; time <= 600; time += 66) {
      expect(gate.evaluate(bad(time)).state).toBe('degraded');
    }
    expect(gate.evaluate(bad(133 + LOST_AFTER_MS)).state).toBe('lost');
  });

  it('restarts the blackout window on a single good frame', () => {
    const gate = new TrackingGate();
    [0, 33, 66].forEach((time) => { gate.evaluate(good(time)); });
    for (let time = 100; time <= 700; time += 33) gate.evaluate(bad(time));
    // One good frame 700 ms in — marginal light, but the body is clearly still there.
    gate.evaluate(good(733));
    expect(gate.evaluate(bad(766)).state).toBe('degraded');
    // The window restarts from that good frame, so even 800 ms of further bad frames
    // measured from the original blackout is still degraded.
    expect(gate.evaluate(bad(900)).state).toBe('degraded');
    expect(gate.evaluate(bad(733 + LOST_AFTER_MS)).state).toBe('lost');
  });

  it('accepts confidence at the 0.5 floor and rejects below it', () => {
    const accepted = new TrackingGate();
    [0, 33, 66].forEach((time) => { accepted.evaluate(pose(time, { confidence: 0.5 })); });
    expect(accepted.evaluate(pose(99, { confidence: 0.5 })).state).toBe('tracked');
    const rejected = new TrackingGate();
    [0, 33, 66, 99].forEach((time) => { rejected.evaluate(pose(time, { confidence: 0.49 })); });
    expect(rejected.evaluate(pose(132, { confidence: 0.49 })).state).not.toBe('tracked');
  });

  it('recovers to tracked after three good frames following a blackout', () => {
    const gate = new TrackingGate();
    [0, 33, 66].forEach((time) => { gate.evaluate(good(time)); });
    gate.evaluate(bad(66 + LOST_AFTER_MS));
    expect(gate.evaluate(good(1000)).state).toBe('degraded');
    expect(gate.evaluate(good(1033)).state).toBe('degraded');
    expect(gate.evaluate(good(1066)).state).toBe('tracked');
  });

  it('maintains tracked state through motion-blur dips above the 0.35 stay floor (dual-threshold hysteresis)', () => {
    const gate = new TrackingGate();
    [0, 33, 66].forEach((time) => { gate.evaluate(pose(time, { confidence: 0.55 })); });
    expect(gate.evaluate(pose(99, { confidence: 0.42 })).state).toBe('tracked');
    expect(gate.evaluate(pose(132, { confidence: 0.36 })).state).toBe('tracked');
    expect(gate.evaluate(pose(165, { confidence: 0.34 })).state).toBe('degraded');
  });

  it('resets to the initial state', () => {
    const gate = new TrackingGate();
    [0, 33, 66].forEach((time) => { gate.evaluate(good(time)); });
    gate.reset();
    expect(gate.evaluate(bad(100)).state).toBe('lost');
  });
});
