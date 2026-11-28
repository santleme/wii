import { describe, expect, it } from 'vitest';
import { BoxingTutorial, DUCK_HOLD_S, GIVE_UP_AFTER_S, HINT_AFTER_S } from '../src/games/boxing/boxingTutorial';

const idle: { seen: boolean; guard: boolean; zone: -1 | 0 | 1; ducked: boolean } = { seen: true, guard: false, zone: 0, ducked: false };
const frame = (dtS: number, over: Partial<typeof idle> = {}) => ({ dtS, ...idle, ...over });
const straight = { kind: 'straight' as const, target: 'head' as const };

const run = (tutorial: BoxingTutorial, seconds: number, over: Partial<typeof idle> = {}) => {
  for (let t = 0; t < seconds; t += 0.1) tutorial.tick(frame(0.1, over));
};

describe('boxing tutorial', () => {
  it('starts on the guard step with a skip hint and finishes with a farewell', () => {
    const tutorial = new BoxingTutorial();
    expect(tutorial.step).toBe('guard');
    expect(tutorial.text.title).toBe('Segure a guarda alta');
    expect(tutorial.text.detail).toContain('pular');
    tutorial.skip();
    expect(tutorial.done).toBe(true);
    expect(tutorial.text.title).toBe('Pronto!');
  });

  it('guard step needs one second of guard and time off-camera does not count', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, 0.9, { guard: true });
    expect(tutorial.step).toBe('guard');
    run(tutorial, 5, { seen: false, guard: true });
    expect(tutorial.step).toBe('guard');
    run(tutorial, 0.2, { guard: true });
    expect(tutorial.step).toBe('jab');
  });

  it('the first straight hand becomes the lead and only it completes the jabs', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, 1.1, { guard: true });
    expect(tutorial.punch({ hand: 'left', ...straight })).toBe(true);
    expect(tutorial.profile.leadHand).toBe('left');
    expect(tutorial.punch({ hand: 'right', ...straight })).toBe(false);
    expect(tutorial.punch({ hand: 'left', ...straight })).toBe(true);
    expect(tutorial.punch({ hand: 'left', ...straight })).toBe(true);
    expect(tutorial.step).toBe('cross');
  });

  it('the cross step wants the rear hand, not the lead again', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, 1.1, { guard: true });
    for (let i = 0; i < 3; i += 1) tutorial.punch({ hand: 'left', ...straight });
    expect(tutorial.punch({ hand: 'left', ...straight })).toBe(false);
    for (let i = 0; i < 3; i += 1) expect(tutorial.punch({ hand: 'right', ...straight })).toBe(true);
    expect(tutorial.step).toBe('hook');
  });

  it('a body straight does not count as a jab, and hooks/uppercuts/body each need their kind', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, 1.1, { guard: true });
    expect(tutorial.punch({ hand: 'left', kind: 'straight', target: 'body' })).toBe(false);
    for (let i = 0; i < 3; i += 1) tutorial.punch({ hand: 'left', ...straight });
    for (let i = 0; i < 3; i += 1) tutorial.punch({ hand: 'right', ...straight });
    expect(tutorial.punch({ hand: 'left', ...straight })).toBe(false);
    expect(tutorial.punch({ hand: 'left', kind: 'hook', target: 'head' })).toBe(true);
    expect(tutorial.punch({ hand: 'right', kind: 'hook', target: 'head' })).toBe(true);
    expect(tutorial.step).toBe('uppercut');
    expect(tutorial.punch({ hand: 'left', kind: 'uppercut', target: 'head' })).toBe(true);
    expect(tutorial.punch({ hand: 'left', kind: 'uppercut', target: 'head' })).toBe(true);
    expect(tutorial.step).toBe('body');
    expect(tutorial.punch({ hand: 'left', ...straight })).toBe(false);
    expect(tutorial.punch({ hand: 'left', kind: 'straight', target: 'body' })).toBe(true);
    expect(tutorial.punch({ hand: 'right', kind: 'hook', target: 'body' })).toBe(true);
    expect(tutorial.step).toBe('slip');
  });

  it('slips count once per center return and ducks need a held crouch', () => {
    const tutorial = new BoxingTutorial();
    tutorial.skip();
    const fresh = new BoxingTutorial();
    // Walk every step quickly by hand up to the slip step.
    run(fresh, 1.1, { guard: true });
    for (let i = 0; i < 3; i += 1) fresh.punch({ hand: 'left', ...straight });
    for (let i = 0; i < 3; i += 1) fresh.punch({ hand: 'right', ...straight });
    for (let i = 0; i < 2; i += 1) fresh.punch({ hand: 'left', kind: 'hook', target: 'head' });
    for (let i = 0; i < 2; i += 1) fresh.punch({ hand: 'left', kind: 'uppercut', target: 'head' });
    for (let i = 0; i < 2; i += 1) fresh.punch({ hand: 'left', kind: 'straight', target: 'body' });
    expect(fresh.step).toBe('slip');
    run(fresh, 0.3, { zone: -1 });
    run(fresh, 0.3, { zone: -1 });
    run(fresh, 0.3);
    run(fresh, 0.3, { zone: 1 });
    expect(fresh.step).toBe('duck');
    run(fresh, DUCK_HOLD_S - 0.05, { ducked: true });
    expect(fresh.step).toBe('duck');
    run(fresh, 0.1, { ducked: true });
    run(fresh, 0.1);
    run(fresh, DUCK_HOLD_S + 0.1, { ducked: true });
    expect(fresh.done).toBe(true);
    expect(tutorial.done).toBe(true);
  });

  it('shows the hint after ten idle seconds and gives up the step after twenty-two', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, HINT_AFTER_S + 0.5);
    expect(tutorial.text.detail).toContain('Punhos fechados');
    run(tutorial, GIVE_UP_AFTER_S - HINT_AFTER_S);
    expect(tutorial.step).toBe('jab');
  });

  it('learns the median reach per punch kind in the profile', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, 1.1, { guard: true });
    tutorial.punch({ hand: 'left', ...straight, travelSw: 0.8 });
    tutorial.punch({ hand: 'left', ...straight, travelSw: 1.0 });
    tutorial.punch({ hand: 'left', ...straight, travelSw: 0.9 });
    expect(tutorial.profile.reachByKind.straight).toBeCloseTo(0.9);
    expect(tutorial.profile.reachByKind.hook).toBeUndefined();
  });

  it('ignores non-finite reach measurements', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, 1.1, { guard: true });
    tutorial.punch({ hand: 'left', ...straight, travelSw: Number.NaN });
    expect(tutorial.profile.reachByKind.straight).toBeUndefined();
  });

  it('adapts the punch travel floor to three quarters of the compact median reach', () => {
    const tutorial = new BoxingTutorial();
    run(tutorial, 1.1, { guard: true });
    tutorial.punch({ hand: 'left', ...straight, travelSw: 0.28 });
    tutorial.punch({ hand: 'left', ...straight, travelSw: 0.32 });
    tutorial.punch({ hand: 'left', ...straight, travelSw: 0.3 });
    expect(tutorial.punchTravel).toBeCloseTo(0.3 * 0.75);
  });

  it('never adapts beyond the untuned default or below the noise floor', () => {
    const strong = new BoxingTutorial();
    run(strong, 1.1, { guard: true });
    strong.punch({ hand: 'left', ...straight, travelSw: 0.9 });
    expect(strong.punchTravel).toBe(0.25);
    const weak = new BoxingTutorial();
    run(weak, 1.1, { guard: true });
    weak.punch({ hand: 'left', ...straight, travelSw: 0.1 });
    expect(weak.punchTravel).toBe(0.15);
    expect(new BoxingTutorial().punchTravel).toBeUndefined();
  });
});
