function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export class ProceduralAudio {
  private context?: AudioContext;
  private muted = false;
  private noiseBuffers = new WeakMap<AudioContext, AudioBuffer>();

  async unlock(): Promise<void> {
    try {
      if (!this.context) this.context = new AudioContext();
      if (this.context.state === 'suspended') await this.context.resume();
    } catch {
      this.context = undefined;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    // Muting also stops a call already speaking — the muted flag alone only gates new ones.
    if (muted && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }

  hit(power = 0.5): void {
    if (!this.context || this.muted) return;
    const now = this.context.currentTime;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    const amount = Math.max(0, Math.min(1, power));
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180 + amount * 130, now);
    osc.frequency.exponentialRampToValueAtTime(70, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18 + amount * 0.2, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(gain).connect(this.context.destination);
    osc.start(now); osc.stop(now + 0.17);
  }

  /** Racket on ball: a bright click of strings over the body of the hit. */
  racket(power = 0.5): void {
    this.hit(power);
    this.noise(0.05, 0.25 + 0.2 * power, 2600);
  }

  /** A short burst of applause. */
  cheer(intensity = 1): void {
    for (let clap = 0; clap < 40 * intensity; clap += 1) this.noise(0.04, 0.03 + Math.random() * 0.05, 1500 + Math.random() * 1500, Math.random() * 1.4);
  }

  /** The umpire's call, in the browser's own voice; silent where there is none. */
  say(text: string): void {
    if (this.muted || typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    const call = new SpeechSynthesisUtterance(text);
    call.lang = 'pt-BR';
    call.rate = 1.1;
    speechSynthesis.speak(call);
  }

  private noise(duration: number, volume: number, frequency: number, delay = 0): void {
    if (!this.context || this.muted) return;
    const startAt = this.context.currentTime + delay;
    const buffer = this.context.createBuffer(1, Math.ceil(this.context.sampleRate * duration), this.context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) samples[i] = (Math.random() * 2 - 1) * (1 - i / samples.length);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    const filter = this.context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    const gain = this.context.createGain();
    gain.gain.value = volume;
    source.connect(filter).connect(gain).connect(this.context.destination);
    source.start(startAt);
  }

  jump(): void { this.hit(0.25); }

  step(side: 'left' | 'right'): void {
    if (!this.context || this.muted) return;
    const now = this.context.currentTime;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(side === 'left' ? 92 : 82, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.07);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    osc.connect(gain).connect(this.context.destination);
    osc.start(now); osc.stop(now + 0.1);
  }

  bounce(intensity = 0.5): void {
    const amount = Math.max(0, Math.min(1, intensity));
    this.tone(88 + amount * 32, 0.07, 0.06 + amount * 0.05, 'sine');
  }

  success(intensity = 1): void {
    const amount = Math.max(0, Math.min(1, intensity));
    this.tone(440, 0.14, 0.08 + amount * 0.06, 'triangle');
    this.tone(660 + amount * 120, 0.18, 0.07 + amount * 0.06, 'triangle', 0.09);
  }

  failure(): void {
    this.tone(190, 0.16, 0.11, 'triangle');
    this.tone(130, 0.22, 0.09, 'triangle', 0.12);
  }

  milestone(): void {
    this.tone(523, 0.2, 0.12, 'triangle');
    this.tone(659, 0.2, 0.12, 'triangle', 0.12);
    this.tone(784, 0.28, 0.14, 'triangle', 0.24);
  }

  whoosh(power = 0.5): void {
    const amount = clamp01(power);
    const duration = 0.14 + amount * 0.12;
    this.noiseBurst({
      type: 'bandpass',
      frequency: 500 + amount * 300,
      endFrequency: 1800 + amount * 1200,
      q: 1.2,
      peak: 0.08 + amount * 0.16,
      attack: 0.03,
      duration,
    });
  }

  punchImpact(power = 0.5, blocked = false): void {
    if (!this.context || this.muted) return;
    const amount = clamp01(power);
    const now = this.context.currentTime;
    const bodyDuration = blocked ? 0.09 : 0.18;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime((blocked ? 120 : 160) + amount * 60, now);
    osc.frequency.exponentialRampToValueAtTime(blocked ? 70 : 45, now + bodyDuration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime((blocked ? 0.14 : 0.28) + amount * 0.15, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + bodyDuration);
    osc.connect(gain).connect(this.context.destination);
    osc.start(now);
    osc.stop(now + bodyDuration + 0.01);
    // transient: a bright snap when the punch lands, a muffled short slap when blocked
    this.noiseBurst({
      type: 'lowpass',
      frequency: blocked ? 700 : 2600 + amount * 800,
      peak: blocked ? 0.1 + amount * 0.08 : 0.16 + amount * 0.14,
      attack: 0.003,
      duration: blocked ? 0.05 : 0.09 + amount * 0.04,
    });
  }

  bell(kind: 'round' | 'ko'): void {
    if (kind === 'round') {
      // round bell: three quick dings
      this.bellStrike(0, 0.55, 0.16);
      this.bellStrike(0.22, 0.55, 0.16);
      this.bellStrike(0.44, 0.7, 0.18);
    } else {
      // knockout: one long sustained ring
      this.bellStrike(0, 1.9, 0.22);
    }
  }

  crowdReact(intensity = 0.5): void {
    const amount = clamp01(intensity);
    this.noiseBurst({
      type: 'bandpass',
      frequency: 900,
      q: 0.8,
      peak: 0.02 + amount * 0.16,
      attack: 0.08 + amount * 0.12,
      duration: 0.35 + amount * 0.85,
    });
  }

  private tone(frequency: number, duration: number, volume: number, type: OscillatorType, delay = 0): void {
    if (!this.context || this.muted) return;
    const startAt = this.context.currentTime + delay;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), startAt + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.01);
  }

  private bellStrike(delay: number, duration: number, volume: number): void {
    if (!this.context || this.muted) return;
    const startAt = this.context.currentTime + delay;
    // inharmonic partials of a small bell: frequency, relative gain, relative decay time
    const partials: readonly [number, number, number][] = [
      [1180, 1, 1],
      [1180 * 2.76, 0.45, 0.6],
      [1180 * 5.4, 0.2, 0.35],
    ];
    for (const [frequency, gainScale, durationScale] of partials) {
      const partialDuration = duration * durationScale;
      const osc = this.context.createOscillator();
      const gain = this.context.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(volume * gainScale, startAt + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + partialDuration);
      osc.connect(gain).connect(this.context.destination);
      osc.start(startAt);
      osc.stop(startAt + partialDuration + 0.01);
    }
  }

  private noiseBurst(options: {
    frequency: number;
    endFrequency?: number;
    type?: BiquadFilterType;
    q?: number;
    peak: number;
    attack: number;
    duration: number;
    delay?: number;
  }): void {
    if (!this.context || this.muted) return;
    const { frequency, endFrequency, type = 'bandpass', q = 1, peak, attack, duration, delay = 0 } = options;
    const startAt = this.context.currentTime + delay;
    const source = this.context.createBufferSource();
    source.buffer = this.noiseBuffer(this.context);
    source.loop = true;
    const filter = this.context.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(frequency, startAt);
    if (endFrequency !== undefined) filter.frequency.exponentialRampToValueAtTime(endFrequency, startAt + duration);
    filter.Q.value = q;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), startAt + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.context.destination);
    source.start(startAt);
    source.stop(startAt + duration + 0.01);
  }

  private noiseBuffer(context: AudioContext): AudioBuffer {
    const cached = this.noiseBuffers.get(context);
    if (cached) return cached;
    // one second of deterministic white noise, reused by every noise-based cue on this context
    const length = Math.floor(context.sampleRate);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let state = 0x2b5922c9;
    for (let i = 0; i < length; i++) {
      state = (Math.imul(state, 1103515245) + 12345) | 0;
      data[i] = (state >>> 9) / 0x400000 - 1;
    }
    this.noiseBuffers.set(context, buffer);
    return buffer;
  }

  dispose(): void {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    void this.context?.close();
    this.context = undefined;
  }
}
