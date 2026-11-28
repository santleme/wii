/** Numerical state for the decorative surface. All buffers belong to one canvas instance. */
export type CrystalField = {
  cols: number;
  rows: number;
  heights: Float32Array;
  velocities: Float32Array;
  baseHeights: Float32Array;
  nextHeights: Float32Array;
};

export function createCrystalField(cols: number, rows: number): CrystalField {
  const size = cols * rows;
  return { cols, rows, heights: new Float32Array(size), velocities: new Float32Array(size), baseHeights: new Float32Array(size), nextHeights: new Float32Array(size) };
}

/** A faceted peak, with slow-moving strata across its planar faces. */
export function crystalHeight(x: number, y: number, time: number): number {
  const peak = Math.max(0, 1 - Math.max(Math.abs(x) * 1.05, Math.abs(y) * 0.8));
  const plane = Math.max(0, 1 - Math.abs(x + y * 0.42) * 1.5);
  return peak * 0.72 + plane * 0.22 + Math.sin(x * 7 + y * 4 - time * 0.35) * 0.035;
}

export function updateCrystalBase(field: CrystalField, time: number): void {
  const { cols, rows, baseHeights } = field;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      baseHeights[y * cols + x] = crystalHeight(x / (cols - 1) * 2 - 1, y / (rows - 1) * 2 - 1, time);
    }
  }
}

/** Simultaneous neighbor reads avoid directional bias in wave propagation. */
export function stepCrystal(field: CrystalField, dt: number): void {
  const { cols, rows, heights, velocities, baseHeights, nextHeights } = field;
  const step = Math.max(0, Math.min(dt, 0.033));
  const damping = Math.exp(-4.6 * step);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const displacement = heights[i] - baseHeights[i];
      let neighbors = 0;
      let count = 0;
      if (x > 0) { neighbors += heights[i - 1] - baseHeights[i - 1] - displacement; count++; }
      if (x + 1 < cols) { neighbors += heights[i + 1] - baseHeights[i + 1] - displacement; count++; }
      if (y > 0) { neighbors += heights[i - cols] - baseHeights[i - cols] - displacement; count++; }
      if (y + 1 < rows) { neighbors += heights[i + cols] - baseHeights[i + cols] - displacement; count++; }
      const velocity = (velocities[i] + (-32 * displacement + (count ? 60 * neighbors / count : 0)) * step) * damping;
      velocities[i] = velocity;
      nextHeights[i] = heights[i] + velocity * step;
    }
  }
  heights.set(nextHeights);
}

export function impulseCrystal(field: CrystalField, cx: number, cy: number, strength: number, radius: number): void {
  const { cols, rows, velocities } = field;
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(cols - 1, Math.ceil(cx + radius));
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(rows - 1, Math.ceil(cy + radius));
  const radius2 = radius * radius;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const distance2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (distance2 >= radius2) continue;
      const weight = 1 - distance2 / radius2;
      const i = y * cols + x;
      velocities[i] = Math.max(-5, Math.min(5, velocities[i] + strength * weight * weight));
    }
  }
}
