import type { PunchKind, PunchMeasurement, PunchTargetZone } from '@wii/spatial-core';
import { clamp } from './math';

export interface PunchClassification {
  readonly punchKind: PunchKind;
  readonly targetZone: PunchTargetZone;
  /** Distance to the nearest decision boundary mapped to 0..1; intentionally conservative. */
  readonly confidence01: number;
}

interface ShapeFeatures {
  forwardTravel: number;
  verticalRise: number;
  lateralExcursion: number;
  pathLength: number;
}

function distance3(a: { lateral: number; vertical: number; forward: number }, b: { lateral: number; vertical: number; forward: number }): number {
  return Math.hypot(b.lateral - a.lateral, b.vertical - a.vertical, b.forward - a.forward);
}

/**
 * Shape over the punch's own course: from the onset sample — where the motion committed — to
 * the deepest extension in the frozen onset frame. Everything before the onset (the walked-back
 * origin exists only to measure confirmation travel) and after the contact (the retraction)
 * is somebody else's motion and does not describe the punch. Measuring in the frozen frame
 * keeps torso rotation from manufacturing lateral sweep that never happened in the world.
 */
function shapeFeatures(measurement: PunchMeasurement): ShapeFeatures {
  const samples = measurement.samples;
  const windowed = samples.filter((sample) => sample.frozen !== undefined);
  if (windowed.length < 2) {
    return {
      forwardTravel: measurement.forwardTravel,
      verticalRise: measurement.verticalRise,
      lateralExcursion: measurement.lateralExcursion,
      pathLength: measurement.pathLength,
    };
  }
  // At camera-realistic rates the onset fires near the physical extension peak, so the punch's
  // course lives mostly BEFORE it. The shape brackets itself: contact is the deepest frozen
  // extension in the whole measurement, and the start walks back while the forward motion is
  // uninterrupted — but never past an already-extended elbow, because a punch chambers bent and
  // anything extended behind it belongs to the previous motion.
  let contactIndex = 0;
  for (const [index, sample] of windowed.entries()) {
    if (sample.frozen!.forward > windowed[contactIndex]!.frozen!.forward) contactIndex = index;
  }
  let startIndex = contactIndex;
  for (let index = contactIndex - 1; index >= 0; index -= 1) {
    const sample = windowed[index]!;
    const next = windowed[index + 1]!;
    const cosine = (point: (typeof windowed)[number]) => point.rawElbowCosine ?? point.elbowCosine;
    const stillRising = next.frozen!.forward - sample.frozen!.forward > -0.05;
    // Within one punch the arm only un-extends walking backwards: an earlier sample MORE extended
    // than the one after it belongs to previous motion — the combination's earlier punch or plain
    // reconstruction noise, never to this punch's chamber.
    const unExtending = cosine(sample) <= cosine(next) + 0.1;
    if (!stillRising || !unExtending) break;
    startIndex = index;
  }
  const course = windowed.slice(startIndex, contactIndex + 1).map((sample) => sample.frozen!);
  const first = course[0]!;
  const contact = course.at(-1)!;
  let pathLength = 0;
  for (let index = 1; index < course.length; index += 1) pathLength += distance3(course[index - 1]!, course[index]!);
  return {
    forwardTravel: contact.forward - first.forward,
    verticalRise: Math.max(...course.map((point) => point.vertical)) - first.vertical,
    lateralExcursion: Math.max(...course.map((point) => point.lateral)) - Math.min(...course.map((point) => point.lateral)),
    pathLength,
  };
}

/**
 * Geometry-only first pass. `straight` is deliberately not named jab or cross here: that
 * distinction belongs to the player's stance, learned by the boxing tutorial.
 */
export function classifyPunch(measurement: PunchMeasurement): PunchClassification {
  const shape = shapeFeatures(measurement);
  const path = Math.max(shape.pathLength, 1e-6);
  const forwardShare = shape.forwardTravel / path;
  const verticalShare = shape.verticalRise / path;
  const lateralShare = shape.lateralExcursion / path;

  const uppercutScore = Math.min(shape.verticalRise / 0.18, verticalShare / 0.28, shape.forwardTravel / 0.12);
  const hookScore = Math.min(shape.lateralExcursion / 0.18, lateralShare / 0.24, (1 - forwardShare) / 0.35);
  const straightScore = Math.min(shape.forwardTravel / 0.22, forwardShare / 0.55, measurement.maxElbowCosine / 0.62);

  let punchKind: PunchKind = 'unknown';
  let score = 0;
  if (uppercutScore >= 1 && uppercutScore >= hookScore) {
    punchKind = 'uppercut';
    score = uppercutScore;
  } else if (hookScore >= 1 && hookScore >= straightScore * 0.8) {
    punchKind = 'hook';
    score = hookScore;
  } else if (straightScore >= 1) {
    punchKind = 'straight';
    score = straightScore;
  }

  const height = measurement.contact.vertical;
  let targetZone: PunchTargetZone = 'unknown';
  let targetMargin = 0;
  if (height >= -0.051) {
    targetZone = 'head';
    targetMargin = height + 0.05;
  } else if (height <= -0.3) {
    targetZone = 'body';
    targetMargin = -0.3 - height;
  }

  const confidence01 = clamp(Math.min(score / 1.8, 0.35 + targetMargin * 2, 1));
  return { punchKind, targetZone, confidence01 };
}
