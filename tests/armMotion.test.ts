import { parsePoseRecording } from '@wii/spatial-core';
import { describe, expect, it } from 'vitest';
import { ArmMotionDetector } from '../src/kinematics/armMotion';
import { pose } from './fixtures/syntheticPose';

describe('arm motion', () => {
  it('sees a slow upward movement that is no stroke, and stays quiet for a resting arm', () => {
    const moving = new ArmMotionDetector('right');
    const resting = new ArmMotionDetector('right');
    const seen = Array.from({ length: 14 }, (_, i) => moving.update(pose(i * 33, { wristVertical: i * 0.04 })));
    expect(seen.some(Boolean)).toBe(true);
    expect(Array.from({ length: 30 }, (_, i) => resting.update(pose(i * 33, { wristLateral: i % 2 ? 0.005 : 0 }))).some(Boolean)).toBe(false);
  });
});

const novice = Object.values(import.meta.glob<string>('./recordings/tenis-CPU-1795795114940.json', { query: '?raw', import: 'default', eager: true }))[0];

describe.skipIf(!novice)('first-time player recording', () => {
  it('sees many of the attempts the stroke detector reads only once', () => {
    const { frames } = parsePoseRecording(novice!);
    const detector = new ArmMotionDetector('right');
    const start = frames[0]!.snapshot.timestampMs;
    const events: number[] = [];
    for (const { snapshot } of frames) {
      const at = (snapshot.timestampMs - start) / 1000;
      if (detector.update(snapshot) && (events.length === 0 || at - events.at(-1)! > 0.9)) events.push(at);
    }
    expect(events.filter((at) => at >= 5 && at < 29).length).toBeGreaterThanOrEqual(10);
    expect(events.filter((at) => at >= 1 && at < 5).length).toBeLessThanOrEqual(1);
  });
});
