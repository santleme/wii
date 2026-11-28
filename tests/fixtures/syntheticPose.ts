import type { CalibrationProfile, Point3, PoseSnapshot } from '../../src/cv/protocol';

export function pose(timestampMs: number, options: {
  kneeLeft?: number;
  kneeRight?: number;
  hipRise?: number;
  wristLateral?: number;
  leftWristLateral?: number;
  wristVertical?: number;
  wristDepth?: number;
  leanRad?: number;
  /** Lateral displacement toward the player's own right, in image shoulder widths. */
  shiftUserRightSw?: number;
  confidence?: number;
  hiddenLandmarks?: readonly number[];
} = {}): PoseSnapshot {
  const points: Point3[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: options.confidence ?? 0.95, presence: options.confidence ?? 0.95 }));
  // Facing the camera, the player's right is toward image left — x decreases in the raw frame.
  const shift = (options.shiftUserRightSw ?? 0) * 0.14;
  const hipY = 0.55 - (options.hipRise ?? 0) * 0.4;
  // The head rides on the torso, as a real one does.
  points[0] = { ...points[0]!, x: 0.5 - shift, y: hipY - 0.48 };
  points[11] = { ...points[11]!, x: 0.43 - shift, y: hipY - 0.4 };
  points[12] = { ...points[12]!, x: 0.57 - shift, y: hipY - 0.4 };
  points[23] = { ...points[23]!, x: 0.46 - shift, y: hipY };
  points[24] = { ...points[24]!, x: 0.54 - shift, y: hipY };
  points[25] = { ...points[25]!, x: 0.46, y: hipY + 0.2 - (options.kneeLeft ?? 0) * 0.4 };
  points[26] = { ...points[26]!, x: 0.54, y: hipY + 0.2 - (options.kneeRight ?? 0) * 0.4 };
  points[27] = { ...points[27]!, x: 0.46, y: hipY + 0.4 };
  points[28] = { ...points[28]!, x: 0.54, y: hipY + 0.4 };
  points[15] = { ...points[15]!, x: 0.39 - shift, y: hipY - 0.12 };
  points[16] = { ...points[16]!, x: 0.61 - shift, y: hipY - 0.12 };
  // The same wrist motion in the image, exaggerated so that 0.3 reads as a full stroke (two shoulder widths).
  points[15] = { ...points[15]!, x: points[15]!.x - (options.leftWristLateral ?? 0) };
  points[16] = { ...points[16]!, x: points[16]!.x - (options.wristLateral ?? 0), y: points[16]!.y - (options.wristVertical ?? 0) * 0.62 };
  options.hiddenLandmarks?.forEach((index) => {
    if (points[index]) points[index] = { ...points[index]!, visibility: 0, presence: 0 };
  });

  // MediaPipe world axes: +x image right (the player's left), +y down.
  const world: Point3[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: options.confidence ?? 0.95, presence: options.confidence ?? 0.95 }));
  const leanOffset = Math.tan(options.leanRad ?? 0) * 0.4;
  world[11] = { ...world[11]!, x: 0.2 - leanOffset, y: -0.4 };
  world[12] = { ...world[12]!, x: -0.2 - leanOffset, y: -0.4 };
  world[15] = { ...world[15]!, x: 0.2 - (options.leftWristLateral ?? 0), y: 0.1 };
  world[16] = {
    ...world[16]!,
    x: -0.2 - (options.wristLateral ?? 0),
    y: 0.1 - (options.wristVertical ?? 0),
    z: options.wristDepth ?? 0,
  };
  world[23] = { ...world[23]!, x: 0.1, y: 0 };
  world[24] = { ...world[24]!, x: -0.1, y: 0 };
  world[25] = { ...world[25]!, x: 0.1, y: 0.45 };
  world[26] = { ...world[26]!, x: -0.1, y: 0.45 };
  world[27] = { ...world[27]!, x: 0.1, y: 0.9 };
  world[28] = { ...world[28]!, x: -0.1, y: 0.9 };
  return { timestampMs, landmarks: points, worldLandmarks: world, trackingState: 'tracked', bodyConfidence: options.confidence ?? 0.95, frameWidth: 1280, frameHeight: 720 };
}

export function rotateWorldYaw(snapshot: ReturnType<typeof pose>, radians: number) {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    ...snapshot,
    worldLandmarks: snapshot.worldLandmarks.map((point) => ({
      ...point,
      x: point.x * cosine + point.z * sine,
      z: -point.x * sine + point.z * cosine,
    })),
  };
}

export function poseWithWorldShoulderWidth(timestampMs: number, width: number, wristOffset = 0.1) {
  const snapshot = pose(timestampMs);
  const world = [...snapshot.worldLandmarks];
  world[11] = { ...world[11]!, x: width / 2 };
  world[12] = { ...world[12]!, x: -width / 2 };
  world[16] = { ...world[16]!, x: -width / 2 - wristOffset };
  return { ...snapshot, worldLandmarks: world };
}

export function calibration(): CalibrationProfile {
  return {
    version: 3, completedAtMs: 3000,
    world: { shoulderWidth: 0.4, readyWristLocal: { left: { x: 0, y: -1.25, z: 0 }, right: { x: 0, y: -1.25, z: 0 } } },
    image: { shoulderCenterX0: 0.5 },
    quality: { validFrameRatio: 1, medianConfidence: 0.95 },
  };
}

/** Translates the torso core (shoulders + hips) in image space, torso height unchanged. */
export function poseWithHipBounce(timestampMs: number, hipYOffset: number, confidence?: number, hipXOffset = 0) {
  const snapshot = pose(timestampMs, { confidence });
  const landmarks = snapshot.landmarks.map((point, index) =>
    [0, 11, 12, 23, 24].includes(index) ? { ...point, y: point.y + hipYOffset, x: point.x + hipXOffset } : point);
  return { ...snapshot, landmarks };
}
