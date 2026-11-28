import { advanceBall, createBall, solveOverNet, type BallState } from './ballistics';

export interface OpponentHitPlan {
  readonly fromBall: BallState;
  readonly contactAfterSeconds: number;
  readonly hitAtMs: number;
}

/** Reconstructs the receiver's contact from the snapshot used to schedule the hit. */
export function ballAtPlannedContact(plan: OpponentHitPlan): BallState {
  return advanceBall(plan.fromBall, plan.contactAfterSeconds);
}

/** Starts the return at scheduled contact, then advances only the wall-clock overrun. */
export function resolveScheduledOpponentReturn(
  plan: OpponentHitPlan,
  nowMs: number,
  target: { readonly x: number; readonly z: number },
  flightTimeSeconds: number,
): BallState {
  const contactBall = ballAtPlannedContact(plan);
  const velocity = solveOverNet(contactBall.position, target, flightTimeSeconds);
  const elapsedAfterContact = Math.max(0, (nowMs - plan.hitAtMs) / 1000);
  return advanceBall(createBall(contactBall.position, velocity, 'opponent'), elapsedAfterContact);
}
