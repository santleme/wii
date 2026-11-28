import { describe, expect, it } from 'vitest';
import { formatTime, parseRecords, recordTime } from '../src/games/athletics/race';
import { QualityGovernor } from '../src/games/core/qualityGovernor';

describe('race clock', () => {
  it('formats minutes, seconds and tenths', () => {
    expect(formatTime(0)).toBe('0:00.0');
    expect(formatTime(65.47)).toBe('1:05.4');
  });
});

describe('personal records', () => {
  it('keeps the best time per distance', () => {
    const first = recordTime({}, 100, 14);
    expect(first).toMatchObject({ best: 14, isNew: true });
    expect(recordTime(first.records, 100, 15)).toMatchObject({ best: 14, isNew: false });
    const faster = recordTime(first.records, 100, 13);
    expect(faster).toMatchObject({ best: 13, isNew: true });
    expect(recordTime(faster.records, 400, 60).records).toEqual({ '100': 13, '400': 60 });
  });

  it('ignores missing or corrupted storage', () => {
    expect(parseRecords(null)).toEqual({});
    expect(parseRecords('not json')).toEqual({});
    expect(parseRecords('null')).toEqual({});
    expect(parseRecords('{"100":"x","400":-1,"800":120}')).toEqual({ '800': 120 });
  });
});

describe('QualityGovernor', () => {
  const run = (governor: QualityGovernor, frameMs: number, totalMs: number) => {
    let changes = 0;
    for (let t = 0; t < totalMs; t += frameMs) if (governor.sample(frameMs)) changes += 1;
    return changes;
  };

  it('drops one tier per cooldown under sustained slow frames', () => {
    const governor = new QualityGovernor();
    expect(run(governor, 33, 7000)).toBe(1);
    expect(governor.tier).toBe(1);
    run(governor, 33, 20000);
    expect(governor.tier).toBe(2);
  });

  it('ignores spikes and recovers once frames are fast again', () => {
    const governor = new QualityGovernor();
    expect(run(governor, 300, 60000)).toBe(0);
    run(governor, 33, 7000);
    run(governor, 16.7, 14000);
    expect(governor.tier).toBe(0);
  });

  it('holds the tier inside the hysteresis band', () => {
    const governor = new QualityGovernor();
    run(governor, 33, 7000);
    expect(run(governor, 20, 30000)).toBeLessThanOrEqual(1);
  });
});
