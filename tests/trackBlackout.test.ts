// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { SportActionEvent } from '../src/cv/protocol';
import type { GameHudState } from '../src/games/track/TrackGame';

type UpdateFn = (dt: number, simulationTimeMs: number, wallTimeMs: number) => void;
const loopState = vi.hoisted(() => ({ update: undefined as UpdateFn | undefined }));

vi.mock('../src/games/core/GameLoop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/games/core/GameLoop')>();
  return {
    ...actual,
    GameLoop: class {
      constructor(...args: unknown[]) {
        loopState.update = args[3] as UpdateFn;
      }
      dispose(): void {}
    },
  };
});

const { TrackGame } = await import('../src/games/track/TrackGame');

function sprint(timestampMs: number, trackingState: SportActionEvent['trackingState'], speed01: number): SportActionEvent {
  return { id: timestampMs, timestampMs, confidence: 1, trackingState, source: 'cv', type: 'sprint', speed01, cadenceSpm: 150 };
}

describe('track blackout adjudication', () => {

  it('advances a keyboard jump after resuming a lost camera-paced run', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const game = new TrackGame(canvas, () => {});
    const update = loopState.update;
    expect(update).toBeDefined();
    let now = 1000;
    let nextEventId = 1;
    const step = (seconds: number, trackingState: SportActionEvent['trackingState'], speed01: number) => {
      const frames = Math.round(seconds * 60);
      for (let frame = 0; frame < frames; frame += 1) {
        now += 1000 / 60;
        if (frame % 5 === 0) game.onAction({ ...sprint(now, trackingState, speed01), id: nextEventId++ });
        update!(1 / 60, now, now);
      }
    };

    game.setTracking('TRACKING');
    step(3, 'tracked', 0);
    step(0.2, 'tracked', 1);
    game.setTracking('SEM POSE');
    step(1.1, 'lost', 0);
    expect((game as unknown as { gate: { phase: string } }).gate.phase).toBe('paused');
    game.onKey('ArrowLeft');
    game.onKey(' ');
    const internals = game as unknown as { jumpTime: number };
    const initialJumpTime = internals.jumpTime;
    expect(initialJumpTime).toBeGreaterThan(0);

    step(0.2, 'lost', 0);
    expect(internals.jumpTime).toBeLessThan(initialJumpTime);
    game.dispose();
    canvas.remove();
  });


  it('uses wall time to freeze camera adjudication after input goes silent', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    let hud: GameHudState | undefined;
    const game = new TrackGame(canvas, (state) => { hud = state; });
    const update = loopState.update;
    expect(update).toBeDefined();
    let now = 1000;
    let nextEventId = 1;
    const step = (seconds: number, trackingState: SportActionEvent['trackingState'], speed01: number) => {
      const frames = Math.round(seconds * 60);
      for (let frame = 0; frame < frames; frame += 1) {
        now += 1000 / 60;
        if (frame % 5 === 0) game.onAction({ ...sprint(now, trackingState, speed01), id: nextEventId++ });
        update!(1 / 60, now, now);
      }
    };

    game.setTracking('TRACKING');
    step(3, 'tracked', 0);
    game.onKey('ArrowLeft');
    step(1.2, 'tracked', 1);
    (game as unknown as { items: { z: number }[] }).items[0]!.z = -2;
    // Simulation time keeps ticking after a hidden-tab hitch, but wall time has jumped far
    // beyond the last sprint event. A simulation clock would keep driving into the hurdle.
    for (let frame = 0; frame < 120; frame += 1) {
      now += 1000 / 60;
      update!(1 / 60, now, now + 20_000);
    }
    expect(hud?.feedback?.kind).not.toBe('hit');
    game.dispose();
    canvas.remove();
  });

  it('preserves a same-lane hurdle while camera input coasts and judges it only after control returns', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    let hud: GameHudState | undefined;
    const game = new TrackGame(canvas, (state) => { hud = state; });
    const update = loopState.update;
    expect(update).toBeDefined();
    let now = 1000;
    let nextEventId = 1;
    const step = (seconds: number, trackingState: SportActionEvent['trackingState'], speed01: number) => {
      const frames = Math.round(seconds * 60);
      for (let frame = 0; frame < frames; frame += 1) {
        now += 1000 / 60;
        if (frame % 5 === 0) {
          game.onAction({ ...sprint(now, trackingState, speed01), id: nextEventId++ });
        }
        update!(1 / 60, now, now);
      }
    };

    game.setTracking('TRACKING');
    step(3, 'tracked', 0);
    game.onKey('ArrowLeft');
    step(1.2, 'tracked', 1);
    const publishHud = () => { (game as unknown as { publishHud: () => void }).publishHud(); };
    publishHud();
    const beforeBlackout = hud?.score;
    step(1, 'degraded', 0.45);
    publishHud();
    expect(hud?.feedback?.kind).not.toBe('hit');
    expect(hud?.score).toBe(beforeBlackout);

    step(0.8, 'tracked', 1);
    expect(hud?.feedback?.kind).toBe('hit');
    game.dispose();
    canvas.remove();
  });

  it('keeps visual track travel moving during a degraded coasting frame', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const game = new TrackGame(canvas, () => {});
    const update = loopState.update!;
    let now = 1000;
    let nextEventId = 1;
    const step = (seconds: number, trackingState: SportActionEvent['trackingState'], speed01: number) => {
      const frames = Math.round(seconds * 60);
      for (let frame = 0; frame < frames; frame += 1) {
        now += 1000 / 60;
        if (frame % 5 === 0) game.onAction({ ...sprint(now, trackingState, speed01), id: nextEventId++ });
        update(1 / 60, now, now);
      }
    };

    game.setTracking('TRACKING');
    step(3, 'tracked', 0);
    step(0.6, 'tracked', 0.9);
    const internals = game as unknown as { travelled: number };
    const travelledBefore = internals.travelled;
    for (let i = 0; i < 15; i += 1) step(1 / 60, 'degraded', 0.7);
    expect(internals.travelled).toBeGreaterThan(travelledBefore);
    game.dispose();
    canvas.remove();
  });
});
