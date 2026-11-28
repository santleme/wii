import type { TrackingState } from '../../cv/protocol';

export type Gait = 'idle' | 'walk' | 'run';

// On the CadenceTracker scale these are about 138 steps/min to start running and 130 to drop back.
const RUN_ON_SPEED = 0.55;
const RUN_OFF_SPEED = 0.5;

export function gaitFor(speed01: number, previous: Gait): Gait {
  if (speed01 <= 0.02) return 'idle';
  return speed01 >= (previous === 'run' ? RUN_OFF_SPEED : RUN_ON_SPEED) ? 'run' : 'walk';
}

/**
 * Keyboard pace steps, on the gaitFor scale: the walk step stays under RUN_OFF_SPEED, so it
 * reads as 'walk' from any gait, and the run step clears RUN_ON_SPEED, so it reads as 'run'.
 */
export const KEYBOARD_WALK_SPEED = 0.3;
export const KEYBOARD_RUN_SPEED = 0.8;

/** Keyboard pace cycle: stopped → walking → running → stopped. */
export function nextPace(speed01: number): number {
  return speed01 === 0 ? KEYBOARD_WALK_SPEED : speed01 < RUN_ON_SPEED ? KEYBOARD_RUN_SPEED : 0;
}

export type PaceOwner = 'camera' | 'keyboard';
export interface Pace { owner: PaceOwner; speed01: number; cadenceSpm: number; cameraTracking?: TrackingState }

/** A measured step is the player's body asking to drive the run: it hands pace to the camera. */
export function applyStep(pace: Pace): Pace {
  return pace.owner === 'camera' ? pace : { ...pace, owner: 'camera' };
}

/**
 * Sprint frames only apply while the camera owns the pace, so a ↓/S pick survives both
 * standstill frames and the residual positive cadence the tracker keeps reporting for a
 * while after the last step — ownership moves on real steps, not on decaying measurements.
 */
export function applySprint(pace: Pace, event: { speed01: number; cadenceSpm: number; trackingState?: TrackingState }): Pace {
  return pace.owner === 'camera' ? { ...pace, speed01: event.speed01, cadenceSpm: event.cadenceSpm, cameraTracking: event.trackingState } : pace;
}

const CAMERA_INPUT_STALE_MS = 400;

export function adjudicationDt(pace: Pace, dt: number, cameraInputAgeMs = 0): number {
  const measuredCameraInput = (pace.cameraTracking === undefined || pace.cameraTracking === 'tracked') && cameraInputAgeMs <= CAMERA_INPUT_STALE_MS;
  return pace.owner === 'keyboard' || measuredCameraInput ? dt : 0;
}

const EASE_RATE = 6;
const STUMBLE_SPEED_FACTOR = 0.5;

/** Shown speed chases the requested pace, snapping to a full stop once it is imperceptible. */
export function easeSpeed(shown: number, target: number, dt: number): number {
  const next = shown + (target - shown) * Math.min(1, dt * EASE_RATE);
  return target === 0 && next < 0.02 ? 0 : next;
}

/** A trip costs shown speed only: the requested pace is untouched, so easing wins it back by itself. */
export function stumble(shown: number): number {
  return shown * STUMBLE_SPEED_FACTOR;
}
