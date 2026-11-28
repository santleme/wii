import { describe, expect, it } from 'vitest';
import { loadUtdFrames, replayClip } from './utdMhadReplay';

const recordings = Object.entries(import.meta.glob<string>('./recordings/utd-mhad/{a1,a3,a4,a16,a22,a23,a27}_s*_t*.json', { query: '?raw', import: 'default', eager: true }));

describe.skipIf(recordings.length === 0)('UTD-MHAD negative control floor', () => {
  it('reports punch events per non-boxing action', () => {
    const perAction: Record<string, { clips: number; withPunch: number; punches: number; starts: number }> = {};
    for (const [path, raw] of recordings) {
      const clip = path.split('/').pop()!.replace('.json', '');
      const action = clip.match(/^(a\d+)/)![1]!;
      const result = replayClip(loadUtdFrames(raw));
      const entry = perAction[action] ?? { clips: 0, withPunch: 0, punches: 0, starts: 0 };
      entry.clips += 1;
      entry.punches += result.confirmed.length;
      entry.starts += result.starts;
      if (result.confirmed.length > 0) entry.withPunch += 1;
      perAction[action] = entry;
    }
    console.log('NEGATIVES', JSON.stringify(perAction, null, 1));
    // Non-boxing arm actions must not read as punches. a27 (jumping jacks) produced one clip
    // with two readings in the reference evaluation; everything else must stay at zero.
    const totalPunches = Object.values(perAction).reduce((sum, action) => sum + action.punches, 0);
    const clipsWithPunch = Object.values(perAction).reduce((sum, action) => sum + action.withPunch, 0);
    expect(clipsWithPunch).toBeLessThanOrEqual(1);
    expect(totalPunches).toBeLessThanOrEqual(2);
    for (const [action, entry] of Object.entries(perAction)) {
      if (action !== 'a27') expect(entry.punches, action).toBe(0);
    }
  });
});
