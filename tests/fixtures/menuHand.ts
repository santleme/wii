import type { Point3 } from '@wii/spatial-core';
import type { MenuHandSnapshot } from '../../src/kinematics/handCursor';

export interface SyntheticHandOptions {
  tipX?: number;
  tipY?: number;
  pinchRatio?: number;
  curl?: number;
  /** Bends the index finger alone; defaults to `curl`. */
  indexCurl?: number;
  scale?: number;
  dx?: number;
  dy?: number;
}

const point = (x: number, y: number): Point3 => ({ x, y, z: 0 });
const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
const morph = (open: Point3, closed: Point3, progress: number): Point3 => ({
  x: lerp(open.x, closed.x, progress),
  y: lerp(open.y, closed.y, progress),
  z: 0,
});

interface Chain {
  mcp: number;
  pip: number;
  dip: number;
  tip: number;
}

const CHAINS: readonly Chain[] = [
  { mcp: 5, pip: 6, dip: 7, tip: 8 },
  { mcp: 9, pip: 10, dip: 11, tip: 12 },
  { mcp: 13, pip: 14, dip: 15, tip: 16 },
  { mcp: 17, pip: 18, dip: 19, tip: 20 },
];

/** Parametric 21-landmark hand. tipX/tipY are raw camera coordinates of the MIDDLE_MCP (#9) pointer anchor before mirroring. */
export function hand(timestampMs: number, options: SyntheticHandOptions = {}): MenuHandSnapshot {
  const scale = options.scale ?? 0.1;
  const curl = options.curl ?? 0;
  const indexCurl = options.indexCurl ?? curl;
  const anchorX = (options.tipX ?? 0.5) + (options.dx ?? 0);
  const anchorY = (options.tipY ?? 0.5) + (options.dy ?? 0);
  const landmarks: Point3[] = Array.from({ length: 21 }, () => point(0, 0));

  // In the open hand the index chain is one palm-scale long and vertical.
  // The construction is anchored on the index chain; a uniform shift below centers MIDDLE_MCP instead.
  const indexTipOpen = point(anchorX, anchorY - 0.5 * scale);
  const indexMcpOpen = point(anchorX, anchorY + 0.5 * scale);
  const wrist = point(indexMcpOpen.x + 0.35 * scale, indexMcpOpen.y + 0.95 * scale);
  landmarks[0] = wrist;
  landmarks[9] = point(wrist.x, wrist.y - scale);

  const placeFinger = (chain: Chain, mcpOpen: Point3) => {
    const bend = chain.tip === 8 ? indexCurl : curl;
    const curlDirection = mcpOpen.x <= wrist.x ? -1 : 1;
    const openPip = point(mcpOpen.x, mcpOpen.y - 0.45 * scale);
    const openDip = point(mcpOpen.x, mcpOpen.y - 0.75 * scale);
    const openTip = chain.tip === 8 ? indexTipOpen : point(mcpOpen.x, mcpOpen.y - scale);
    const closedPip = point(mcpOpen.x, mcpOpen.y - 0.42 * scale);
    const closedDip = point(mcpOpen.x + curlDirection * 0.22 * scale, mcpOpen.y - 0.25 * scale);
    const closedTip = point(mcpOpen.x + curlDirection * 0.3 * scale, mcpOpen.y + 0.05 * scale);
    landmarks[chain.mcp] = mcpOpen;
    landmarks[chain.pip] = morph(openPip, closedPip, bend);
    landmarks[chain.dip] = morph(openDip, closedDip, bend);
    landmarks[chain.tip] = chain.tip === 8 && bend === 0 ? indexTipOpen : morph(openTip, closedTip, bend);
  };

  placeFinger(CHAINS[0]!, indexMcpOpen);
  placeFinger(CHAINS[1]!, point(wrist.x, wrist.y - scale));
  placeFinger(CHAINS[2]!, point(wrist.x + 0.25 * scale, wrist.y - 0.9 * scale));
  placeFinger(CHAINS[3]!, point(wrist.x + 0.5 * scale, wrist.y - 0.75 * scale));

  landmarks[1] = point(wrist.x - 0.25 * scale, wrist.y - 0.25 * scale);
  landmarks[2] = point(wrist.x - 0.45 * scale, wrist.y - 0.45 * scale);
  landmarks[3] = point(wrist.x - 0.6 * scale, wrist.y - 0.6 * scale);
  landmarks[4] =
    options.pinchRatio === undefined
      ? point(wrist.x - 1.2 * scale, wrist.y - 0.2 * scale)
      : point(landmarks[8]!.x + options.pinchRatio * scale, landmarks[8]!.y);

  // Center MIDDLE_MCP (#9) on the anchor with a uniform shift, preserving all relative geometry.
  const shiftX = anchorX - landmarks[9]!.x;
  const shiftY = anchorY - landmarks[9]!.y;
  for (const landmark of landmarks) {
    landmark.x += shiftX;
    landmark.y += shiftY;
  }
  return { timestampMs, landmarks, handedness: 'Right' };
}

export function emptyHand(timestampMs: number): MenuHandSnapshot {
  return { timestampMs, landmarks: [], handedness: undefined };
}
