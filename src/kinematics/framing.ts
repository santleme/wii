import type { Hand, PoseSnapshot } from '@wii/spatial-core';
import { landmarkConfidence, visibleImagePoint } from './math';

/** The warning waits this long: a head that dips out during a hop or a stride is not worth a word. */
const HEAD_OUT_AFTER_MS = 1500;
/** Once shown, the head has to come clearly back inside. */
const HEAD_BACK_MARGIN = 0.02;

/**
 * BlazePose finds a person through the face and assumes the head is visible
 * (https://arxiv.org/abs/2006.10204). With it cut off, a running player is lost or drawn upside down.
 */
export class HeadWarning {
  private outSince?: number;
  private shown = false;

  /** Whether to ask the player to get their head back into the picture. */
  update(snapshot: PoseSnapshot): boolean {
    const nose = snapshot.landmarks[0];
    // No body at all says nothing new: keep whatever was being shown.
    if (!nose) return this.shown;
    if (nose.y >= (this.shown ? HEAD_BACK_MARGIN : 0)) {
      this.outSince = undefined;
      this.shown = false;
    } else {
      this.outSince ??= snapshot.timestampMs;
      if (snapshot.timestampMs - this.outSince >= HEAD_OUT_AFTER_MS) this.shown = true;
    }
    return this.shown;
  }

  reset(): void { this.outSince = undefined; this.shown = false; }
}

/** Hips above shoulders cannot be a standing player: the tracker is hallucinating. */
export function upsideDown(snapshot: PoseSnapshot): boolean {
  const [leftShoulder, rightShoulder, leftHip, rightHip] = [11, 12, 23, 24].map((index) => snapshot.landmarks[index]);
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return false;
  if (landmarkConfidence(leftShoulder, rightShoulder, leftHip, rightHip) < 0.5) return false;
  return leftHip.y + rightHip.y < leftShoulder.y + rightShoulder.y;
}

/** Room the head needs above it before a race: a real clip with the nose at the edge read poorly. */
const MIN_HEADROOM = 0.1;
const MIN_SHOULDER_SPAN = 0.12;
const MAX_SHOULDER_SPAN = 0.42;
const MIN_CENTER_X = 0.3;
const MAX_CENTER_X = 0.7;

/** What the player should change before a race, or undefined when the picture is good. */
export function framingAdvice(snapshot: PoseSnapshot): string | undefined {
  const [nose, left, right] = [0, 11, 12].map((index) => snapshot.landmarks[index]);
  if (!nose || !left || !right || Math.min(left.visibility ?? 0, right.visibility ?? 0) < 0.5) return 'Apareça na câmera';
  const span = Math.abs(left.x - right.x);
  if (span > MAX_SHOULDER_SPAN) return 'Afaste-se da câmera';
  if (nose.y < MIN_HEADROOM) return 'Incline a câmera para cima ou afaste-se';
  if (span < MIN_SHOULDER_SPAN) return 'Chegue mais perto';
  const center = (left.x + right.x) / 2;
  if (center < MIN_CENTER_X || center > MAX_CENTER_X) return 'Vá para o meio da imagem';
  return undefined;
}

/** The arm pump needs both wrists in the picture. */
export function handsHidden(snapshot: PoseSnapshot): boolean {
  return [15, 16].some((index) => !visibleImagePoint(snapshot.landmarks[index], 0.3));
}

/**
 * Both hands raised to the shoulders or higher. Not above the head: a close webcam cuts that off,
 * and a hand out of the picture cannot be seen at all.
 */
export function handsRaised(snapshot: PoseSnapshot): boolean {
  return ([[15, 11], [16, 12]] as const).every(([wrist, shoulder]) => {
    const hand = snapshot.landmarks[wrist];
    const base = snapshot.landmarks[shoulder];
    return hand !== undefined && base !== undefined && (hand.visibility ?? 0) >= 0.5 && hand.y < base.y;
  });
}

/**
 * The serve toss: one hand lifted to the height of the face or higher, the other one down. Either
 * hand counts — the other one is then the racket hand. Names are the player's own left and right.
 */
export function raisedTossHand(snapshot: PoseSnapshot): Hand | undefined {
  const nose = snapshot.landmarks[0];
  if (!nose) return undefined;
  const [left, right] = ([[15, 11], [16, 12]] as const).map(([wrist, shoulder]) => {
    const hand = snapshot.landmarks[wrist];
    const base = snapshot.landmarks[shoulder];
    const seen = hand !== undefined && base !== undefined && (hand.visibility ?? 0) >= 0.5;
    // "Face height" is a third of the way below the nose towards the shoulder.
    return { up: seen && hand.y < nose.y + (base.y - nose.y) / 3, raised: seen && hand.y < base.y };
  });
  if (left!.up && !right!.raised) return 'left';
  return right!.up && !left!.raised ? 'right' : undefined;
}

/**
 * Forearms crossed in an X before the chest: the way back to the menu. Each wrist sits clearly past
 * the other, below the shoulders (so it can never read as the raised hands that play again).
 */
export function armsCrossed(snapshot: PoseSnapshot): boolean {
  const [leftShoulder, rightShoulder, leftWrist, rightWrist] = [11, 12, 15, 16].map((index) => snapshot.landmarks[index]);
  if (!leftShoulder || !rightShoulder || !leftWrist || !rightWrist) return false;
  if ((leftWrist.visibility ?? 0) < 0.5 || (rightWrist.visibility ?? 0) < 0.5) return false;
  const width = Math.abs(leftShoulder.x - rightShoulder.x);
  const shoulderY = Math.min(leftShoulder.y, rightShoulder.y);
  // Facing the camera the right wrist is normally at the smaller x.
  return rightWrist.x - leftWrist.x > width * 0.25
    && [leftWrist, rightWrist].every((wrist) => wrist.y > shoulderY && wrist.y < shoulderY + width * 1.8);
}
