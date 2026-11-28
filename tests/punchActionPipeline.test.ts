import { describe, expect, it } from 'vitest';
import type { PoseSnapshot, SportActionEvent } from '../src/cv/protocol';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { calibration, pose } from './fixtures/syntheticPose';

/** Right arm blended from guard (0) to a straight punch toward the camera (1). */
function rightArm(time: number, extension: number, hiddenLandmarks: readonly number[] = [], chinGuard = false): PoseSnapshot {
  const snapshot = pose(time, { hiddenLandmarks });
  const world = [...snapshot.worldLandmarks];
  const shoulder = world[12]!;
  const place = (index: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const visible = hiddenLandmarks.includes(index) ? 0 : 0.95;
    world[index] = {
      x: shoulder.x + x0 + (x1 - x0) * extension,
      y: shoulder.y + y0 + (y1 - y0) * extension,
      z: z0 + (z1 - z0) * extension,
      visibility: visible,
      presence: visible,
    };
  };
  // Extension 0 is a real blocking guard: fist up at cheek level near the chin, slightly
  // inward of the shoulder line, elbow dropped by the ribs. Extension 1 is a straight
  // punch traveling horizontally at face height, elbow just below the fist line.
  if (chinGuard) {
    place(14, 0.02, -0.1, -0.02, 0, 0.05, -0.3);
    place(16, 0.14, 0.32, -0.12, 0, 0.02, -0.58);
  } else {
    place(14, 0, 0.28, -0.05, 0, 0.02, -0.3);
    place(16, 0, 0, -0.18, 0, 0.02, -0.58);
  }
  return { ...snapshot, worldLandmarks: world };
}

/** 300 ms in guard, a 150 ms extension, then held. */
function jab(pipeline: ActionPipeline, profile = calibration(), hidden: readonly number[] = []): SportActionEvent[] {
  const events: SportActionEvent[] = [];
  for (let time = 0; time <= 900; time += 33) {
    const extension = Math.min(1, Math.max(0, (time - 300) / 150));
    events.push(...pipeline.update(rightArm(time, extension, hidden), profile).events);
  }
  return events.filter((event) => event.type === 'punch-start' || event.type === 'punch');
}

describe('punch wiring in ActionPipeline', () => {
  it('emits the onset before the confirmed punch, once each, for the punching hand', () => {
    const events = jab(new ActionPipeline());
    expect(events.map((event) => event.type)).toEqual(['punch-start', 'punch']);
    const [start, punch] = events;
    if (punch?.type !== 'punch') throw new Error('missing punch');
    expect(start).toMatchObject({ hand: 'right', source: 'cv', trackingState: 'tracked' });
    expect(punch.hand).toBe('right');
    expect(punch.onsetTimestampMs).toBe(start!.timestampMs);
    expect(punch.id).toBeGreaterThan(start!.id);
  });

  it('attaches trajectory measurement and geometry classification to confirmed punches', () => {
    const punch = jab(new ActionPipeline()).find((event) => event.type === 'punch');
    if (punch?.type !== 'punch') throw new Error('missing punch');
    expect(punch.punchKind).toBe('straight');
    expect(punch.punchTargetZone).toBe('head');
    expect(punch.measurement?.samples.length).toBeGreaterThanOrEqual(2);
    expect(punch.measurement?.forwardTravel).toBeGreaterThan(0.2);
  });

  it('stays silent until the calibration scale has converged', () => {
    const profile = { ...calibration(), readiness: { scale01: 0.2, neutral01: 1 } };
    expect(jab(new ActionPipeline(), profile)).toEqual([]);
  });

  it('stays silent when the punching elbow is not visible', () => {
    expect(jab(new ActionPipeline(), calibration(), [14])).toEqual([]);
  });

  it('forgets the previous session on reset', () => {
    const pipeline = new ActionPipeline();
    jab(pipeline);
    pipeline.reset(933);
    expect(jab(pipeline).map((event) => event.type)).toEqual(['punch-start', 'punch']);
  });

  it('restates the guard every frame, only once calibration can scale it', () => {
    const guardAt = (extension: number, scale01: number) => {
      const pipeline = new ActionPipeline();
      const profile = { ...calibration(), readiness: { scale01, neutral01: 1 } };
      // Both arms mirror the right one, so the left fist is in place too.
      const both = (time: number) => {
        const snapshot = rightArm(time, extension, [], true);
        const world = [...snapshot.worldLandmarks];
        for (const [from, to] of [[14, 13], [16, 15]] as const) {
          // Mirror across the midline: keep the inward/outward offset from the shoulder line.
          world[to] = { ...world[from]!, x: world[11]!.x - (world[from]!.x - world[12]!.x) };
        }
        return { ...snapshot, worldLandmarks: world };
      };
      let guard: boolean | undefined;
      for (let time = 0; time <= 200; time += 33) guard = pipeline.update(both(time), profile).controls.guard;
      return guard;
    };
    expect(guardAt(0, 1)).toBe(true);
    expect(guardAt(1, 1)).toBe(false);
    expect(guardAt(0, 0.2)).toBeUndefined();
  });
});
