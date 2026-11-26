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
  confidence?: number;
  hiddenLandmarks?: readonly number[];
} = {}): PoseSnapshot {
  const points: Point3[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: options.confidence ?? 0.95, presence: options.confidence ?? 0.95 }));
  const hipY = 0.55 - (options.hipRise ?? 0) * 0.4;
  points[11] = { ...points[11]!, x: 0.43, y: hipY - 0.4 };
  points[12] = { ...points[12]!, x: 0.57, y: hipY - 0.4 };
  points[23] = { ...points[23]!, x: 0.46, y: hipY };
  points[24] = { ...points[24]!, x: 0.54, y: hipY };
  points[25] = { ...points[25]!, x: 0.46, y: hipY + 0.2 - (options.kneeLeft ?? 0) * 0.4 };
  points[26] = { ...points[26]!, x: 0.54, y: hipY + 0.2 - (options.kneeRight ?? 0) * 0.4 };
  points[27] = { ...points[27]!, x: 0.46, y: hipY + 0.4 };
  points[28] = { ...points[28]!, x: 0.54, y: hipY + 0.4 };
  points[15] = { ...points[15]!, x: 0.39, y: hipY - 0.12 };
  points[16] = { ...points[16]!, x: 0.61, y: hipY - 0.12 };
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
  return { timestampMs, landmarks: points, worldLandmarks: world, trackingState: 'tracked', bodyConfidence: options.confidence ?? 0.95 };
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

/** Rolls shoulders and wrists rigidly around the hip centre; positive is toward the player's right. */
export function rollUpperBody(snapshot: ReturnType<typeof pose>, radians: number) {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    ...snapshot,
    worldLandmarks: snapshot.worldLandmarks.map((point, index) => [11, 12, 15, 16].includes(index)
      ? { ...point, x: point.x * cosine + point.y * sine, y: -point.x * sine + point.y * cosine }
      : point),
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

const unit = (v: Point3): Point3 => { const m = Math.hypot(v.x, v.y, v.z); return { x: v.x / m, y: v.y / m, z: v.z / m }; };
const scaled = (v: Point3, k: number): Point3 => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const added = (a: Point3, b: Point3): Point3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const crossed = (a: Point3, b: Point3): Point3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

/**
 * Torso built from an explicit trunk-up direction — e.g. a tilted webcam tips the up axis in camera
 * space. `yawRad` turns the body about that axis; `leanRad` tilts the trunk toward the player's right.
 */
export function poseWithWorldTorso(
  timestampMs: number,
  options: { up?: Point3; down?: Point3; shinDown?: Point3; yawRad?: number; leanRad?: number } = {},
): PoseSnapshot {
  const snapshot = pose(timestampMs);
  const up = unit(options.up ?? { x: 0, y: -1, z: 0 });
  // Player-right reference flattened perpendicular to the trunk; valid for any non-sideways up.
  const side0 = unit({ x: up.x * up.x - 1, y: up.x * up.y, z: up.x * up.z });
  const yaw = options.yawRad ?? 0;
  const axis = added(scaled(side0, Math.cos(yaw)), scaled(crossed(up, side0), Math.sin(yaw)));
  const lean = options.leanRad ?? 0;
  const torsoDir = added(scaled(up, Math.cos(lean)), scaled(axis, Math.sin(lean)));
  const shoulderAxis = added(scaled(axis, Math.cos(lean)), scaled(up, -Math.sin(lean)));
  const shoulderMid = scaled(torsoDir, 0.4);
  // Gravity direction for the legs; defaults to under the trunk (standing upright).
  const down = options.down ? unit(options.down) : scaled(up, -1);
  const kneeMid = scaled(down, 0.45);
  const shinDown = options.shinDown ? unit(options.shinDown) : down;
  const ankleMid = added(kneeMid, scaled(shinDown, 0.45));
  const world = snapshot.worldLandmarks.map((point, index) => {
    if (index === 11) return { ...point, ...added(shoulderMid, scaled(shoulderAxis, -0.2)) };
    if (index === 12) return { ...point, ...added(shoulderMid, scaled(shoulderAxis, 0.2)) };
    if (index === 23) return { ...point, ...scaled(axis, -0.1) };
    if (index === 24) return { ...point, ...scaled(axis, 0.1) };
    if (index === 25) return { ...point, ...added(kneeMid, scaled(axis, -0.1)) };
    if (index === 26) return { ...point, ...added(kneeMid, scaled(axis, 0.1)) };
    if (index === 27) return { ...point, ...added(ankleMid, scaled(axis, -0.1)) };
    if (index === 28) return { ...point, ...added(ankleMid, scaled(axis, 0.1)) };
    return point;
  });
  return { ...snapshot, worldLandmarks: world };
}

export function calibration(): CalibrationProfile {
  return {
    version: 3, completedAtMs: 3000,
    world: { shoulderWidth: 0.4, leanUp0: { x: 0, y: -1, z: 0 }, torsoLeanRad0: 0, readyWristLocal: { left: { x: 0, y: -1.25, z: 0 }, right: { x: 0, y: -1.25, z: 0 } } },
    quality: { validFrameRatio: 1, medianConfidence: 0.95 },
  };
}

/** Translates the torso core (shoulders + hips) vertically in image space, torso height unchanged. */
export function poseWithHipBounce(timestampMs: number, hipYOffset: number, confidence?: number) {
  const snapshot = pose(timestampMs, { confidence });
  const landmarks = snapshot.landmarks.map((point, index) =>
    [11, 12, 23, 24].includes(index) ? { ...point, y: point.y + hipYOffset } : point);
  return { ...snapshot, landmarks };
}
