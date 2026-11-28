export interface OneEuroOptions {
  minCutoff?: number;
  beta?: number;
  derivativeCutoff?: number;
}

export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly derivativeCutoff: number;
  private previousFiltered?: number;
  private previousDerivative = 0;
  private previousTimeMs?: number;

  constructor(options: OneEuroOptions = {}) {
    this.minCutoff = options.minCutoff ?? 1;
    this.beta = options.beta ?? 0.5;
    this.derivativeCutoff = options.derivativeCutoff ?? 1;
  }

  filter(value: number, timestampMs: number): number {
    // A non-finite sample is no sample: storing it would poison every later output,
    // because NaN propagates through the derivative and low-pass state until reset().
    // With no finite sample yet, 0 is the neutral output — returning `value` here would leak the very non-finite sample this guard exists to reject.
    if (!Number.isFinite(value) || !Number.isFinite(timestampMs)) return this.previousFiltered ?? 0;
    if (this.previousFiltered === undefined || this.previousTimeMs === undefined) {
      this.previousFiltered = value;
      this.previousTimeMs = timestampMs;
      return value;
    }
    const dt = Math.max((timestampMs - this.previousTimeMs) / 1000, 1 / 120);
    const derivative = (value - this.previousFiltered) / dt;
    const filteredDerivative = this.lowPass(derivative, this.previousDerivative, this.derivativeCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(filteredDerivative);
    const filtered = this.lowPass(value, this.previousFiltered, cutoff, dt);
    this.previousDerivative = filteredDerivative;
    this.previousFiltered = filtered;
    this.previousTimeMs = timestampMs;
    return filtered;
  }

  reset(): void {
    this.previousFiltered = undefined;
    this.previousTimeMs = undefined;
    this.previousDerivative = 0;
  }

  private lowPass(value: number, previous: number, cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    const alpha = 1 / (1 + tau / dt);
    return alpha * value + (1 - alpha) * previous;
  }
}
