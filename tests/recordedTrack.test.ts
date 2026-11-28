import { parsePoseRecording } from '@wii/spatial-core';
import { describe, expect, it } from 'vitest';
import { segmentAt, TRACK_RECORDING_SCRIPT } from '../src/cv/diagnostics/recordingScript';
import { PoseRecorder, rememberFrame } from '../src/cv/diagnostics/poseRecorder';
import { AdaptiveCalibrator } from '../src/cv/adaptiveCalibrator';
import type { CalibrationProfile } from '../src/cv/protocol';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { replayTrack, summarize } from './fixtures/replayTrack';
import { pose } from './fixtures/syntheticPose';

const SCRIPT_MS = TRACK_RECORDING_SCRIPT.reduce((total, segment) => total + segment.seconds * 1000, 0);
// Local, gitignored recordings: the scoreboard prints only when there is something to measure.
// The one `corrida-GPU-…` scores low on running (26%) because of framing, not thresholds: the nose was
// above the picture in 189 of its 297 running frames and the tracker lost the body (37 empty, 54 upside down).
const recordings = import.meta.glob('./recordings/{corrida,erro}-*.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/**
 * Floors per recording, a little under what the detector scored when they were set: percent of frames
 * with the runner moving where it should (run, runJump) and where it should not. Raise them when the
 * detector improves; lowering one is accepting a regression. The recordings are personal and local, so
 * these only guard on a machine that has them.
 */
/**
 * E saves the last 20 seconds whatever the player was doing, so the `erro-` prefix says nothing about
 * the movement. Only clips someone has checked as arm movement with no running are listed here.
 */
const ARMS_ONLY_CLIPS = ['erro-CPU-1795803374564'];
const armsOnlyClips = Object.entries(recordings).filter(([path]) => ARMS_ONLY_CLIPS.some((clip) => path.endsWith(`/${clip}.json`)));
/**
 * Clips someone has checked as real running attempts, however flat the jog: the bar must fill
 * through them. Floors are wide because the clips mix starting, stopping and frame-rate noise —
 * they exist so a detector change cannot silently bring back the intermittent fill the player
 * reported: peak 0.63 / mean 0.20 / 131 of 202 frames with effort when added.
 */
const RUNNING_CLIPS: Record<string, { peak: number; mean: number; effortFrames: number; tailMean?: number }> = {
  'erro-CPU-1795806065324': { peak: 0.4, mean: 0.1, effortFrames: 0.4 },
  // Farther from the camera the vertical bounce barely reaches the candidacy floors: before weak
  // candidacy refreshed the lateral bridge, this run filled for seven seconds and then died at the
  // bridge cap with the player still running — the last four seconds read 0.024 mean effort. After
  // the fix they read 0.67, and the whole clip: peak 0.87 / mean 0.32 / 62% of frames.
  'erro-CPU-1795816707547': { peak: 0.5, mean: 0.15, effortFrames: 0.45, tailMean: 0.3 },
};
const runningClips = Object.entries(recordings).filter(([path]) => Object.keys(RUNNING_CLIPS).some((clip) => path.endsWith(`/${clip}.json`)));

interface Floor { run: number; arms: number; side: number; stop: number; runJump?: number; walk?: number }
const FLOORS: Record<string, Floor> = {
  'corrida-CPU-1795731825430': { run: 85, arms: 3, side: 20, stop: 12 },
  'corrida-CPU-1795734053676': { run: 95, arms: 3, side: 5, stop: 5 },
  'corrida-CPU-1795735134733': { run: 95, arms: 3, side: 5, stop: 5 },
  'corrida-CPU-1795736477645': { run: 95, arms: 3, side: 5, stop: 5, runJump: 90, walk: 75 },
  'corrida-CPU-1795738782805': { run: 95, arms: 3, side: 5, stop: 5, runJump: 90, walk: 75 },
  // Big arm swings while walking and broken skeleton frames: the hardest one so far.
  'corrida-CPU-1795739257223': { run: 95, arms: 8, side: 5, stop: 8, runJump: 70, walk: 60 },
  // Badly framed (see above): kept to notice changes, not as a target.
  'corrida-GPU-1795733551309': { run: 20, arms: 3, side: 5, stop: 5 },
};

describe('recording script and replay', () => {
  it('records every scripted frame, then reports the end', () => {
    const recorder = new PoseRecorder();
    for (let time = 5000; time < 5000 + SCRIPT_MS; time += 100) expect(recorder.push(pose(time))).toBeDefined();
    expect(recorder.push(pose(5000 + SCRIPT_MS))).toBeUndefined();
    expect(recorder.frameCount).toBe(SCRIPT_MS / 100);
    expect(segmentAt(0)?.segment.kind).toBe('warmup');
  });

  it('remembers only the last twenty seconds for a mistake clip', () => {
    const recent: ReturnType<typeof pose>[] = [];
    for (let time = 0; time <= 60_000; time += 500) rememberFrame(recent, pose(time));
    expect(recent[0]!.timestampMs).toBe(40_000);
    expect(recent.at(-1)!.timestampMs).toBe(60_000);
  });

  it('scores a motionless player as motionless in every segment', () => {
    const frames = Array.from({ length: SCRIPT_MS / 100 }, (_, index) => pose(index * 100));
    const scores = replayTrack(frames);
    expect(scores).toHaveLength(TRACK_RECORDING_SCRIPT.length);
    expect(scores.every((score) => score.steps === 0 && score.jumps === 0 && score.moving01 === 0)).toBe(true);
  });
});

describe.skipIf(Object.keys(recordings).length === 0)('scoreboard for real recordings', () => {
  it('registers the arm-only negative control instead of skipping it silently', () => {
    // The zero-effort guarantee is the whole point of the gate; running the scoreboard without
    // any labelled arm-only clip must be loud, or a detector regression can slip in unnoticed.
    // Record a clip waving the arms without running (E saves the last 20 s) and add its name
    // to ARMS_ONLY_CLIPS.
    expect(armsOnlyClips.length, 'no recording is labelled as arm movement — see ARMS_ONLY_CLIPS').toBeGreaterThan(0);
  });

  it.each(armsOnlyClips)('%s: a clip labelled as arm movement feeds no race effort end to end', (_name, raw) => {
    const recording = parsePoseRecording(raw);
    const frames = recording.frames.map((frame) => frame.snapshot);
    const pipeline = new ActionPipeline();
    const calibrator = new AdaptiveCalibrator();
    let profile: CalibrationProfile | undefined;
    let peak = 0;
    for (const snapshot of frames) {
      profile = calibrator.update(snapshot, pipeline.laneZone) ?? profile;
      peak = Math.max(peak, pipeline.update(snapshot, profile).rawEffort);
    }
    expect(peak, 'arm movement without running fed the race effort').toBe(0);
  });

  it.each(runningClips)('%s: a clip labelled as a running attempt fills the effort bar', (_name, raw) => {
    const recording = parsePoseRecording(raw);
    const frames = recording.frames.map((frame) => frame.snapshot);
    const pipeline = new ActionPipeline();
    const calibrator = new AdaptiveCalibrator();
    let profile: CalibrationProfile | undefined;
    let peak = 0, sum = 0, withEffort = 0, tailSum = 0, tailN = 0;
    const first = frames[0]!.timestampMs;
    const endS = (frames.at(-1)!.timestampMs - first) / 1000;
    for (const snapshot of frames) {
      profile = calibrator.update(snapshot, pipeline.laneZone) ?? profile;
      const effort = pipeline.update(snapshot, profile).rawEffort;
      peak = Math.max(peak, effort);
      sum += effort;
      if (effort > 0.01) withEffort++;
      if ((snapshot.timestampMs - first) / 1000 >= endS - 4) { tailSum += effort; tailN++; }
    }
    const floor = RUNNING_CLIPS[Object.keys(RUNNING_CLIPS).find((clip) => _name.endsWith(`/${clip}.json`))!]!;
    expect(peak, 'running barely registered').toBeGreaterThanOrEqual(floor.peak);
    expect(sum / frames.length, 'running filled weakly overall').toBeGreaterThanOrEqual(floor.mean);
    expect(withEffort / frames.length, 'the fill was intermittent').toBeGreaterThanOrEqual(floor.effortFrames);
    // A run that dies while the player is still going barely moves its global averages: the tail
    // is where the death shows.
    if (floor.tailMean !== undefined) expect(tailSum / tailN, 'the fill died while the player was still running').toBeGreaterThanOrEqual(floor.tailMean);
  });

  it.each(Object.entries(recordings))('%s', (name, raw) => {
    const recording = parsePoseRecording(raw);
    const frames = recording.frames.map((frame) => frame.snapshot);
    const seconds = (recording.lastTimestampMs - recording.firstTimestampMs) / 1000;
    console.log(`${name} · ${recording.source.delegate} · ${(frames.length / seconds).toFixed(1)} fps`);
    console.table(replayTrack(frames));
    const summary = summarize(frames);
    console.log('SUMMARY', JSON.stringify(summary));
    expect(frames.length).toBeGreaterThan(0);
    // A new recording has no floor yet: it is printed, then judged by whoever adds it.
    const floor = FLOORS[name.split('/').at(-1)!.replace('.json', '')];
    if (!floor) return;
    expect(summary.still, 'standing still moved the runner').toBeLessThanOrEqual(2);
    expect(summary.arms, 'arms alone moved the runner').toBeLessThanOrEqual(floor.arms);
    // The channel the athletics race actually consumes: arms without a torso bounce must not
    // feed any effort at all, and real running must register strongly through the gate.
    // Even violent scripted swings stay shut out: they bounce the torso but never shift the
    // body's weight, and the gate needs both. Broken-framing clips (floor.run below 50) cannot
    // score run effort because the tracker loses the body.
    expect(summary.armsEffort, 'arms alone fed the race effort').toBeLessThanOrEqual(0.03);
    if (floor.run >= 50) expect(summary.runEffort, 'running no longer feeds the race effort').toBeGreaterThanOrEqual(0.1);
    expect(summary.side, 'changing lanes moved the runner').toBeLessThanOrEqual(floor.side);
    expect(summary.stop, 'the runner kept going after the stop').toBeLessThanOrEqual(floor.stop);
    expect(summary.run, 'running was missed').toBeGreaterThanOrEqual(floor.run);
    if (floor.walk !== undefined) expect(summary.walk, 'walking was missed').toBeGreaterThanOrEqual(floor.walk);
    if (floor.runJump !== undefined) expect(summary.runJump, 'running was lost around jumps').toBeGreaterThanOrEqual(floor.runJump);
  });
});
