import { describe, expect, it } from 'vitest';
import { RunGate } from '../src/games/track/runGate';

const run = (gate: RunGate, seconds: number) => {
  for (let i = 0; i < Math.round(seconds * 60); i += 1) gate.advance(1 / 60);
};

describe('run gate', () => {
  it('counts 3-2-1 before running', () => {
    const gate = new RunGate();
    expect([gate.phase, gate.count]).toEqual(['countdown', 3]);
    run(gate, 1.5);
    expect(gate.count).toBe(2);
    run(gate, 1.5);
    expect(gate.phase).toBe('running');
  });

  it('never pauses a player the camera has not seen', () => {
    const gate = new RunGate();
    run(gate, 3);
    gate.setTracking('SEM POSE');
    run(gate, 5);
    expect(gate.phase).toBe('running');
  });

  it('rides out a brief tracking loss without pausing', () => {
    const gate = new RunGate();
    gate.setTracking('TRACKING');
    run(gate, 3);
    gate.setTracking('SEM POSE');
    run(gate, 0.8);
    expect(gate.phase).toBe('running');
    gate.setTracking('TRACKING');
    run(gate, 0.5);
    expect(gate.phase).toBe('running');
  });

  it('pauses only after a sustained loss and resumes running without a countdown', () => {
    const gate = new RunGate();
    gate.setTracking('TRACKING');
    run(gate, 3);
    gate.setTracking('SEM POSE');
    run(gate, 1.2);
    expect(gate.phase).toBe('paused');
    gate.setTracking('PROCURANDO');
    expect(gate.phase).toBe('paused');
    gate.setTracking('TRACKING');
    // No re-onboarding after a transient: the run continues from where it froze.
    expect(gate.phase).toBe('running');
  });

  it('restarts the continuous-loss window when the body is glimpsed again', () => {
    const gate = new RunGate();
    gate.setTracking('TRACKING');
    run(gate, 3);
    gate.setTracking('SEM POSE');
    run(gate, 0.9);
    gate.setTracking('PROCURANDO');
    run(gate, 0.2);
    gate.setTracking('SEM POSE');
    run(gate, 0.9);
    // 0.9 + 0.9 s of loss, but never 1 s continuous — marginal tracking is not absence.
    expect(gate.phase).toBe('running');
    run(gate, 0.2);
    expect(gate.phase).toBe('paused');
  });

  it('resumes an interrupted countdown where it stopped, not from three', () => {
    const gate = new RunGate();
    gate.setTracking('TRACKING');
    run(gate, 2);
    gate.setTracking('SEM POSE');
    run(gate, 1.2);
    expect(gate.phase).toBe('paused');
    gate.setTracking('TRACKING');
    expect(gate.phase).toBe('countdown');
    // Two of the three seconds already elapsed before the pause — anything under 3 proves
    // the countdown was not restarted.
    expect(gate.count).toBeLessThan(3);
    run(gate, 1.2);
    expect(gate.phase).toBe('running');
  });

  it('pauses and resumes when the app includes the detected activity in its tracking label', () => {
    const gate = new RunGate();
    gate.setTracking('TRACKING · CORRIDA');
    run(gate, 3);
    gate.setTracking('SEM POSE');
    run(gate, 1.2);
    expect(gate.phase).toBe('paused');

    gate.setTracking('TRACKING · CORRIDA');
    expect(gate.phase).toBe('running');
  });

  it('lets a key leave the pause and stops waiting for the camera', () => {
    const gate = new RunGate();
    expect(gate.resumeByKey()).toBe(false);
    gate.setTracking('TRACKING');
    run(gate, 3);
    gate.setTracking('SEM POSE');
    run(gate, 1.2);
    expect(gate.phase).toBe('paused');
    expect(gate.resumeByKey()).toBe(true);
    expect(gate.phase).toBe('running');
    gate.setTracking('SEM POSE');
    run(gate, 5);
    expect(gate.phase).toBe('running');
  });
});
