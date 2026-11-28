import { describe, expect, it } from 'vitest';
import { GIVE_UP_AFTER_S, HINT_AFTER_S, LEARNING_TRAVEL, TennisTutorial } from '../src/games/tennis/tutorial';

const stroke = (side: 'forehand' | 'backhand', travel = 3, hand: 'left' | 'right' = 'right') => ({ hand, side, travel });

describe('tennis warm-up', () => {
  it('walks through the four steps as the movements are recognised', () => {
    const tutorial = new TennisTutorial();
    for (let i = 0; i < 3; i += 1) tutorial.swing(stroke('forehand'));
    expect(tutorial.step).toBe('other-side');
    expect(tutorial.swing(stroke('forehand'))).toBe(false);
    tutorial.swing(stroke('backhand'));
    tutorial.swing(stroke('backhand'));
    tutorial.toss();
    tutorial.toss();
    expect(tutorial.step).toBe('serve');
    expect(tutorial.swing(stroke('forehand'))).toBe(false); // no toss yet
    for (let i = 0; i < 2; i += 1) {
      tutorial.toss();
      expect(tutorial.swing(stroke('forehand', 3, 'left'))).toBe(false); // the throwing arm
      tutorial.swing(stroke('forehand'));
    }
    expect(tutorial.done).toBe(true);
  });

  it('learns a left-handed racket and a short stroke, within safe limits', () => {
    const tutorial = new TennisTutorial();
    expect(tutorial.strokeTravel).toBe(1.9);
    for (let i = 0; i < 3; i += 1) tutorial.swing(stroke('forehand', 2.2, 'left'));
    expect(tutorial.racketHand).toBe('left');
    expect(tutorial.strokeTravel).toBeCloseTo(1.65);
    const short = new TennisTutorial();
    for (let i = 0; i < 3; i += 1) short.swing(stroke('forehand', 1.6));
    expect(short.strokeTravel).toBe(LEARNING_TRAVEL);
  });

  it('explains, then moves on, only while the player is seen, and can be skipped', () => {
    const tutorial = new TennisTutorial();
    tutorial.tick(60, false);
    expect(tutorial.step).toBe('swings');
    tutorial.tick(HINT_AFTER_S, true);
    expect(tutorial.text.detail).toContain('braço');
    tutorial.tick(GIVE_UP_AFTER_S - HINT_AFTER_S, true);
    expect(tutorial.step).toBe('other-side');
    tutorial.skip();
    expect(tutorial.done).toBe(true);
  });
});
