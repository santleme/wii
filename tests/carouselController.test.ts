import { describe, expect, it } from 'vitest';
import { CarouselController, type CarouselGestureSample } from '../src/ui/carouselController';

const idle: CarouselGestureSample = { phase: 'IDLE', angularVelocityDegPerSec: 0 };
const rotating = (speed: number): CarouselGestureSample => ({ phase: 'ROTATING', angularVelocityDegPerSec: speed });

function run(
  controller: CarouselController,
  frames: number,
  stepMs: number,
  gesture: CarouselGestureSample = idle,
) {
  const states = [];
  for (let index = 0; index < frames; index += 1) states.push(controller.step(stepMs, gesture));
  return states;
}

describe('carousel controller', () => {
  it('stays idle and aligned when there is no rotational input', () => {
    const controller = new CarouselController({ slotCount: 12 });
    const states = run(controller, 20, 16);
    expect(states.at(-1)).toMatchObject({ turn: 0, front: 0, mode: 'idle', controlling: false, velocityDegPerSec: 0 });
    expect(states.every((state) => !state.frontChanged)).toBe(true);
  });

  it('accelerates smoothly instead of teleporting to the target speed', () => {
    const controller = new CarouselController({ slotCount: 12, sensitivity: 1 });
    const first = controller.step(16, rotating(180));
    const second = controller.step(16, rotating(180));
    expect(first.velocityDegPerSec).toBeGreaterThan(0);
    expect(first.velocityDegPerSec).toBeLessThan(100);
    expect(second.velocityDegPerSec).toBeGreaterThan(first.velocityDegPerSec);
    expect(first.turn).toBeGreaterThan(0);
  });

  it('clamps drive speed at 360 visual degrees per second', () => {
    const controller = new CarouselController({ slotCount: 12, driveResponseMs: 1 });
    const states = run(controller, 8, 16, rotating(1000));
    expect(states.at(-1)!.velocityDegPerSec).toBeLessThanOrEqual(360);
    expect(states.at(-1)!.velocityDegPerSec).toBeGreaterThan(350);
  });

  it('uses real elapsed time rather than frame count for speed integration', () => {
    const controller = new CarouselController({ slotCount: 12, driveResponseMs: 1 });
    controller.step(16, rotating(180));
    controller.step(16, rotating(180));
    const before = controller.currentTurn;
    controller.step(32, rotating(180));
    const wideDelta = controller.currentTurn - before;

    const reference = new CarouselController({ slotCount: 12, driveResponseMs: 1 });
    reference.step(16, rotating(180));
    reference.step(16, rotating(180));
    const referenceBefore = reference.currentTurn;
    reference.step(16, rotating(180));
    reference.step(16, rotating(180));
    const narrowDelta = reference.currentTurn - referenceBefore;
    expect(wideDelta).toBeCloseTo(narrowDelta, 5);
  });

  it('keeps recovery momentum in the original direction while decaying it', () => {
    const controller = new CarouselController({ slotCount: 12, driveResponseMs: 1 });
    run(controller, 5, 16, rotating(180));
    const driven = controller.step(16, rotating(180));
    const recovery = controller.step(16, { phase: 'RECOVERY', angularVelocityDegPerSec: 0 });
    expect(recovery.velocityDegPerSec).toBeGreaterThan(0);
    expect(recovery.velocityDegPerSec).toBeLessThan(driven.velocityDegPerSec);
    expect(recovery.turn).toBeGreaterThan(driven.turn);
    expect(recovery.mode).toBe('momentum');
  });

  it('brakes much faster than passive recovery when the palm opens', () => {
    const braking = new CarouselController({ slotCount: 12, driveResponseMs: 1 });
    const recovery = new CarouselController({ slotCount: 12, driveResponseMs: 1 });
    run(braking, 6, 16, rotating(180));
    run(recovery, 6, 16, rotating(180));
    const braked = braking.step(32, { phase: 'BRAKING', angularVelocityDegPerSec: 0 });
    const coasted = recovery.step(32, { phase: 'RECOVERY', angularVelocityDegPerSec: 0 });
    expect(braked.velocityDegPerSec).toBeLessThan(coasted.velocityDegPerSec * 0.75);
    expect(braked.mode).toBe('braking');
  });

  it('does not start the open-palm snap during BRAKING before SNAP_TO_CARD arrives', () => {
    const controller = new CarouselController({ slotCount: 12, driveResponseMs: 1 });
    run(controller, 5, 16, rotating(180));
    const braked = controller.step(16, { phase: 'BRAKING', angularVelocityDegPerSec: 0 });
    expect(braked.mode).toBe('braking');
    expect(braked.mode).not.toBe('snapping');
  });

  it('snaps smoothly to Math.round(turn) within the configured 180–250 ms window', () => {
    const controller = new CarouselController({ slotCount: 12, driveResponseMs: 1, snapDurationMs: 220 });
    run(controller, 3, 16, rotating(180));
    controller.step(16, { phase: 'BRAKING', angularVelocityDegPerSec: 0 });
    const snapStart = controller.step(16, { phase: 'SNAP_TO_CARD', angularVelocityDegPerSec: 0 });
    expect(snapStart.mode).toBe('snapping');
    const target = Math.round(snapStart.turn);
    const positions = [snapStart.turn];
    let latest = snapStart;
    for (let frame = 0; frame < 20 && latest.mode === 'snapping'; frame += 1) {
      latest = controller.step(16, { phase: 'SNAP_TO_CARD', angularVelocityDegPerSec: 0 });
      positions.push(latest.turn);
    }
    expect(latest.mode).toBe('idle');
    expect(latest.turn).toBe(target);
    expect(latest.settled).toBe(true);
    expect(positions.every((position) => Math.abs(position - target) <= Math.abs(positions[0]! - target) + 1e-9)).toBe(
      true,
    );
  });

  it('snaps immediately under reduced motion and reports settlement for React synchronization', () => {
    const controller = new CarouselController({ slotCount: 12, driveResponseMs: 1, reducedMotion: true });
    run(controller, 3, 16, rotating(180));
    const state = controller.step(16, { phase: 'SNAP_TO_CARD', angularVelocityDegPerSec: 0 });
    expect(state).toMatchObject({ mode: 'idle', controlling: false, settled: true });
    expect(state.turn).toBe(Math.round(state.turn));
  });

  it('settles passively after cancellation or camera loss instead of leaving the wheel between cards', () => {
    const controller = new CarouselController({ slotCount: 12, driveResponseMs: 1, recoveryDecayMs: 30 });
    run(controller, 2, 16, rotating(80));
    let latest = controller.step(16, { phase: 'CANCELLED', angularVelocityDegPerSec: 0 });
    for (let frame = 0; frame < 30 && latest.mode !== 'snapping'; frame += 1) {
      latest = controller.step(16, idle);
    }
    expect(latest.mode).toBe('snapping');
    for (let frame = 0; frame < 20 && latest.mode === 'snapping'; frame += 1) latest = controller.step(16, idle);
    expect(latest.mode).toBe('idle');
    expect(latest.turn).toBe(Math.round(latest.turn));
  });

  it('wraps the integer front channel in both positive and negative directions', () => {
    const controller = new CarouselController({ slotCount: 12, driveResponseMs: 1 });
    let latest = controller.step(100, rotating(360));
    for (let frame = 0; frame < 20 && latest.front === 0; frame += 1) latest = controller.step(16, rotating(360));
    expect(latest.front).toBeGreaterThan(0);

    controller.syncTurn(0);
    latest = controller.step(100, rotating(-360));
    for (let frame = 0; frame < 20 && latest.front === 0; frame += 1) latest = controller.step(16, rotating(-360));
    expect(latest.front).toBe(11);
  });

  it('reverses carousel direction when sensitivity is intentionally negative', () => {
    const controller = new CarouselController({ slotCount: 12, sensitivity: -1, driveResponseMs: 1 });
    const state = controller.step(32, rotating(180));
    expect(state.velocityDegPerSec).toBeLessThan(0);
    expect(state.turn).toBeLessThan(0);
  });

  it('external mouse synchronization cancels momentum and snap ownership', () => {
    const controller = new CarouselController({ slotCount: 12, driveResponseMs: 1 });
    run(controller, 5, 16, rotating(180));
    controller.syncTurn(4);
    const state = controller.step(16, idle);
    expect(state).toMatchObject({ turn: 4, front: 4, mode: 'idle', controlling: false, velocityDegPerSec: 0 });
  });

  it('reports front changes only when the rounded integer channel changes', () => {
    const controller = new CarouselController({ slotCount: 12, driveResponseMs: 1 });
    const small = controller.step(16, rotating(30));
    expect(small.frontChanged).toBe(false);
    let latest = small;
    for (let frame = 0; frame < 30 && !latest.frontChanged; frame += 1) latest = controller.step(16, rotating(180));
    expect(latest.frontChanged).toBe(true);
    expect(latest.front).toBe(1);
  });

  it('rejects malformed timing and velocity input instead of propagating NaN', () => {
    const controller = new CarouselController({ slotCount: 12 });
    expect(() => controller.step(Number.NaN, idle)).toThrow(RangeError);
    expect(() => controller.step(16, { phase: 'IDLE', angularVelocityDegPerSec: Number.NaN })).toThrow(RangeError);
  });

  it('removes prolonged recovery inertia under prefers-reduced-motion', () => {
    const controller = new CarouselController({ slotCount: 12, reducedMotion: true });
    run(controller, 10, 16, rotating(240));
    const recovery = controller.step(16, { phase: 'RECOVERY', angularVelocityDegPerSec: 0 });
    expect(recovery.turn).toBe(Math.round(recovery.turn));
    expect(recovery.mode).not.toBe('momentum');
  });
});
