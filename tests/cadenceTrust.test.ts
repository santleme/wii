import { describe, expect, it } from 'vitest';
import { BounceDetector } from '../src/kinematics/bounce';
import { TorsoVerticalChannel } from '../src/kinematics/torsoVertical';
import { ActionPipeline } from '../src/kinematics/actionPipeline';
import { cadenceHarness } from './fixtures/torsoHarness';
import { poseWithHipBounce } from './fixtures/syntheticPose';

/**
 * The effort gate opens when vertical bounce is corroborated — by lateral weight transfer or by
 * rhythmic strides — because neither shape appears without real locomotion: violent arm swinging
 * bounces the torso but arrhythmically and with the weight centered, while centered two-foot
 * jogging bounces rhythmically without sway. Once open, lateral motion alone only bridges a few
 * seconds: a sideways shuffle must not renew the verdict forever.
 */
function drive(times: number[], vertical: (t: number) => number, lateral: (t: number) => number) {
  const { feed } = cadenceHarness();
  return times.map((t) => feed(poseWithHipBounce(t, vertical(t), undefined, lateral(t))));
}

const bounce = (t: number) => 0.016 * Math.sin((2 * Math.PI * 2.5 * t) / 1000);
const sway = (t: number) => 0.05 * Math.cos((2 * Math.PI * 2.5 * t) / 1000);
const times = Array.from({ length: 120 }, (_, i) => i * 33);

describe('effort-gate trust in the cadence tracker', () => {
  it('opens for rhythmic vertical bounce alone — the centered two-foot jog', () => {
    const results = drive(times, bounce, () => 0);
    expect(results.some((r) => r.running)).toBe(true);
  });

  it('never opens for arrhythmic vertical flicker — the violent arm-swing shape', () => {
    // Short irregular bursts of torso oscillation: `moving` fires inside a burst, but the rises
    // never chain into consecutive stride intervals and the weight never transfers.
    const flicker = (t: number) => (t % 1900 < 500 ? bounce(t) : 0);
    const results = drive(times, flicker, () => 0);
    expect(results.every((r) => !r.running)).toBe(true);
  });

  it('never opens for weight transfer without vertical bounce', () => {
    const results = drive(times, () => 0, sway);
    expect(results.every((r) => !r.running)).toBe(true);
  });

  it('opens when bounce and weight transfer corroborate before the rhythm establishes', () => {
    // Lateral corroboration is the fast path: the trust opens within the first strides, before
    // three stride intervals could possibly have accumulated.
    const { feed } = cadenceHarness();
    const early = times.slice(0, 40).map((t) => feed(poseWithHipBounce(t, bounce(t), undefined, sway(t))));
    expect(early.some((r) => r.running)).toBe(true);
  });

  it('bridges a flat stretch on weight transfer but caps the bridge without fresh strides', () => {
    const { feed } = cadenceHarness();
    for (const t of times) feed(poseWithHipBounce(t, bounce(t), undefined, sway(t)));
    let t = times.at(-1)!;
    // The bounce stops but the weight keeps shifting — a flat jog with a stable head.
    const bridged = [];
    for (t += 33; t <= times.at(-1)! + 2000; t += 33) bridged.push(feed(poseWithHipBounce(t, 0, undefined, sway(t))));
    expect(bridged.every((r) => r.running)).toBe(true);
    // The shuffle continues past the bridge cap: lateral motion alone cannot renew the verdict.
    const shuffled = [];
    for (; t <= times.at(-1)! + 7000; t += 33) shuffled.push(feed(poseWithHipBounce(t, 0, undefined, sway(t))));
    expect(shuffled.at(-1)!.running).toBe(false);
  });

  it('opens a 480 ms jog early enough for the warm-up even at 20 samples per second', () => {
    const { feed } = cadenceHarness();
    let firstOpen = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 140; i++) {
      const t = i * 50;
      const y = 0.016 * Math.sin((2 * Math.PI * (1000 / 480) * t) / 1000);
      if (feed(poseWithHipBounce(t, y)).running) { firstOpen = t; break; }
    }
    // The five-second warm-up needs 1.5 s of usable effort: opening must leave that plus slack,
    // so anything under three seconds passes the race, where the extended five-stride wait used to
    // push it past 3.5 s and lose.
    expect(firstOpen).toBeLessThan(3000);
  });

  it('opens for a steady centered jog sampled at ordinary camera frame time', () => {
    // Frames 42 ms apart quantize each detected interval a frame either side of the true 480 ms
    // stride (125 spm): the sequence cadence absorbs that even when single intervals fall
    // outside the band.
    const frames42 = Array.from({ length: 120 }, (_, i) => i * 42);
    const jog125 = (t: number) => 0.016 * Math.sin((2 * Math.PI * (1000 / 480) * t) / 1000);
    const results = drive(frames42, jog125, () => 0);
    expect(results.some((r) => r.running)).toBe(true);
  });

  it('opens three valid strides after a slow start instead of waiting out the speed history', () => {
    // A centered run speeding up: an 800 ms rhythm at first, then 400 ms strides. The three
    // valid intervals corroborate as soon as they exist; the slow ones must not hold the gate.
    const { feed } = cadenceHarness();
    const results = [];
    for (let t = 0; t <= 6000; t += 33) {
      const hz = t < 2000 ? 1000 / 800 : 1000 / 400;
      const y = 0.016 * Math.sin((2 * Math.PI * hz * t) / 1000);
      const result = feed(poseWithHipBounce(t, y));
      results.push({ t, ...result });
    }
    const firstOpen = results.find((r) => r.running)?.t ?? Number.POSITIVE_INFINITY;
    // The fast rhythm starts at 2000 ms; three honest strides plus detection latency open not long after, never waiting for the
    // seven-interval speed history to clear the slow start, which would push past five seconds.
    expect(firstOpen).toBeLessThan(4400);
    expect(firstOpen).toBeGreaterThan(2000);
  });

  it('never opens for a borderline bob whose quantization averages into the band', () => {
    // A centered bob every 524 ms (~115 bpm) sampled every 50 ms: short windows can average
    // exactly onto the 500 ms band edge, and at some phase alignments three consecutive
    // readings land exactly on the cutoff — neither path may admit it, so the sweep covers
    // every alignment end-to-end through the action pipeline.
    for (let phase = 0; phase < 524; phase += 87) {
      const pipeline = new ActionPipeline();
      let peak = 0;
      for (let i = 0; i < 200; i++) {
        const t = i * 50;
        const y = 0.016 * Math.sin((2 * Math.PI * (1000 / 524) * (t + phase)) / 1000);
        peak = Math.max(peak, pipeline.update(poseWithHipBounce(t, y)).rawEffort);
      }
      expect(peak, `phase ${phase} fed the race effort`).toBe(0);
      // The verdict itself, not only its downstream effect: the effort floor could read zero
      // even with the gate open, so the sweep asserts the gate never opens at any phase.
      const { feed } = cadenceHarness();
      const verdicts = Array.from({ length: 200 }, (_, i) => {
        const t = i * 50;
        const y = 0.016 * Math.sin((2 * Math.PI * (1000 / 524) * (t + phase)) / 1000);
        return feed(poseWithHipBounce(t, y)).running;
      });
      expect(verdicts.every((running) => !running), `phase ${phase} opened the gate`).toBe(true);
    }
  });

  it('never opens for a slow bob that uneven frame spacing makes look like a stride', () => {
    // 511 ms is slower than the 500 ms cutoff, but rises stamped on these frames read 500, 490, 500.
    const jitter = [5, 14, 14, 6, 5, 9];
    const uneven = Array.from({ length: 180 }, (_, i) => 55 * i + jitter[i % jitter.length]!);
    const results = drive(uneven, (t) => 0.025 * Math.sin((2 * Math.PI * (t + 228)) / 511), () => 0);
    expect(results.every((r) => !r.running)).toBe(true);
  });

  it('opens and feeds effort for a fast centered jog on uneven frames', () => {
    // 240 ms strides at about 18 fps: two crossings 236 ms apart can be detected by frames only
    // 217 ms apart, and dropping the second merges two strides into an irregular reading.
    const jitter = [5, 14, 14, 6, 5, 9];
    const { feed } = cadenceHarness();
    const pipeline = new ActionPipeline();
    let opened = false;
    let peak = 0;
    for (let i = 0; i < 150; i++) {
      const t = 55 * i + jitter[i % jitter.length]!;
      const snapshot = poseWithHipBounce(t, 0.016 * Math.sin((2 * Math.PI * (t + 10)) / 240));
      opened ||= feed(snapshot).running;
      peak = Math.max(peak, pipeline.update(snapshot).rawEffort);
    }
    expect(opened).toBe(true);
    expect(peak).toBeGreaterThan(0);
  });

  it('reopens promptly for a centered jog that stopped for the countdown', () => {
    // The countdown asks the player to stop and go again on the signal, at every rise alignment.
    let slowest = 0;
    for (let phase = 0; phase < 470; phase += 24) {
      const { feed } = cadenceHarness();
      let opened = Number.POSITIVE_INFINITY;
      let openedBefore = false;
      let closedInPause = false;
      for (let t = 0; t < 12_000 && opened === Number.POSITIVE_INFINITY; t += 42) {
        const jogging = t < 3000 || t >= 6000;
        const y = jogging ? 0.024 * Math.sin((2 * Math.PI * (t + phase)) / 470) : 0;
        const { running } = feed(poseWithHipBounce(t, y));
        if (t < 3000) openedBefore ||= running;
        else if (t < 6000) closedInPause = !running;
        else if (running) opened = t - 6000;
      }
      // Without both, the time to reopen would measure a gate that never moved.
      expect(openedBefore, `phase ${phase} never opened before the pause`).toBe(true);
      expect(closedInPause, `phase ${phase} stayed open through the pause`).toBe(true);
      slowest = Math.max(slowest, opened);
    }
    expect(slowest).toBeLessThan(2500);
  });

  it('renews the lateral bridge on bounces too brief to confirm', () => {
    // Weak candidacy: a dip every 2.4 s on a swaying body never confirms `moving`, yet keeps the
    // verdict past the bridge cap that closes it for flat sway.
    const { feed } = cadenceHarness();
    const channel = new TorsoVerticalChannel();
    const witness = new BounceDetector();
    for (const t of times) feed(poseWithHipBounce(t, bounce(t), undefined, sway(t)));
    const start = times.at(-1)! + 33;
    const tail = [];
    for (let t = start; t <= start + 12_000; t += 33) {
      const u = (t - start) % 2400;
      const snapshot = poseWithHipBounce(t, u < 400 ? 0.025 * Math.sin((Math.PI * u) / 400) : 0, undefined, sway(t));
      const sample = channel.update(snapshot)!;
      const { left, right, width, head } = sample.shoulders;
      const seen = witness.update(t, left, right, width, head);
      const result = feed(snapshot);
      if (t > start + 6000) tail.push({ ...result, ...seen });
    }
    expect(tail.some((r) => r.candidate)).toBe(true);
    expect(tail.every((r) => !r.moving)).toBe(true);
    expect(tail.every((r) => r.running)).toBe(true);
  });

  it('never opens for a slow bob however long it persists', () => {
    // Feet planted, no sway: a small torso bob every 800 ms (~75 bpm) is not a stride.
    const slowBob = (t: number) => 0.016 * Math.sin((2 * Math.PI * 1.25 * t) / 1000);
    const results = drive(times, slowBob, () => 0);
    expect(results.every((r) => !r.running)).toBe(true);
  });

  it('never opens for an irregular bob at running average pace', () => {
    // The average rate matches running but the spacing swings wildly — not a stride rhythm.
    const irregular = (t: number) => 0.016 * Math.sin((2 * Math.PI * (1.5 + Math.sin(t / 700)) * t) / 1000);
    const results = drive(times, irregular, () => 0);
    expect(results.every((r) => !r.running)).toBe(true);
  });

  it('does not reopen on a single jolt after stopping, however long the run before it', () => {
    const { feed } = cadenceHarness();
    const witnessChannel = new TorsoVerticalChannel();
    const witnessBounce = new BounceDetector();
    const feedWithWitness = (snapshot: ReturnType<typeof poseWithHipBounce>) => {
      const sample = witnessChannel.update(snapshot);
      if (!sample) throw new Error('the synthetic pose should always produce a torso sample');
      return {
        result: feed(snapshot),
        bounce: witnessBounce.update(sample.timestampMs, sample.shoulders.left, sample.shoulders.right, sample.shoulders.width, sample.shoulders.head),
      };
    };
    const runResults = times.map((t) => feedWithWitness(poseWithHipBounce(t, bounce(t), undefined, sway(t))).result);
    expect(runResults.at(-1)!.running).toBe(true);
    // Stand still long enough for the verdict to close and the stride history to expire.
    let t = times.at(-1)!;
    for (t += 33; t <= times.at(-1)! + 5200; t += 33) feedWithWitness(poseWithHipBounce(t, 0, undefined, 0));
    // One slow asymmetric torso jolt: a shallow downward offset carrying a 396 ms triangular
    // upward peak. The witness assertions below establish the two properties this regression
    // depends on: the bounce verdict is sustained, and the shape emits no rise.
    const riselessJolt = (elapsed: number) => {
      const amplitude = 0.05;
      const centerMs = 891;
      const halfWidthMs = 198;
      const baseline = amplitude * (halfWidthMs / 990);
      const envelope = Math.min(1, elapsed / 300);
      const distance = Math.abs(elapsed - centerMs);
      const shape = distance < halfWidthMs
        ? baseline - (amplitude + baseline) * (1 - distance / halfWidthMs)
        : baseline;
      return envelope * shape;
    };
    const jolt = [];
    const bounces = [];
    const joltStart = t;
    for (; t <= times.at(-1)! + 5200 + 1500; t += 33) {
      const observed = feedWithWitness(poseWithHipBounce(t, riselessJolt(t - joltStart), undefined, 0));
      jolt.push(observed.result);
      bounces.push(observed.bounce);
    }
    let longestMovingRun = 0;
    let movingRun = 0;
    for (const bounce of bounces) {
      movingRun = bounce.moving ? movingRun + 1 : 0;
      longestMovingRun = Math.max(longestMovingRun, movingRun);
    }
    // Eleven consecutive frames span 330 ms, longer than the 300 ms running-trust wait.
    expect(longestMovingRun).toBeGreaterThanOrEqual(11);
    expect(bounces.some((bounce) => bounce.rise)).toBe(false);
    expect(jolt.every((r) => !r.running)).toBe(true);
  });

  it('closes when everything stops', () => {
    const { feed } = cadenceHarness();
    for (const t of times) feed(poseWithHipBounce(t, bounce(t), undefined, sway(t)));
    const still = [];
    for (let t = times.at(-1)! + 33; t <= times.at(-1)! + 4800; t += 33) still.push(feed(poseWithHipBounce(t, 0, undefined, 0)));
    expect(still.at(-1)!.running).toBe(false);
  });
});
