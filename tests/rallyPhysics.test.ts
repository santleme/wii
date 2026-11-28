import { describe, expect, it } from 'vitest';
import { createBall } from '../src/games/tennis/ballistics';
import { adjudicateContact } from '../src/games/tennis/contactAdjudicator';
import { advancePlayerShotToNow } from '../src/games/tennis/rallyPhysics';

describe('delayed player-shot simulation', () => {
  it('adjudicates a net fault during the rewind-to-now fast-forward', () => {
    const ballAtContact = createBall({ x: 0, y: 0.1, z: 7.2 }, { x: 0, y: -1, z: 14 }, 'opponent');
    // A flat shot from ankle height: the stroke adjudication no longer produces one, the physics still judges it.
    const advanced = advancePlayerShotToNow(ballAtContact, { x: 0, y: 2, z: -18 }, 0.45, 0.9);

    expect(advanced.netFault).toBe(true);
  });

  it('does not count a high shot as a net fault while fast-forwarding', () => {
    const ballAtContact = createBall({ x: 0, y: 1.1, z: 7.2 }, { x: 0, y: -1, z: 14 }, 'opponent');
    const outcome = adjudicateContact({
      ballAtPeak: ballAtContact,
      playerX: 0,
      movementPenalty01: 0,
      swing: { side: 'forehand', power01: 1, verticalSpeed: 0, contactY: 0 },
      timingErrorOverrideMs: 0,
    });
    if (outcome.kind !== 'contact') throw new Error('expected contact');

    const advanced = advancePlayerShotToNow(ballAtContact, outcome.outgoing, 0.4, 0.9);

    expect(advanced.netFault).toBe(false);
  });
});
