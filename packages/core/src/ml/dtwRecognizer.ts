export type FeatureSequence = readonly (readonly number[])[];

export interface DtwRecognizerOptions {
  targetFrames?: number;
  bandWidth?: number;
  minSegmentRatio?: number;
  maxDistance?: number;
  minMargin?: number;
  /** Positive gestures must be this fraction or less of the closest null distance. */
  nullSeparationRatio?: number;
  maxExamplesPerLabel?: number;
}

export interface GesturePrediction {
  label: string;
  distance: number;
  nullDistance: number;
  margin?: number;
}

export const NULL_GESTURE_LABEL = '__null__';

const DEFAULT_TARGET_FRAMES = 20;
const DEFAULT_BAND_WIDTH = 4;
const DEFAULT_MIN_SEGMENT_RATIO = 0.5;
const DEFAULT_MAX_DISTANCE = 0.35;
const DEFAULT_MIN_MARGIN = 0.05;
const DEFAULT_NULL_SEPARATION_RATIO = 0.85;
const DEFAULT_MAX_EXAMPLES_PER_LABEL = 5;

function validateSequence(sequence: FeatureSequence): number {
  if (sequence.length === 0) throw new RangeError('A gesture sequence must contain at least one frame.');
  const dimension = sequence[0]!.length;
  if (
    dimension === 0 ||
    sequence.some((frame) => frame.length !== dimension || frame.some((value) => !Number.isFinite(value)))
  ) {
    throw new RangeError('Gesture frames must have a fixed, non-zero dimension and finite values.');
  }
  return dimension;
}

function resample(sequence: FeatureSequence, targetFrames: number): number[][] {
  validateSequence(sequence);
  if (sequence.length === targetFrames) return sequence.map((frame) => [...frame]);
  if (targetFrames === 1) return [[...sequence[0]!]];
  if (sequence.length === 1) return Array.from({ length: targetFrames }, () => [...sequence[0]!]);

  const result: number[][] = [];
  for (let targetIndex = 0; targetIndex < targetFrames; targetIndex += 1) {
    const sourcePosition = (targetIndex * (sequence.length - 1)) / (targetFrames - 1);
    const lowerIndex = Math.floor(sourcePosition);
    const upperIndex = Math.min(sequence.length - 1, lowerIndex + 1);
    const amount = sourcePosition - lowerIndex;
    result.push(
      sequence[lowerIndex]!.map(
        (value, featureIndex) => value * (1 - amount) + sequence[upperIndex]![featureIndex]! * amount,
      ),
    );
  }
  return result;
}

function frameDistance(a: readonly number[], b: readonly number[]): number {
  let squaredDistance = 0;
  for (let index = 0; index < a.length; index += 1) squaredDistance += (a[index]! - b[index]!) ** 2;
  return Math.sqrt(squaredDistance / a.length);
}

/** Banded DTW with a scaled Sakoe-Chiba corridor; returns mean per-frame distance. */
export function bandedDtwDistance(
  a: FeatureSequence,
  b: FeatureSequence,
  bandWidth = DEFAULT_BAND_WIDTH,
): number | undefined {
  const dimensionA = validateSequence(a);
  const dimensionB = validateSequence(b);
  if (dimensionA !== dimensionB) throw new RangeError('DTW sequences must have matching feature dimensions.');
  if (!Number.isInteger(bandWidth) || bandWidth < 0)
    throw new RangeError('DTW band width must be a non-negative integer.');
  return bandedDtwDistanceValidated(a, b, bandWidth);
}

function bandedDtwDistanceValidated(a: FeatureSequence, b: FeatureSequence, bandWidth: number): number | undefined {
  const rows = a.length;
  const columns = b.length;
  let previous = new Float64Array(columns + 1);
  previous.fill(Number.POSITIVE_INFINITY);
  previous[0] = 0;
  let current = new Float64Array(columns + 1);

  for (let row = 1; row <= rows; row += 1) {
    current.fill(Number.POSITIVE_INFINITY);
    const center = (row * columns) / rows;
    const start = Math.max(1, Math.ceil(center - bandWidth));
    const end = Math.min(columns, Math.floor(center + bandWidth));
    for (let column = start; column <= end; column += 1) {
      const previousCost = Math.min(previous[column]!, current[column - 1]!, previous[column - 1]!);
      if (Number.isFinite(previousCost)) {
        current[column] = frameDistance(a[row - 1]!, b[column - 1]!) + previousCost;
      }
    }
    const reusable = previous;
    previous = current;
    current = reusable;
  }

  return Number.isFinite(previous[columns]) ? previous[columns]! / Math.max(rows, columns) : undefined;
}

/**
 * Few-shot dynamic gesture matcher. It searches suffix subsequences of recent frames and compares
 * each candidate with banded DTW. A trained null class and distance margins reject idle/random motion.
 */
export class DtwGestureRecognizer {
  private readonly targetFrames: number;
  private readonly bandWidth: number;
  private readonly minSegmentRatio: number;
  private readonly maxDistance: number;
  private readonly minMargin: number;
  private readonly nullSeparationRatio: number;
  private readonly maxExamplesPerLabel: number;
  private readonly templates = new Map<string, number[][][]>();
  private featureDimension?: number;

  constructor(options: DtwRecognizerOptions = {}) {
    this.targetFrames = options.targetFrames ?? DEFAULT_TARGET_FRAMES;
    this.bandWidth = options.bandWidth ?? DEFAULT_BAND_WIDTH;
    this.minSegmentRatio = options.minSegmentRatio ?? DEFAULT_MIN_SEGMENT_RATIO;
    this.maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
    this.minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN;
    this.nullSeparationRatio = options.nullSeparationRatio ?? DEFAULT_NULL_SEPARATION_RATIO;
    this.maxExamplesPerLabel = options.maxExamplesPerLabel ?? DEFAULT_MAX_EXAMPLES_PER_LABEL;

    if (!Number.isInteger(this.targetFrames) || this.targetFrames < 2)
      throw new RangeError('targetFrames must be at least 2.');
    if (!Number.isInteger(this.bandWidth) || this.bandWidth < 1)
      throw new RangeError('bandWidth must be a positive integer.');
    if (!Number.isFinite(this.minSegmentRatio) || this.minSegmentRatio <= 0 || this.minSegmentRatio > 1) {
      throw new RangeError('minSegmentRatio must be in the interval (0, 1].');
    }
    if (!Number.isFinite(this.maxDistance) || this.maxDistance <= 0)
      throw new RangeError('maxDistance must be positive.');
    if (!Number.isFinite(this.minMargin) || this.minMargin < 0) throw new RangeError('minMargin cannot be negative.');
    if (!Number.isFinite(this.nullSeparationRatio) || this.nullSeparationRatio <= 0 || this.nullSeparationRatio >= 1) {
      throw new RangeError('nullSeparationRatio must be between 0 and 1.');
    }
    if (!Number.isInteger(this.maxExamplesPerLabel) || this.maxExamplesPerLabel < 1) {
      throw new RangeError('maxExamplesPerLabel must be a positive integer.');
    }
  }

  get labels(): readonly string[] {
    return [...this.templates.keys()].filter((label) => label !== NULL_GESTURE_LABEL);
  }

  get hasNullClass(): boolean {
    return this.templates.has(NULL_GESTURE_LABEL);
  }

  addExample(label: string, sequence: FeatureSequence): number {
    const normalizedLabel = label.trim();
    if (!normalizedLabel || normalizedLabel === NULL_GESTURE_LABEL) {
      throw new RangeError(`Gesture label must be non-empty and cannot be ${NULL_GESTURE_LABEL}.`);
    }
    return this.storeExample(normalizedLabel, sequence);
  }

  addNullExample(sequence: FeatureSequence): number {
    return this.storeExample(NULL_GESTURE_LABEL, sequence);
  }

  /** Returns the closest suffix distance per trained class for live inspection and threshold tuning. */
  measure(recentFrames: FeatureSequence): ReadonlyMap<string, number> | undefined {
    if (this.templates.size === 0 || recentFrames.length === 0) return undefined;
    const dimension = validateSequence(recentFrames);
    if (dimension !== this.featureDimension)
      throw new RangeError('Gesture feature dimension does not match the trained templates.');
    const window = recentFrames.slice(-this.targetFrames);
    const minimumLength = Math.max(2, Math.ceil(this.targetFrames * this.minSegmentRatio));
    if (window.length < minimumLength) return undefined;

    const maximumCandidateLength = Math.min(window.length, this.targetFrames);
    const candidateLengths = [
      ...new Set([minimumLength, Math.round((minimumLength + maximumCandidateLength) / 2), maximumCandidateLength]),
    ];
    const candidates = candidateLengths.map((length) => window.slice(window.length - length));
    const distances = new Map<string, number>();
    for (const [label, templates] of this.templates) {
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const template of templates) {
        for (const candidate of candidates) {
          const distance = bandedDtwDistanceValidated(template, candidate, this.bandWidth);
          if (distance !== undefined && distance < bestDistance) bestDistance = distance;
        }
      }
      // No finite distance means no candidate matched this label at all: omit it, so the
      // map never leaks Infinity into recognize()'s ranking or the null-separation gate.
      if (Number.isFinite(bestDistance)) distances.set(label, bestDistance);
    }
    return distances;
  }

  recognize(recentFrames: FeatureSequence): GesturePrediction | undefined {
    if (!this.hasNullClass || this.labels.length === 0) return undefined;
    const distances = this.measure(recentFrames);
    if (!distances) return undefined;

    const nullDistance = distances.get(NULL_GESTURE_LABEL) ?? Number.POSITIVE_INFINITY;
    const ranked = [...distances.entries()]
      .filter(([label]) => label !== NULL_GESTURE_LABEL)
      .map(([label, distance]) => ({ label, distance }))
      .sort((a, b) => a.distance - b.distance);
    const best = ranked[0];
    if (!best || best.distance > this.maxDistance || best.distance >= nullDistance * this.nullSeparationRatio) {
      return undefined;
    }
    const margin = ranked.length > 1 ? ranked[1]!.distance - best.distance : Number.POSITIVE_INFINITY;
    if (ranked.length > 1 && margin < this.minMargin) return undefined;
    return {
      ...best,
      nullDistance,
      ...(ranked.length > 1 ? { margin } : {}),
    };
  }

  exampleCount(label: string): number {
    return this.templates.get(label.trim())?.length ?? 0;
  }

  removeLabel(label: string): boolean {
    const removed = this.templates.delete(label.trim());
    if (this.templates.size === 0) this.featureDimension = undefined;
    return removed;
  }

  clear(): void {
    this.templates.clear();
    this.featureDimension = undefined;
  }

  private storeExample(label: string, sequence: FeatureSequence): number {
    const dimension = validateSequence(sequence);
    if (this.featureDimension !== undefined && dimension !== this.featureDimension) {
      throw new RangeError('Gesture feature dimension changed between examples.');
    }
    const template = resample(sequence, this.targetFrames);
    const examples = this.templates.get(label) ?? [];
    examples.push(template);
    if (examples.length > this.maxExamplesPerLabel) examples.shift();
    this.templates.set(label, examples);
    this.featureDimension = dimension;
    return examples.length;
  }
}
