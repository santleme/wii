import { parsePoseRecording } from '@wii/spatial-core';
import { describe, expect, it } from 'vitest';
import { AdaptiveCalibrator } from '../src/cv/adaptiveCalibrator';
import type { CalibrationProfile, PoseSnapshot, PunchKind, PunchTargetZone } from '../src/cv/protocol';
import { BOXING_RECORDING_SCRIPT, segmentAt } from '../src/cv/diagnostics/recordingScript';
import { ActionPipeline } from '../src/kinematics/actionPipeline';

interface SegmentReport {
  kind: string;
  index: number;
  punches: { kind: PunchKind; target: PunchTargetZone; hand: string; delayMs: number }[];
  slips: number;
  duckFrames: number;
  frames: number;
}

function replay(frames: readonly PoseSnapshot[]): SegmentReport[] {
  const pipeline = new ActionPipeline();
  const calibrator = new AdaptiveCalibrator();
  let profile: CalibrationProfile | undefined;
  const start = frames[0]?.timestampMs ?? 0;
  const reports = new Map<number, SegmentReport>();
  const reportAt = (elapsedMs: number) => {
    const at = segmentAt(elapsedMs, BOXING_RECORDING_SCRIPT);
    if (!at) return undefined;
    const existing = reports.get(at.index);
    if (existing) return existing;
    const created: SegmentReport = { kind: at.segment.kind, index: at.index, punches: [], slips: 0, duckFrames: 0, frames: 0 };
    reports.set(at.index, created);
    return created;
  };
  for (const snapshot of frames) {
    profile = calibrator.update(snapshot, pipeline.dodgeZone) ?? profile;
    const output = pipeline.update(snapshot, profile);
    const elapsed = snapshot.timestampMs - start;
    reportAt(elapsed)!.frames += 1;
    if (output.controls.duck === true) reportAt(elapsed)!.duckFrames += 1;
    if (output.controls.dodgeZone !== undefined && output.controls.dodgeZone !== 0) reportAt(elapsed)!.slips += 1;
    for (const event of output.events) {
      if (event.type !== 'punch') continue;
      const at = reportAt((event.peakTimestampMs ?? event.timestampMs) - start);
      at?.punches.push({
        kind: event.punchKind ?? 'unknown',
        target: event.punchTargetZone ?? 'unknown',
        hand: event.hand,
        delayMs: event.timestampMs - (event.peakTimestampMs ?? event.timestampMs),
      });
    }
  }
  return [...reports.values()].filter((report) => report.frames > 0);
}

it('reports nothing but empty segments for a neutral pose', () => {
  const rows = replay([]);
  expect(rows).toEqual([]);
});

const recordings = Object.entries(import.meta.glob<string>([
  './recordings/boxe-*.json',
  './recordings/errors/boxe-erro-*.json',
], { query: '?raw', import: 'default', eager: true }));

describe.skipIf(recordings.length === 0)('scoreboard for real boxing recordings', () => {
  for (const [path, raw] of recordings) {
    it(path, () => {
      const rows = replay(parsePoseRecording(JSON.parse(raw)).frames.map((frame) => frame.snapshot));
      // Floor calibrated once the first guided recording exists: each punch segment should
      // confirm its punch with the requested type, and the negative controls must stay clean.
      const punchSegments = rows.filter((row) => ['jab', 'cross', 'hook', 'uppercut', 'bodyshot'].includes(row.kind));
      const negatives = rows.filter((row) => row.kind === 'prepare' || row.kind === 'occlusion');
      console.log(JSON.stringify(rows.map(({ kind, punches, slips, duckFrames, frames }) => ({ kind, punches, slips, duckFrames, frames })), null, 1));
      expect(punchSegments.length).toBeGreaterThan(0);
      for (const negative of negatives) expect(negative.punches, negative.kind).toEqual([]);
      // Hard floors from the first real recording (11 fps, CPU delegate):
      // - stillness never punches; guard-holding admits at most the one documented marginal
      //   phantom (travel exactly at threshold, fist physically leaving the face — discriminating
      //   it is item 4 of docs/plano-boxe.md, punch precision during defense)
      for (const quiet of rows.filter((row) => row.kind === 'still')) {
        expect(quiet.punches, quiet.kind).toEqual([]);
      }
      for (const guard of rows.filter((row) => row.kind === 'guard')) {
        expect(guard.punches.length, guard.kind).toBeLessThanOrEqual(1);
      }
      // - some jab window confirms a straight to the head, the classification anchor (the first
      //   window is warm-up and classifies loosely; later windows carry the validated anchor)
      const jabs = rows.filter((row) => row.kind === 'jab');
      expect(jabs.some((row) => row.punches.some((punch) => punch.kind === 'straight' && punch.target === 'head'))).toBe(true);
      // - ducking must not manufacture uppercuts: the shoulder-drop veto covers most of it;
      //   one residue per recording is the documented onset-race ceiling (docs/plano-boxe.md)
      const duckPunches = rows.filter((row) => row.kind === 'duck').flatMap((row) => row.punches);
      expect(duckPunches.length).toBeLessThanOrEqual(1);
      // - punches do confirm across the punching windows at camera-realistic rates
      expect(punchSegments.flatMap((row) => row.punches).length).toBeGreaterThanOrEqual(4);
      // - ducking exists: each duck window detects the deep duck inside it (the windows also
      //   hold weaves and standing, so a handful of frames is the honest positive), and no other
      //   segment ever reads as ducked — the validated zero-false-positive contract
      for (const duckRow of rows.filter((row) => row.kind === 'duck')) {
        expect(duckRow.duckFrames, 'duck segment').toBeGreaterThanOrEqual(2);
      }
      for (const other of rows.filter((row) => row.kind !== 'duck')) {
        expect(other.duckFrames, `${other.kind} duck-free`).toBe(0);
      }
      // - slipping exists and is not noise: genuine slip windows detect strongly, while punch
      //   windows stay bounded — residual frames there are genuine body displacement in the
      //   fighting rhythm, the documented cost of a position-channel dodge (docs/plano-boxe.md)
      const slipTotal = rows.filter((row) => row.kind === 'slip').reduce((sum, row) => sum + row.slips, 0);
      expect(slipTotal, 'slip recall').toBeGreaterThanOrEqual(30);
      for (const punchRow of rows.filter((row) => ['jab', 'hook', 'uppercut'].includes(row.kind))) {
        expect(punchRow.slips, `${punchRow.kind} slip noise`).toBeLessThanOrEqual(15);
      }
      for (const quietRow of rows.filter((row) => row.kind === 'still' || row.kind === 'guard')) {
        expect(quietRow.slips, `${quietRow.kind} slip noise`).toBeLessThanOrEqual(11);
      }
    });
  }
});
