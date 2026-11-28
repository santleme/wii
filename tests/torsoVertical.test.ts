import { describe, expect, it } from 'vitest';
import { TorsoVerticalChannel } from '../src/kinematics/torsoVertical';
import { pose } from './fixtures/syntheticPose';

const withShoulderX = (time: number, left: number, right: number) => {
  const base = pose(time);
  return { ...base, landmarks: base.landmarks.map((point, index) => (index === 11 ? { ...point, x: left } : index === 12 ? { ...point, x: right } : point)) };
};

describe('TorsoVerticalChannel', () => {
  it('gives no sample without a confident shoulder line, and one as soon as it is back', () => {
    const channel = new TorsoVerticalChannel();
    expect(channel.update(pose(0, { hiddenLandmarks: [11] }))).toBeUndefined();
    expect(channel.update({ ...pose(33), landmarks: [] })).toBeUndefined();
    expect(channel.update(pose(66))).toBeDefined();
  });

  it('needs no hips', () => {
    expect(new TorsoVerticalChannel().update(pose(0, { hiddenLandmarks: [23, 24, 25, 26, 27, 28] }))).toBeDefined();
  });

  it('drops a frame where one shoulder snaps onto the other, then believes a width that stays', () => {
    const channel = new TorsoVerticalChannel();
    for (let time = 0; time <= 1000; time += 33) channel.update(pose(time));
    expect(channel.update(withShoulderX(1033, 0.5, 0.505))).toBeUndefined();
    expect(channel.update(pose(1066))).toBeDefined();
    let last: ReturnType<TorsoVerticalChannel["update"]>;
    for (let time = 1100; time <= 1700; time += 33) last = channel.update(withShoulderX(time, 0.48, 0.52));
    expect(last).toBeDefined();
  });

  it('reads the head and wrists in the same units as the shoulders', () => {
    const sample = new TorsoVerticalChannel().update(pose(0))!;
    expect(sample.shoulders.head).toBeLessThan(sample.shoulders.left);
    expect(Number.isFinite(sample.shoulders.leftWrist)).toBe(true);
  });
});
