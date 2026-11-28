import { describe, expect, it } from 'vitest';
import { SwingDetector, type SwingOutput } from '../src/kinematics/swingDetector';
import { pose } from './fixtures/syntheticPose';

type Key = 'wristLateral' | 'leftWristLateral';

/** Wrist positions (world units, 0.4 = one shoulder width) at 33 ms per frame. */
function run(positions: number[], key: Key = 'wristLateral', detector = new SwingDetector(key === 'wristLateral' ? 'right' : 'left')) {
  return positions.map((value, frame) => detector.update(pose(frame * 33, { [key]: value })));
}

const strokes = (outputs: (SwingOutput | undefined)[]) => outputs.flatMap((output) => (output?.kind === 'confirmed' ? [output] : []));
const ramp = (from: number, to: number, frames: number) => Array.from({ length: frames }, (_, i) => from + ((to - from) * (i + 1)) / frames);
const rest = (value: number) => Array<number>(8).fill(value);
// Several shoulder widths in 165 ms.
const fast = (from: number, to: number) => [...rest(from), ...ramp(from, to, 5), ...rest(to)];

describe('swing detector', () => {
  it('announces the onset before confirming one stroke', () => {
    const outputs = run(fast(0.5, -0.5));
    expect(outputs.findIndex((o) => o?.kind === 'onset')).toBeLessThan(outputs.findIndex((o) => o?.kind === 'confirmed'));
    expect(outputs.filter((o) => o?.kind === 'onset')).toHaveLength(1);
    expect(strokes(outputs)).toHaveLength(1);
  });

  it('names the side by hand and direction', () => {
    expect(strokes(run(fast(0.5, -0.5)))).toMatchObject([{ side: 'forehand' }]);
    expect(strokes(run(fast(-0.5, 0.5)))).toMatchObject([{ side: 'backhand' }]);
    expect(strokes(run(fast(0.5, -0.5), 'leftWristLateral'))).toMatchObject([{ side: 'backhand' }]);
    expect(strokes(run(fast(-0.5, 0.5), 'leftWristLateral'))).toMatchObject([{ side: 'forehand' }]);
  });

  it('ignores the arm coming back, even quickly', () => {
    expect(strokes(run([...rest(0.5), ...ramp(0.5, -0.5, 5), ...ramp(-0.5, 0.5, 6), ...rest(0.5)]))).toHaveLength(1);
  });

  it('reads two strokes with a slow return between them', () => {
    const outputs = run([...rest(0.5), ...ramp(0.5, -0.5, 5), ...ramp(-0.5, 0.5, 70), ...ramp(0.5, -0.5, 5), ...rest(-0.5)]);
    expect(strokes(outputs).map((s) => s.side)).toEqual(['forehand', 'forehand']);
  });

  it('stays quiet for slow preparation, short flicks and vertical motion', () => {
    expect(strokes(run([...rest(0.5), ...ramp(0.5, -0.5, 90)]))).toHaveLength(0);
    expect(strokes(run([...rest(0.08), ...ramp(0.08, -0.08, 3), ...rest(-0.08)]))).toHaveLength(0);
    const detector = new SwingDetector('right');
    const vertical = Array.from({ length: 12 }, (_, i) => detector.update(pose(i * 33, { wristVertical: i % 2 })));
    expect(vertical.filter(Boolean)).toHaveLength(0);
  });

  it('counts a compact stroke that rises, but not the same sideways distance alone or falling', () => {
    // 1.5 shoulder widths sideways; the rise adds 1.5 more.
    const stroke = (rise: number) => {
      const detector = new SwingDetector('right');
      return strokes(Array.from({ length: 20 }, (_, i) => {
        const t = Math.min(1, Math.max(0, (i - 7) / 6));
        return detector.update(pose(i * 33, { wristLateral: 0.1 - 0.21 * t, wristVertical: rise * t }));
      })).length;
    };
    expect(stroke(0.6)).toBe(1);
    expect(stroke(0)).toBe(0);
    expect(stroke(-0.6)).toBe(0);
  });

  it('keeps a stroke through one blurred frame in the middle of it', () => {
    const detector = new SwingDetector('right');
    const outputs = fast(0.5, -0.5).map((value, frame) => detector.update(pose(frame * 33, { wristLateral: value, hiddenLandmarks: frame === 10 ? [16] : [] })));
    expect(strokes(outputs)).toMatchObject([{ side: 'forehand' }]);
  });

  it('does not read a jump across a tracking hole as a stroke', () => {
    const detector = new SwingDetector('right');
    detector.update(pose(0, { wristLateral: 0.5 }));
    expect(detector.update(pose(3000, { wristLateral: -0.5 }))).toBeUndefined();
    for (let time = 3033; time <= 3400; time += 33) expect(detector.update(pose(time, { wristLateral: -0.5, hiddenLandmarks: [16] }))).toBeUndefined();
    expect(detector.update(pose(3433, { wristLateral: 0.5 }))).toBeUndefined();
  });

  it('reports contact height and vertical speed of a rising stroke', () => {
    const detector = new SwingDetector('right');
    const outputs = Array.from({ length: 16 }, (_, i) => {
      const t = Math.min(1, Math.max(0, (i - 7) / 5));
      return detector.update(pose(i * 33, { wristLateral: 0.5 - t, wristVertical: 0.3 * t }));
    });
    const [stroke] = strokes(outputs);
    expect(stroke!.verticalSpeed).toBeGreaterThan(0);
    expect(stroke!.onsetTimestampMs).toBeLessThanOrEqual(stroke!.peakTimestampMs);
  });
});
