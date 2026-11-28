// @vitest-environment happy-dom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Hand } from '../src/cv/protocol';
import type { GameHudState } from '../src/games/core/hud';
import { GameCanvas } from '../src/ui/GameCanvas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface TennisOptions {
  tutorial?: boolean;
  initialRacketHand?: Hand;
  onRacketHand?: (hand: Hand) => void;
  onStrokeTravel?: (travel: number) => void;
}

const tennisInstances = vi.hoisted(() => [] as { options?: TennisOptions; updateHud: (state: GameHudState) => void }[]);

vi.mock('../src/games/tennis/TennisGame', () => ({
  TennisGame: class {
    constructor(_canvas: HTMLCanvasElement, updateHud: (state: GameHudState) => void, _audio: unknown, options?: TennisOptions) {
      tennisInstances.push({ options, updateHud });
    }

    dispose(): void {}
  },
}));

it('polls the crossed-arms pose on the result screen until it exits play', async () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const crossedPose: { current: { active: boolean; atMs: number } | null } = { current: null };
  const onExit = vi.fn();
  tennisInstances.length = 0;

  try {
    await act(async () => {
      root.render(<GameCanvas sport="tennis" onEngine={() => {}} tracking="TRACKING" crossedPose={crossedPose} onExit={onExit} />);
    });
    await act(async () => {
      tennisInstances[0]!.updateHud({
        score: 0,
        label: '40 × 0',
        speed01: 0,
        status: 'VOCÊ VENCEU A PARTIDA!',
        tennis: {
          points: { player: '40', opponent: '0' },
          games: { player: 2, opponent: 0 },
          server: 'player',
          winner: 'player',
          secondServe: false,
          restart01: 0,
        },
      });
    });

    const advance = (ms: number, active: boolean) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 100) {
        crossedPose.current = { active, atMs: performance.now() };
        act(() => { vi.advanceTimersByTime(100); });
      }
    };
    advance(2100, false);
    expect(onExit).not.toHaveBeenCalled();
    advance(1600, true);
    expect(onExit).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
    container.remove();
  }
});

it('carries the racket hand learned in one tennis match into the rematch engine', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onEngine = () => {};
  tennisInstances.length = 0;

  try {
    await act(async () => {
      root.render(<GameCanvas sport="tennis" onEngine={onEngine} tracking="TRACKING" crossedPose={createRef()} />);
    });
    expect(tennisInstances).toHaveLength(1);
    expect(tennisInstances[0]!.options?.tutorial).toBe(true);

    tennisInstances[0]!.options?.onRacketHand?.('left');
    await act(async () => {
      tennisInstances[0]!.updateHud({
        score: 0,
        label: '40 × 0',
        speed01: 0,
        status: 'VOCÊ VENCEU A PARTIDA!',
        tennis: {
          points: { player: '40', opponent: '0' },
          games: { player: 2, opponent: 0 },
          server: 'player',
          winner: 'player',
          secondServe: false,
          restart01: 0,
        },
      });
    });
    const playAgain = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Jogar de novo');
    expect(playAgain).toBeDefined();
    await act(async () => {
      playAgain!.click();
    });

    expect(tennisInstances).toHaveLength(2);
    expect(tennisInstances[1]!.options?.tutorial).toBe(false);
    expect(tennisInstances[1]!.options?.initialRacketHand).toBe('left');
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});


it('shows the Iron Man result for ten seconds and advances once even after a loss', async () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onComplete = vi.fn();
  tennisInstances.length = 0;
  try {
    await act(async () => root.render(<GameCanvas sport="tennis" onEngine={() => {}} tracking="TRACKING" ironMan={{ onComplete }} />));
    await act(async () => tennisInstances[0]!.updateHud({
      score: 0, label: '', speed01: 0, status: 'Fim',
      tennis: { points: { player: '0', opponent: '0' }, games: { player: 0, opponent: 2 }, server: 'player', winner: 'opponent', secondServe: false, restart01: 1 },
    }));
    expect(container.textContent).toContain('Próxima modalidade em 10 s');
    expect(container.textContent).not.toContain('Jogar de novo');
    act(() => vi.advanceTimersByTime(9999));
    expect(onComplete).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onComplete).toHaveBeenCalledExactlyOnceWith({ sport: 'tennis', detail: 'Derrota · 0 × 2 games' });
    act(() => vi.advanceTimersByTime(5000));
    expect(onComplete).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    container.remove();
  }
});


it('cancels the Iron Man transition when the game unmounts', async () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  const root = createRoot(container);
  const onComplete = vi.fn();
  tennisInstances.length = 0;
  try {
    await act(async () => root.render(<GameCanvas sport="tennis" onEngine={() => {}} tracking="TRACKING" ironMan={{ onComplete }} />));
    await act(async () => tennisInstances[0]!.updateHud({
      score: 0, label: '', speed01: 0, status: 'Fim',
      tennis: { points: { player: '0', opponent: '0' }, games: { player: 2, opponent: 0 }, server: 'player', winner: 'player', secondServe: false, restart01: 0 },
    }));
    act(() => vi.advanceTimersByTime(5000));
    await act(async () => root.unmount());
    act(() => vi.advanceTimersByTime(10000));
    expect(onComplete).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
