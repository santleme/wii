// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameHudState } from '../src/games/core/hud';

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

const { TennisGame } = await import('../src/games/tennis/TennisGame');

describe('TennisGame HUD publishing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('publishes the HUD once while nothing changes, and again when it does', () => {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const states: GameHudState[] = [];
    const game = new TennisGame(canvas, (state) => {
      states.push(state);
    });

    // Five 200 ms ticks with an unchanged HUD: only the first one may publish,
    // like TrackGame already dedupes — otherwise every tick re-renders React.
    vi.advanceTimersByTime(1000);
    expect(states).toHaveLength(1);

    // A visible change republishes exactly once, then silence resumes.
    (game as unknown as { status: string }).status = 'Novo status';
    vi.advanceTimersByTime(200);
    expect(states).toHaveLength(2);
    expect(states[1]!.status).toBe('Novo status');
    vi.advanceTimersByTime(1000);
    expect(states).toHaveLength(2);

    game.dispose();
    canvas.remove();
  });
});
