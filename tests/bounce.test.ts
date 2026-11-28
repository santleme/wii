import { describe, expect, it } from 'vitest';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { calibration, pose, poseWithHipBounce } from './fixtures/syntheticPose';

const maxSpeed = (frame: (time: number) => ReturnType<typeof pose>) => {
  const pipeline = new ActionPipeline();
  let max = 0;
  for (let time = 0; time <= 8000; time += 33) max = Math.max(max, pipeline.update(frame(time), calibration()).controls.sprintSpeed01);
  return max;
};

describe('running is judged by the size of the shoulder bounce', () => {
  it('ignores alternating arms with the knees out of the picture', () => {
    expect(maxSpeed((time) => {
      const wave = 0.05 * Math.sin((2 * Math.PI * 1.5 * time) / 1000);
      const base = pose(time);
      return { ...base, landmarks: base.landmarks.map((point, index) => {
        if (index >= 25) return { ...point, visibility: 0.1 };
        if (index === 13 || index === 15) return { ...point, y: point.y + wave };
        return index === 14 || index === 16 ? { ...point, y: point.y - wave } : point;
      }) };
    })).toBe(0);
  });

  it.each([[0.3, false], [1, true]])('with the head moving %f times the shoulders, running is %s', (headRatio, runs) => {
    // Hard arm swinging shrugs both shoulders in phase; only the head tells it apart from a run.
    const speed = maxSpeed((time) => {
      const offset = 0.016 * Math.sin((2 * Math.PI * 2.5 * time) / 1000);
      const base = pose(time);
      return { ...base, landmarks: base.landmarks.map((point, index) => {
        if (index === 11 || index === 12) return { ...point, y: point.y + offset };
        return index === 0 ? { ...point, y: point.y + offset * headRatio } : point;
      }) };
    });
    expect(speed > 0).toBe(runs);
  });

  it('does not read one jump, the size real recordings show, as running', () => {
    expect(maxSpeed((time) => poseWithHipBounce(time, time > 3000 && time < 3600 ? -0.18 * Math.sin((Math.PI * (time - 3000)) / 600) : 0))).toBe(0);
  });
});
