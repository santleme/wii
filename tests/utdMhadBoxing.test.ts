import { describe, expect, it } from 'vitest';
import { loadUtdFrames, replayClip, type ClipResult } from './utdMhadReplay';

/**
 * UTD-MHAD action 13 (front boxing): 8 subjects x 4 trials at 15 fps, frontal camera.
 * Recordings are local-only pose replays of the public clips (never committed); without them the
 * floor skips, exactly like the personal tennis/track recordings.
 */
const recordings = Object.entries(import.meta.glob<string>('./recordings/utd-mhad/a13_s*_t*.json', { query: '?raw', import: 'default', eager: true }));

function loadAll(): ClipResult[] {
  return recordings.map(([path, raw]) => {
    return { clip: path.split('/').pop()!.replace('.json', ''), ...replayClip(loadUtdFrames(raw)) };
  });
}

describe.skipIf(recordings.length === 0)('UTD-MHAD front boxing floor', () => {
  const results = loadAll();

  it('replays every clip with pose tracked in most frames', () => {
    expect(results.length).toBe(32);
    for (const result of results) expect(result.trackedShare).toBeGreaterThan(0.8);
  });

  it('keeps the detection floor: at least six subjects confirm in three of four trials', () => {
    // Pre-registered success criterion from docs/plano-boxe.md. Subject 5's reconstruction is
    // geometrically impossible (the wrist gains half a meter of depth in one frame), so the
    // floor is six subjects at 3/4 plus every other subject detecting at least once.
    const bySubject = new Map<number, ClipResult[]>();
    for (const result of results) {
      const subject = Number(result.clip.match(/_s(\d+)_/)![1]);
      bySubject.set(subject, [...(bySubject.get(subject) ?? []), result]);
    }
    expect(bySubject.size).toBe(8);
    let strong = 0;
    for (const [subject, clips] of bySubject) {
      const detected = clips.filter((clip) => clip.interiorConfirmed.length > 0).length;
      if (detected >= 3) strong += 1;
      if (subject !== 5) expect(detected, `subject ${subject}`).toBeGreaterThanOrEqual(1);
    }
    expect(strong).toBeGreaterThanOrEqual(6);
    // 24 of 32 with the production-geometry extension bar: punching toward the camera is the
    // worst case of monocular reconstruction and real full extensions measure 0.2-0.4 in the
    // raw signal (see docs/plano-boxe.md), so the old 0.65 geometric bar rejected real punches.
    expect(results.filter((result) => result.interiorConfirmed.length > 0).length).toBeGreaterThanOrEqual(24);
  });

  it('reports the confirmation-chain evidence for inspection', () => {
    const totals: Record<string, number> = {};
    for (const result of results) {
      for (const diagnostics of Object.values(result.diagnostics)) {
        for (const [key, value] of Object.entries(diagnostics)) totals[key] = (totals[key] ?? 0) + (value as number);
      }
    }
    const detected = results.filter((result) => result.interiorConfirmed.length > 0).length;
    const perSubject: Record<string, string> = {};
    for (const result of results) {
      const subject = result.clip.match(/_s(\d+)_/)![1]!;
      const entry = perSubject[subject] ?? '';
      perSubject[subject] = entry + (result.interiorConfirmed.length > 0 ? '1' : '0');
    }
    console.log(JSON.stringify({ detectedClips: detected, totalClips: results.length, perSubject, totals }, null, 1));
    expect(totals.onsets).toBeGreaterThan(0);
  });
});
