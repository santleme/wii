import { describe, expect, it } from 'vitest';
import { JUMP_DURATION_S } from '../src/games/track/jump';
import { isPerfectJump, PERFECT_WINDOW_S, TrackScore } from '../src/games/track/trackScore';

describe('track score', () => {
  it('accumulates sub-point increments across fixed steps', () => {
    const score = new TrackScore();
    for (let i = 0; i < 60; i += 1) score.advance(1 / 60, 0.32);
    expect(score.display).toBe(16);
  });

  it('scores nothing when idle and the most at full sprint', () => {
    const idle = new TrackScore();
    const sprint = new TrackScore();
    for (let i = 0; i < 60; i += 1) {
      idle.advance(1 / 60, 0);
      sprint.advance(1 / 60, 1);
    }
    expect(idle.display).toBe(0);
    expect(sprint.display).toBeGreaterThanOrEqual(49);
    expect(sprint.display).toBeLessThanOrEqual(50);
  });

  it('awards hurdle bonuses and never drops below zero', () => {
    const score = new TrackScore();
    score.hurdleCleared();
    expect(score.display).toBe(100);
    score.hurdleHit();
    expect(score.display).toBe(65);
    score.hurdleHit();
    expect(score.display).toBe(0);
    score.hurdleHit();
    expect(score.display).toBe(0);
  });

  it('resets the combo on a hit', () => {
    const score = new TrackScore();
    score.hurdleCleared();
    score.hurdleCleared();
    expect(score.combo).toBe(2);
    score.hurdleHit();
    expect(score.combo).toBe(0);
  });

  it('remembers the best combo after a hit resets the live combo', () => {
    const score = new TrackScore();
    score.hurdleCleared();
    score.hurdleCleared();
    score.hurdleCleared();
    score.hurdleHit();
    expect(score.combo).toBe(0);
    expect(score.bestComboCount).toBe(3);
    score.hurdleCleared();
    expect(score.bestComboCount).toBe(3);
  });

  it('multiplies consecutive clears up to the cap and restarts after a hit', () => {
    const score = new TrackScore();
    expect([1, 2, 3, 4, 5].map(() => score.hurdleCleared().multiplier)).toEqual([1, 2, 3, 4, 4]);
    expect(score.display).toBe(1400);
    score.hurdleHit();
    expect(score.hurdleCleared()).toEqual({ points: 100, multiplier: 1, perfect: false });
  });

  it('adds a multiplied bonus to a perfect jump', () => {
    const score = new TrackScore();
    score.hurdleCleared();
    expect(score.hurdleCleared(true)).toEqual({ points: 300, multiplier: 2, perfect: true });
  });

  it('calls a jump perfect only near its apex', () => {
    const apex = JUMP_DURATION_S / 2;
    expect(isPerfectJump(apex)).toBe(true);
    expect(isPerfectJump(apex + PERFECT_WINDOW_S * 0.9)).toBe(true);
    expect(isPerfectJump(apex - PERFECT_WINDOW_S * 0.9)).toBe(true);
    expect(isPerfectJump(apex + PERFECT_WINDOW_S * 1.1)).toBe(false);
    expect(isPerfectJump(apex - PERFECT_WINDOW_S * 1.1)).toBe(false);
    expect(isPerfectJump(0)).toBe(false);
  });

  it('adds coins without touching the combo', () => {
    const score = new TrackScore();
    score.hurdleCleared();
    expect(score.coinCollected()).toBe(25);
    expect(score.display).toBe(125);
    expect(score.combo).toBe(1);
  });

  it('doubles the penalty on every trip, even with clears in between', () => {
    const score = new TrackScore();
    const penalties = [1, 2, 3, 4].map(() => {
      score.hurdleCleared();
      return score.hurdleHit();
    });
    expect(penalties).toEqual([35, 70, 140, 280]);
  });

  it('loses the run when a trip wipes the score, remembering the peak', () => {
    const score = new TrackScore();
    score.hurdleCleared();
    score.hurdleHit();
    expect(score.over).toBe(false);
    score.hurdleHit();
    expect(score.over).toBe(true);
    expect(score.peak).toBe(100);
  });

  it('ignores malformed speed values', () => {
    const score = new TrackScore();
    score.advance(1 / 60, Number.NaN);
    score.advance(1 / 60, Number.POSITIVE_INFINITY);
    expect(score.display).toBe(0);
  });
});
