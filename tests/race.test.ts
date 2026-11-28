import { describe, expect, it } from 'vitest';
import { COUNTDOWN_S, EFFORT_EXPIRES_S, FRAMED_S, HEADROOM, FRAMING_PATIENCE_S, NO_BODY_ADVICE, Race, RESTART_AFTER_S, RESTART_HOLD_S, WARMUP_RETRIES, WARMUP_S } from '../src/games/athletics/race';

const RACE_METRES = 100;
/** The camera sends a reading every frame; `feed` sets the one it keeps sending. */
const camera = new WeakMap<Race, number>();
const feed = (race: Race, effort: number) => { camera.set(race, effort); race.setEffort(effort); };

const run = (race: Race, seconds: number, each?: () => void) => {
  for (let i = 0; i < Math.round(seconds * 60); i += 1) {
    each?.();
    const effort = camera.get(race);
    if (effort !== undefined) feed(race, effort);
    race.step(1 / 60);
  }
};
/** Through framing and warm-up, running flat out at the given camera reading. */
const warmedUp = (best: number) => {
  const race = new Race();
  race.setFraming(undefined);
  run(race, FRAMED_S);
  feed(race, best);
  run(race, WARMUP_S);
  while (race.phase === 'warmup') run(race, WARMUP_S);
  feed(race, 0);
  return race;
};
const started = (best = 0.9) => { const race = warmedUp(best); run(race, COUNTDOWN_S); return race; };
const finish = (effort: number) => {
  const race = started();
  feed(race, effort);
  run(race, 90);
  return race;
};

describe('athletics race', () => {
  it('stops the runner when the camera goes silent, instead of running on its last reading', () => {
    const race = started();
    feed(race, 0.9);
    run(race, 3);
    camera.delete(race); // readings stop arriving, with no error
    run(race, EFFORT_EXPIRES_S + 0.1);
    expect(race.effort01).toBe(0);
    const at = race.distance;
    run(race, 5);
    expect(race.distance - at).toBeLessThan(10);
  });

  it.each([15, 30])('expires repeated degraded readings at %i fps and accepts a fresh sample', (fps) => {
    const race = started();
    const sampleAtMs = 1000;
    const frameMs = 1000 / fps;
    for (let frame = 1; frame <= fps; frame += 1) {
      race.setEffort(0.8, sampleAtMs);
      const elapsedMs = frame * frameMs;
      race.step(1 / 60, sampleAtMs + elapsedMs);
      if (elapsedMs < 499) expect(race.effort01).toBeGreaterThan(0);
      if (elapsedMs > 501) expect(race.effort01).toBe(0);
    }
    race.setEffort(0, 2000 + frameMs);
    race.step(1 / 60, 2000 + frameMs);
    expect(race.effort01).toBe(0);
    race.setEffort(0.8, 2000 + 2 * frameMs);
    race.step(1 / 60, 2000 + 2 * frameMs);
    expect(race.effort01).toBeGreaterThan(0);
  });

  it('times each 100 m split once and stops at the chosen distance', () => {
    for (const goal of [100, 200, 400] as const) {
      const race = new Race(goal);
      race.setFraming(undefined);
      run(race, FRAMED_S);
      feed(race, 0.8);
      while (race.phase !== 'finished') run(race, 1);
      expect(race.splits.map((split) => split.metres)).toEqual(Array.from({ length: goal / 100 }, (_, i) => (i + 1) * 100));
      expect(race.finishS).toBe(race.splits.at(-1)!.seconds);
      expect(race.splits.every((split, i, all) => i === 0 || split.seconds > all[i - 1]!.seconds)).toBe(true);
    }
  });

  it('runs rivals a little slower over longer distances', () => {
    const [sprint, lap] = [new Race(100), new Race(400)];
    expect(lap.rivals[2]!.pace).toBeLessThan(sprint.rivals[2]!.pace);
  });

  it('waits for a good picture before anything starts', () => {
    const race = new Race();
    feed(race, 1);
    run(race, 10);
    race.setFraming('Incline a câmera para cima');
    run(race, 5);
    expect([race.phase, race.distance]).toEqual(['framing', 0]);
    race.setFraming(undefined);
    run(race, FRAMED_S);
    expect(race.phase).toBe('warmup');
  });

  it('never traps a visible player on the framing screen, but waits for an absent one', () => {
    const [seen, absent] = [new Race(), new Race()];
    seen.setFraming('Incline a câmera para cima');
    absent.setFraming(NO_BODY_ADVICE);
    run(seen, FRAMING_PATIENCE_S + 0.1);
    run(absent, FRAMING_PATIENCE_S * 3);
    expect([seen.phase, absent.phase]).toEqual(['warmup', 'framing']);
  });

  it('does not carry framing patience across an absence', () => {
    const race = new Race();
    race.setFraming('Incline a câmera para cima');
    run(race, FRAMING_PATIENCE_S - 1); // seen, imperfectly, almost long enough to be let through
    race.setFraming(NO_BODY_ADVICE);
    run(race, FRAMING_PATIENCE_S * 2); // the body leaves for a long while
    race.setFraming('Incline a câmera para cima');
    run(race, FRAMING_PATIENCE_S - 0.5);
    expect(race.phase).toBe('framing'); // patience restarted when the body left, not inherited
    run(race, 1);
    expect(race.phase).toBe('warmup');
  });

  it('holds everyone on the blocks during the countdown', () => {
    const race = warmedUp(0.8);
    feed(race, 1);
    run(race, COUNTDOWN_S - 0.1);
    expect([race.phase, race.distance, race.rivals[0]!.distance]).toEqual(['countdown', 0, 0]);
  });

  it('measures effort against what this player and camera can show', () => {
    // The same flat-out run read low by a badly placed camera is still full speed.
    for (const best of [0.16, 0.4, 0.8, 1]) {
      const race = started(best);
      feed(race, best);
      expect(race.effort01).toBeCloseTo(1 / HEADROOM, 5);
      feed(race, best / 2);
      expect(race.effort01).toBeCloseTo(0.5 / HEADROOM, 5);
      feed(race, best * HEADROOM);
      expect(race.effort01).toBeCloseTo(1, 5);
    }
  });

  it('does not take a lazy warm-up as the maximum', () => {
    const race = started(0.02);
    feed(race, 0.2);
    expect(race.effort01).toBeLessThan(0.4);
  });

  it('repeats a warm-up it could not read, saying what to do, and then moves on', () => {
    const race = new Race();
    race.setFraming(undefined, true);
    run(race, FRAMED_S);
    expect(race.coaching).toBeUndefined();
    run(race, 3);
    expect(race.coaching).toMatch(/mãos/);
    run(race, WARMUP_S - 2.9);
    expect([race.phase, race.retries]).toEqual(['warmup', 1]);
    run(race, WARMUP_S * WARMUP_RETRIES);
    expect(race.phase).toBe('countdown');
  });

  it('requires sustained fresh movement rather than held camera readings', () => {
    const race = new Race();
    race.setFraming(undefined);
    run(race, FRAMED_S);

    for (let frame = 0; frame < 300; frame += 1) {
      const timeMs = (frame * 1000) / 60;
      if (frame === 140 || frame === 165) race.setEffort(0.8, timeMs);
      race.step(1 / 60, timeMs);
    }
    expect([race.phase, race.retries]).toEqual(['warmup', 1]);
  });

  it.each([15, 30])('calibrates from sustained camera samples at %i fps', (fps) => {
    const race = new Race();
    race.setFraming(undefined);
    run(race, FRAMED_S);

    for (let frame = 0; frame < 300; frame += 1) {
      const timeMs = (frame * 1000) / 60;
      if (frame % (60 / fps) === 0) race.setEffort(0.3, timeMs);
      race.step(1 / 60, timeMs);
    }

    expect([race.phase, race.retries]).toEqual(['countdown', 0]);
    expect(race.effort01).toBeCloseTo(1 / HEADROOM);
  });

  it('does not restart from one raised pose followed by silence', () => {
    const race = new Race();
    race.phase = 'finished';
    let timeMs = 0;
    for (let frame = 0; frame < 150; frame += 1) {
      timeMs += 1000 / 60;
      race.setHandsRaised(false, timeMs);
      race.step(1 / 60, timeMs);
    }
    race.setHandsRaised(true, timeMs);
    for (let frame = 0; frame < 120; frame += 1) {
      timeMs += 1000 / 60;
      race.step(1 / 60, timeMs);
    }
    expect(race.restart01).toBe(0);
  });

  it('fills the bar and stays quiet while the player is running', () => {
    const race = new Race();
    race.setFraming(undefined);
    run(race, FRAMED_S);
    expect(race.energy01).toBe(0);
    feed(race, 0.06);
    expect(race.energy01).toBeCloseTo(0.5);
    feed(race, 0.16);
    run(race, 3);
    expect([race.energy01, race.coaching]).toEqual([1, undefined]);
  });

  it('lists everyone by time at the finish, the player included once', () => {
    const race = finish(0.9);
    const names = race.standings.map((runner) => runner.name);
    expect(names[0]).toBe('Você');
    expect(names).toHaveLength(4);
    expect(race.standings.map((runner) => runner.timeS)).toEqual([...race.standings.map((runner) => runner.timeS)].sort((a, b) => a - b));
  });

  it('keeps a rival ahead when both cross in the same step and the rival crossed first', () => {
    const race = new Race(100);
    race.phase = 'racing';
    race.elapsedS = 15;
    race.distance = 99.9;
    race.speed = 8.5;
    race.setEffort(1);
    race.rivals[2]!.distance = 99.95;

    race.step(1 / 60);

    expect(race.rivals[2]!.finishS).toBeCloseTo(15 + (100 - 99.95) / 6.5, 6);
    expect(race.finishS).toBeCloseTo(15 + (100 - 99.9) / 8.5, 6);
    expect(race.standings.map((runner) => runner.name).indexOf('Davi')).toBeLessThan(
      race.standings.map((runner) => runner.name).indexOf('Você'),
    );
    expect(race.place).toBe(2);
  });

  it('runs again only when hands are lowered and then held up after the result', () => {
    const race = started();
    let atMs = 0;
    const hold = (raised: boolean, seconds: number) => run(race, seconds, () => {
      atMs += 1000 / 60;
      race.setHandsRaised(raised, atMs);
    });
    feed(race, 0.9);
    hold(true, 90); // still pumping across the line
    expect(race.restart01).toBe(0);
    hold(false, RESTART_AFTER_S);
    hold(true, RESTART_HOLD_S / 2);
    expect(race.restart01).toBeCloseTo(0.5, 1);
    hold(false, 0.1);
    expect(race.restart01).toBe(0);
    hold(true, RESTART_HOLD_S + 0.1);
    expect(race.restart01).toBe(1);
  });

  it('never moves a player who does nothing', () => {
    expect(finish(0).distance).toBe(0);
  });

  it('finishes sooner and places better the harder the player runs', () => {
    const [easy, good, flat] = [finish(0.45), finish(0.65), finish(0.9)];
    expect(easy.finishS!).toBeGreaterThan(good.finishS!);
    expect(good.finishS!).toBeGreaterThan(flat.finishS!);
    expect([easy.place, good.place, flat.place]).toEqual([4, 3, 1]);
    expect(flat.distance).toBeGreaterThanOrEqual(RACE_METRES);
  });

  it('keeps momentum through a short dip in the reading', () => {
    const race = started();
    feed(race, 0.8);
    run(race, 3);
    const speed = race.speed;
    feed(race, 0);
    run(race, 0.4);
    expect(race.speed).toBeGreaterThan(speed * 0.7);
  });

});
