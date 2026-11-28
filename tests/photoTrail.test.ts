import { parsePoseRecording } from '@wii/spatial-core';
import { describe, expect, it } from 'vitest';
import { PhotoTrail } from '../src/cv/diagnostics/photoTrail';
import { PoseRecorder } from '../src/cv/diagnostics/poseRecorder';
import { pose } from './fixtures/syntheticPose';

describe('photo trail of a mistake clip', () => {
  it('keeps only the last twenty seconds', () => {
    const trail = new PhotoTrail();
    for (let time = 0; time <= 50_000; time += 1000) trail.keep({ timestampMs: time, jpeg: 'x' });
    expect(trail.all[0]!.timestampMs).toBe(30_000);
  });

  it('travels inside the recording without breaking how it is read back', () => {
    const photos = [{ timestampMs: 0, jpeg: 'data:image/jpeg;base64,xx' }];
    const text = new PoseRecorder([pose(0), pose(33)]).serialize('CPU', 'a'.repeat(64), photos);
    expect(JSON.parse(text).photos).toEqual(photos);
    expect(parsePoseRecording(text).frameCount).toBe(2);
  });
});
