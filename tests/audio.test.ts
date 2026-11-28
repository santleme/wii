import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProceduralAudio } from '../src/games/audio';

function fakeParam(initial = 0) {
  return {
    value: initial,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
}

class FakeAudioContext {
  state = 'running';
  currentTime = 1;
  sampleRate = 8000;
  destination = { name: 'destination' };
  oscillators: {
    type: string;
    frequency: ReturnType<typeof fakeParam>;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  gains: { gain: ReturnType<typeof fakeParam>; connect: ReturnType<typeof vi.fn> }[] = [];
  filters: {
    type: string;
    frequency: ReturnType<typeof fakeParam>;
    Q: ReturnType<typeof fakeParam>;
    connect: ReturnType<typeof vi.fn>;
  }[] = [];
  bufferSources: {
    buffer: unknown;
    loop: boolean;
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  buffers: { channels: number; length: number; sampleRate: number; data: Float32Array }[] = [];

  createOscillator() {
    const oscillator = {
      type: 'sine',
      frequency: fakeParam(),
      connect: vi.fn((target: unknown) => target),
      start: vi.fn(),
      stop: vi.fn(),
    };
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain() {
    const gain = {
      gain: fakeParam(),
      connect: vi.fn((target: unknown) => target),
    };
    this.gains.push(gain);
    return gain;
  }

  createBiquadFilter() {
    const filter = {
      type: 'lowpass',
      frequency: fakeParam(),
      Q: fakeParam(1),
      connect: vi.fn((target: unknown) => target),
    };
    this.filters.push(filter);
    return filter;
  }

  createBufferSource() {
    const source = {
      buffer: null as unknown,
      loop: false,
      connect: vi.fn((target: unknown) => target),
      start: vi.fn(),
      stop: vi.fn(),
    };
    this.bufferSources.push(source);
    return source;
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    const buffer = {
      channels,
      length,
      sampleRate,
      getChannelData: vi.fn((channel: number) => {
        if (channel !== 0) throw new Error(`unexpected channel ${channel}`);
        return data;
      }),
    };
    this.buffers.push({ channels, length, sampleRate, data });
    return buffer;
  }

  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

function contextOf(audio: ProceduralAudio): FakeAudioContext {
  return (audio as unknown as { context: FakeAudioContext }).context;
}

afterEach(() => vi.unstubAllGlobals());

describe('ProceduralAudio tennis cues', () => {
  it('schedules bounce, success, failure and milestone cues through Web Audio', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const audio = new ProceduralAudio();
    await audio.unlock();

    audio.bounce(0.4);
    audio.success(0.8);
    audio.failure();
    audio.milestone();

    const context = audio as unknown as { context: FakeAudioContext };
    expect(context.context.oscillators).toHaveLength(8);
    expect(context.context.oscillators.every((oscillator) => oscillator.start.mock.calls.length === 1)).toBe(true);
    expect(context.context.oscillators.every((oscillator) => oscillator.stop.mock.calls.length === 1)).toBe(true);

    audio.setMuted(true);
    audio.bounce();
    expect(context.context.oscillators).toHaveLength(8);
    audio.dispose();
  });
});

describe('ProceduralAudio speech cancellation', () => {
  it('setMuted(true) and dispose() cancel speech already in progress', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', { cancel, speak: vi.fn() });
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(readonly text: string) {} });
    const audio = new ProceduralAudio();
    await audio.unlock();

    audio.say('Quinze a zero');
    cancel.mockClear(); // say() cancels before speaking; only the mute/dispose calls count below
    audio.setMuted(false);
    expect(cancel).not.toHaveBeenCalled();

    audio.setMuted(true);
    expect(cancel).toHaveBeenCalledTimes(1);

    audio.setMuted(false);
    audio.say('Trinta a zero');
    cancel.mockClear();
    audio.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('mute and dispose stay silent when speechSynthesis is unavailable', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const audio = new ProceduralAudio();
    await audio.unlock();
    expect(() => {
      audio.setMuted(true);
      audio.dispose();
    }).not.toThrow();
  });
});

describe('ProceduralAudio boxing cues', () => {
  it('does nothing before unlock or when AudioContext is unavailable', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const locked = new ProceduralAudio();
    expect(() => {
      locked.whoosh(1);
      locked.punchImpact(1, false);
      locked.bell('round');
      locked.crowdReact(1);
    }).not.toThrow();

    vi.unstubAllGlobals();
    const unavailable = new ProceduralAudio();
    await unavailable.unlock();
    expect(() => {
      unavailable.whoosh(1);
      unavailable.punchImpact(1, true);
      unavailable.bell('ko');
      unavailable.crowdReact(1);
    }).not.toThrow();
  });

  it('whoosh schedules filtered looping noise and reuses one cached buffer per context', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const audio = new ProceduralAudio();
    await audio.unlock();
    const context = contextOf(audio);

    audio.whoosh(0.5);

    expect(context.bufferSources).toHaveLength(1);
    expect(context.filters).toHaveLength(1);
    expect(context.filters[0].type).toBe('bandpass');
    const source = context.bufferSources[0];
    expect(source.buffer).not.toBeNull();
    expect(source.loop).toBe(true);
    expect(source.start).toHaveBeenCalledTimes(1);
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(source.stop.mock.calls[0][0]).toBeGreaterThan(source.start.mock.calls[0][0]);
    expect(context.gains[0].gain.exponentialRampToValueAtTime).toHaveBeenCalled();
    expect(context.filters[0].frequency.exponentialRampToValueAtTime).toHaveBeenCalled();

    audio.whoosh(0.9);
    expect(context.bufferSources).toHaveLength(2);
    expect(context.buffers).toHaveLength(1);
    audio.dispose();
  });

  it('punchImpact blocked and unblocked produce observably different scheduling', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const audio = new ProceduralAudio();
    await audio.unlock();
    const context = contextOf(audio);

    audio.punchImpact(0.7, false);
    audio.punchImpact(0.7, true);

    expect(context.oscillators).toHaveLength(2);
    expect(context.bufferSources).toHaveLength(2);
    expect(context.filters).toHaveLength(2);

    // the blocked transient is muffled: much lower filter cutoff than the landed punch
    const landedCutoff = context.filters[0].frequency.setValueAtTime.mock.calls[0][0];
    const blockedCutoff = context.filters[1].frequency.setValueAtTime.mock.calls[0][0];
    expect(landedCutoff).toBeGreaterThan(blockedCutoff);

    // the blocked body thump decays faster: the oscillator stops earlier
    const landedStop = context.oscillators[0].stop.mock.calls[0][0];
    const blockedStop = context.oscillators[1].stop.mock.calls[0][0];
    expect(landedStop).toBeGreaterThan(blockedStop);
    audio.dispose();
  });

  it('bell round and ko patterns are distinguishable and deterministic', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const audio = new ProceduralAudio();
    await audio.unlock();
    const context = contextOf(audio);

    audio.bell('round');
    // three strikes of three inharmonic partials each
    expect(context.oscillators).toHaveLength(9);
    audio.bell('ko');
    // one long strike of three partials
    expect(context.oscillators).toHaveLength(12);

    const starts = context.oscillators.map((osc) => osc.start.mock.calls[0][0]);
    // round strikes start staggered at 0, 0.22 and 0.44 seconds after currentTime (1)
    expect(starts[0]).toBeCloseTo(1, 5);
    expect(starts[3]).toBeCloseTo(1.22, 5);
    expect(starts[6]).toBeCloseTo(1.44, 5);
    // the ko partials all start together
    expect(starts[9]).toBeCloseTo(1, 5);
    expect(starts[10]).toBeCloseTo(1, 5);
    expect(starts[11]).toBeCloseTo(1, 5);
    // the ko ring sustains longer than any round strike
    const stops = context.oscillators.map((osc) => osc.stop.mock.calls[0][0]);
    expect(stops[9]).toBeGreaterThan(stops[6]);
    audio.dispose();
  });

  it('crowdReact scales with intensity and clamps invalid input deterministically', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const audio = new ProceduralAudio();
    await audio.unlock();
    const context = contextOf(audio);

    audio.crowdReact(0);
    audio.crowdReact(1);
    expect(context.oscillators).toHaveLength(0);
    expect(context.bufferSources).toHaveLength(2);

    const stopQuiet = context.bufferSources[0].stop.mock.calls[0][0];
    const stopLoud = context.bufferSources[1].stop.mock.calls[0][0];
    expect(stopLoud).toBeGreaterThan(stopQuiet);

    // out-of-range and NaN inputs clamp: 7 behaves like 1, NaN and -3 like 0
    audio.crowdReact(7);
    audio.crowdReact(Number.NaN);
    audio.crowdReact(-3);
    expect(context.bufferSources[2].stop.mock.calls[0][0]).toBeCloseTo(stopLoud, 10);
    expect(context.bufferSources[3].stop.mock.calls[0][0]).toBeCloseTo(stopQuiet, 10);
    expect(context.bufferSources[4].stop.mock.calls[0][0]).toBeCloseTo(stopQuiet, 10);

    // intensity also scales the peak gain of the envelope
    const peakQuiet = context.gains[0].gain.exponentialRampToValueAtTime.mock.calls[0][0];
    const peakLoud = context.gains[1].gain.exponentialRampToValueAtTime.mock.calls[0][0];
    expect(peakLoud).toBeGreaterThan(peakQuiet);
    audio.dispose();
  });

  it('setMuted(true) prevents scheduling of every boxing cue', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    const audio = new ProceduralAudio();
    await audio.unlock();
    const context = contextOf(audio);

    audio.setMuted(true);
    audio.whoosh(1);
    audio.punchImpact(1, false);
    audio.bell('round');
    audio.crowdReact(1);

    expect(context.oscillators).toHaveLength(0);
    expect(context.bufferSources).toHaveLength(0);
    expect(context.gains).toHaveLength(0);

    audio.setMuted(false);
    audio.whoosh(1);
    expect(context.bufferSources).toHaveLength(1);
    audio.dispose();
  });
});
