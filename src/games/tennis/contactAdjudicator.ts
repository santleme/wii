import { solveOverNet, type BallState } from './ballistics';

/**
 * Pure swing adjudication by timing — the heart of the tennis design
 * (docs/design-tenis.md §3.4). No DOM, no Three.js, no randomness, no global time.
 *
 * Direction comes from WHEN the swing peaked relative to the ball's arrival, computed
 * spatially against the ball state rewound to the physical peak instant, so detection
 * latency cannot corrupt timing. Adds spin, smash and movement-penalty effects.
 */

export interface SwingContactInput {
  side: 'forehand' | 'backhand';
  power01: number;
  /** Vertical wrist speed at the peak in shoulder widths/s, up positive — the spin proxy. */
  verticalSpeed: number;
  /** Wrist height relative to the shoulder at the peak, in shoulder widths. */
  contactY: number;
}

export interface ContactGeometry {
  /** z of the ideal contact plane in front of the player. */
  contactPlaneZ: number;
  /** Ball past playerZ + passMarginZ is dead regardless of timing. */
  playerZ: number;
  passMarginZ: number;
  /** Lateral distance from the avatar center the racket still covers. */
  reachRadius: number;
  /** Arcade contact window: |timing error| beyond this is a whiff. */
  maxTimingMs: number;
  /** Timing error mapped over this span reaches full lateral angle. */
  timingSpanMs: number;
  /** Lateral target at full span, in court units. */
  maxLateralTargetX: number;
  /** |aim| under this reads as a center shot. */
  centerAimX: number;
  /** Deepest/shallowest target depth past the net. */
  deepTargetZ: number;
  shallowTargetZ: number;
  /** Ball at or above this height at contact turns the stroke into a smash. */
  smashHeight: number;
  /** Forward speeds in court units/s; flight time derives from them. */
  minForwardSpeed: number;
  maxForwardSpeed: number;
}

export const DEFAULT_GEOMETRY: ContactGeometry = {
  contactPlaneZ: 7.2,
  playerZ: 8.3,
  passMarginZ: 1.2,
  reachRadius: 2.2,
  maxTimingMs: 500,
  timingSpanMs: 350,
  maxLateralTargetX: 2.8,
  centerAimX: 0.9,
  deepTargetZ: -9.2,
  shallowTargetZ: -6.8,
  smashHeight: 1.8,
  minForwardSpeed: 11,
  maxForwardSpeed: 20,
};

/** Finish heights in shoulder widths above the shoulder line. */
// A backhand ends higher than a forehand without meaning to, so each side has its own line.
const HIGH_FINISH = { forehand: 1.4, backhand: 2 };
const LOW_FINISH = -0.5;

export function strokeHeight(contactY: number, side: 'forehand' | 'backhand'): 'high' | 'normal' | 'low' {
  return contactY >= HIGH_FINISH[side] ? 'high' : contactY <= LOW_FINISH ? 'low' : 'normal';
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clampSigned = (value: number) => Math.min(1, Math.max(-1, value));

/**
 * Timing error in milliseconds derived spatially: how far the ball is from the contact plane,
 * converted by its own approach speed. Exactly `t_peak − t_ideal` under constant approach speed
 * (see design doc §3.4): negative = early, positive = late. Undefined when not approaching.
 * Constant-vz approximation: exact while airborne, slightly off across a frictioned bounce.
 */
export function spatialTimingErrorMs(ballAtPeak: BallState, contactPlaneZ: number): number | undefined {
  const vz = ballAtPeak.velocity.z;
  if (vz === 0) return undefined;
  return ((ballAtPeak.position.z - contactPlaneZ) / vz) * 1000;
}

export type ContactOutcome =
  | { kind: 'ignore' }
  | { kind: 'whiff'; reason: 'early' | 'late' | 'out-of-reach' | 'dead-ball' }
  | {
      kind: 'contact';
      outgoing: { x: number; y: number; z: number };
      direction: 'cross' | 'center' | 'line';
      aimX: number;
      timingErrorMs: number;
      quality01: number;
      spin: number;
      smash: boolean;
      height: 'high' | 'normal' | 'low';
    };

export interface AdjudicationQuery {
  /** Ball state resolved back at the swing's physical peak instant (the rewind). */
  ballAtPeak: BallState;
  playerX: number;
  /** 0 = avatar set, 1 = avatar still sprinting to reach — taxes the return pace. */
  movementPenalty01: number;
  swing: SwingContactInput;
  /** Temporal error when the caller computes it directly (serve toss); spatial otherwise. */
  timingErrorOverrideMs?: number;
  geometry?: Partial<ContactGeometry>;
}

/**
 * Wii-style contact adjudication: direction comes from WHEN the swing peaked relative to the
 * ball's arrival, never from where the arm ended up. Everything is computed against the ball
 * state rewound to the physical peak instant, so detection latency cannot corrupt timing.
 */
export function adjudicateContact(query: AdjudicationQuery): ContactOutcome {
  const geo: ContactGeometry = { ...DEFAULT_GEOMETRY, ...query.geometry };
  const { ballAtPeak, swing } = query;

  const timingErrorMs =
    query.timingErrorOverrideMs ??
    (ballAtPeak.velocity.z > 0.5 ? spatialTimingErrorMs(ballAtPeak, geo.contactPlaneZ) : undefined);
  if (timingErrorMs === undefined || !Number.isFinite(timingErrorMs)) return { kind: 'ignore' };

  if (ballAtPeak.bounces >= 2 || ballAtPeak.position.z > geo.playerZ + geo.passMarginZ) {
    return { kind: 'whiff', reason: 'dead-ball' };
  }
  if (Math.abs(ballAtPeak.position.x - query.playerX) > geo.reachRadius) {
    return { kind: 'whiff', reason: 'out-of-reach' };
  }
  if (timingErrorMs < -geo.maxTimingMs) return { kind: 'whiff', reason: 'early' };
  if (timingErrorMs > geo.maxTimingMs) return { kind: 'whiff', reason: 'late' };

  const quality01 = 1 - clamp01(Math.abs(timingErrorMs) / geo.maxTimingMs);

  // Direction: the continuous timing-to-angle mapping, mirrored for the backhand — early
  // contact pulls across, late contact pushes down the line, like the real sport.
  const normalizedTiming = clampSigned(timingErrorMs / geo.timingSpanMs);
  const sideMirror = swing.side === 'forehand' ? 1 : -1;
  const aimX = normalizedTiming * sideMirror * geo.maxLateralTargetX;
  const direction =
    Math.abs(aimX) < geo.centerAimX
      ? ('center' as const)
      : aimX * sideMirror < 0
        ? ('cross' as const)
        : ('line' as const);

  // Pace: swing speed taxed by mistiming and by a still-moving avatar.
  const smash = ballAtPeak.position.y >= geo.smashHeight;
  const movementCap = 1 - 0.35 * clamp01(query.movementPenalty01);
  const qualityCap = 0.7 + 0.3 * quality01;
  const powerCap = movementCap * qualityCap * (smash ? 1.2 : 1);
  const forwardSpeed =
    geo.minForwardSpeed + (geo.maxForwardSpeed - geo.minForwardSpeed) * clamp01(swing.power01) * powerCap;

  // Depth follows pace: harder shots land deeper; flight time is imposed by the pace.
  const depthT = clamp01((forwardSpeed - geo.minForwardSpeed) / (geo.maxForwardSpeed - geo.minForwardSpeed));
  // Where the stroke finished shapes the arc: above the head lobs deep, below the chest skims the net.
  const height = strokeHeight(swing.contactY, swing.side);
  const targetZ = height === 'high' ? geo.deepTargetZ : geo.shallowTargetZ + (geo.deepTargetZ - geo.shallowTargetZ) * depthT;
  const flightTime = ((ballAtPeak.position.z - targetZ) / forwardSpeed) * (height === 'high' ? 1.5 : height === 'low' ? 0.85 : 1);

  const clearance = height === 'high' ? 2.8 : height === 'low' ? 1.05 : 1.25;
  const outgoing = solveOverNet(ballAtPeak.position, { x: aimX, z: targetZ }, flightTime, clearance);
  const spin = clampSigned(swing.verticalSpeed / 3);

  return {
    kind: 'contact',
    outgoing,
    direction,
    aimX,
    timingErrorMs,
    quality01,
    spin,
    smash,
    height,
  };
}
