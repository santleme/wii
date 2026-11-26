import { describe, expect, it } from 'vitest';
import { createBall, type BallState } from '../src/games/tennis/ballistics';
import {
  adjudicateContact,
  spatialTimingErrorMs,
  type AdjudicationQuery,
  type SwingContactInput,
} from '../src/games/tennis/contactAdjudicator';

const swing = (overrides: Partial<SwingContactInput> = {}): SwingContactInput => ({
  side: 'forehand',
  power01: 0.65,
  verticalSpeed: 0,
  contactY: 0,
  ...overrides,
});

/** Incoming ball frozen at the contact plane at a hittable height — the perfect-contact setup. */
const incoming = (overrides: { x?: number; y?: number; z?: number; vz?: number; bounces?: number } = {}): BallState => {
  const { x = 0, y = 1.1, z = 7.2, vz = 14, bounces = 0 } = overrides;
  const ball = createBall({ x, y, z }, { x: 0, y: -1, z: vz }, 'opponent');
  return { ...ball, bounces };
};

const query = (overrides: Partial<AdjudicationQuery> = {}): AdjudicationQuery => ({
  ballAtPeak: incoming(),
  playerX: 0,
  movementPenalty01: 0,
  swing: swing(),
  ...overrides,
});

describe('spatialTimingErrorMs', () => {
  it('is zero exactly at the contact plane, negative before it (early), positive past it (late)', () => {
    expect(spatialTimingErrorMs(incoming(), 7.2)).toBeCloseTo(0, 5);
    // Ball 1.4 m short of the plane at 14 u/s: the swing happened 100 ms too early.
    expect(spatialTimingErrorMs(incoming({ z: 5.8 }), 7.2)).toBeCloseTo(-100, 5);
    expect(spatialTimingErrorMs(incoming({ z: 8.6 }), 7.2)).toBeCloseTo(100, 5);
  });

  it('is undefined when the ball is not approaching', () => {
    expect(spatialTimingErrorMs(incoming({ vz: 0 }), 7.2)).toBeUndefined();
  });
});

describe('adjudicateContact — whiffs', () => {
  it('ignores balls that are not even approaching the player', () => {
    expect(adjudicateContact(query({ ballAtPeak: incoming({ vz: -8 }) })).kind).toBe('ignore');
  });

  it('ignores non-finite timing overrides instead of turning them into perfect hits', () => {
    for (const timingErrorOverrideMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(adjudicateContact(query({ timingErrorOverrideMs }))).toEqual({ kind: 'ignore' });
    }
  });

  it('whiffs early and late outside the timing window', () => {
    // Slow ball (7 u/s) so the ±290 ms offsets stay inside the pass margin — isolating timing.
    expect(adjudicateContact(query({ ballAtPeak: incoming({ z: 7.2 - 7 * 0.29, vz: 7 }) }))).toMatchObject({
      kind: 'whiff',
      reason: 'early',
    });
    expect(adjudicateContact(query({ ballAtPeak: incoming({ z: 7.2 + 7 * 0.29, vz: 7 }) }))).toMatchObject({
      kind: 'whiff',
      reason: 'late',
    });
  });

  it('whiffs when the ball is beyond the lateral reach even with perfect timing', () => {
    expect(adjudicateContact(query({ ballAtPeak: incoming({ x: 1.4 }), playerX: 0 }))).toMatchObject({
      kind: 'whiff',
      reason: 'out-of-reach',
    });
    expect(adjudicateContact(query({ ballAtPeak: incoming({ x: 1.1 }), playerX: 0 })).kind).toBe('contact');
  });

  it('dead-balls after the second bounce and after passing the player', () => {
    expect(adjudicateContact(query({ ballAtPeak: incoming({ bounces: 2 }) }))).toMatchObject({
      kind: 'whiff',
      reason: 'dead-ball',
    });
    expect(adjudicateContact(query({ ballAtPeak: incoming({ z: 9.6 }) }))).toMatchObject({
      kind: 'whiff',
      reason: 'dead-ball',
    });
  });
});

describe('adjudicateContact — contacts', () => {
  it('perfect timing hits center with full quality', () => {
    const out = adjudicateContact(query());
    expect(out).toMatchObject({ kind: 'contact', direction: 'center' });
    if (out.kind !== 'contact') return;
    expect(out.quality01).toBeGreaterThan(0.95);
    expect(out.outgoing.z).toBeLessThan(0); // toward the opponent
  });

  it('early forehand pulls cross, late forehand pushes line — continuously', () => {
    // ±0.1 s at 14 u/s ≈ 1.4 m off-plane.
    const early = adjudicateContact(query({ ballAtPeak: incoming({ z: 7.2 - 1.4 }) }));
    const late = adjudicateContact(query({ ballAtPeak: incoming({ z: 7.2 + 1.4 }) }));
    expect(early).toMatchObject({ kind: 'contact', direction: 'cross' });
    expect(late).toMatchObject({ kind: 'contact', direction: 'line' });
    if (early.kind !== 'contact' || late.kind !== 'contact') return;
    expect(early.outgoing.x).toBeLessThan(0);
    expect(late.outgoing.x).toBeGreaterThan(0);
  });

  it('mirrors the timing-direction mapping for the backhand, like real tennis', () => {
    const earlyBackhand = adjudicateContact(
      query({ ballAtPeak: incoming({ z: 7.2 - 1.4 }), swing: swing({ side: 'backhand' }) }),
    );
    if (earlyBackhand.kind !== 'contact') throw new Error('expected contact');
    // Early on the backhand side sends the ball the opposite way than early on the forehand.
    expect(earlyBackhand.outgoing.x).toBeGreaterThan(0);
    expect(earlyBackhand.direction).toBe('cross');
  });

  it('the outgoing trajectory crosses the net toward the opponent court', () => {
    const out = adjudicateContact(query());
    if (out.kind !== 'contact') throw new Error('expected contact');
    expect(out.outgoing.z).toBeLessThan(-10); // real forward pace
    // Low net clearance is physical: from 1.1 m the arc peaks well above the 0.9 m net.
    expect(out.outgoing.y).toBeGreaterThan(0);
  });

  it('faster swings hit harder; mistiming and movement tax the pace', () => {
    const strong = adjudicateContact(query({ swing: swing({ power01: 1 }) }));
    const weak = adjudicateContact(query({ swing: swing({ power01: 0.2 }) }));
    if (strong.kind !== 'contact' || weak.kind !== 'contact') throw new Error('expected contact');
    expect(Math.abs(strong.outgoing.z)).toBeGreaterThan(Math.abs(weak.outgoing.z));

    const moving = adjudicateContact(query({ movementPenalty01: 1, swing: swing({ power01: 1 }) }));
    if (moving.kind !== 'contact') throw new Error('expected contact');
    expect(Math.abs(moving.outgoing.z)).toBeLessThan(Math.abs(strong.outgoing.z));
  });

  it('reads a rising wrist as topspin and a falling wrist as slice', () => {
    const topspin = adjudicateContact(query({ swing: swing({ verticalSpeed: 3 }) }));
    const slice = adjudicateContact(query({ swing: swing({ verticalSpeed: -3 }) }));
    if (topspin.kind !== 'contact' || slice.kind !== 'contact') throw new Error('expected contact');
    expect(topspin.spin).toBeGreaterThan(0.5);
    expect(slice.spin).toBeLessThan(-0.5);
  });

  it('smashes a high ball with bonus pace', () => {
    const high = adjudicateContact(query({ ballAtPeak: incoming({ y: 2.1 }), swing: swing({ power01: 0.65 }) }));
    const normal = adjudicateContact(query());
    if (high.kind !== 'contact' || normal.kind !== 'contact') throw new Error('expected contact');
    expect(high.smash).toBe(true);
    expect(Math.abs(high.outgoing.z)).toBeGreaterThan(Math.abs(normal.outgoing.z));
  });

  it('a ball below the net cord at contact lifts a steep, error-prone arc', () => {
    const low = adjudicateContact(query({ ballAtPeak: incoming({ y: 0.45 }) }));
    if (low.kind !== 'contact') throw new Error('expected contact');
    // Low contact must climb: vy positive and large relative to a normal contact.
    expect(low.outgoing.y).toBeGreaterThan(2);
  });
});

