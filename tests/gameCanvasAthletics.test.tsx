// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { AthleticsHudState } from '../src/games/athletics/AthleticsGame';
import { GameCanvas } from '../src/ui/GameCanvas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const athletics = vi.hoisted(() => ({ updateHud: undefined as ((state: AthleticsHudState) => void) | undefined }));

vi.mock('../src/games/athletics/AthleticsGame', () => ({
  AthleticsGame: class {
    constructor(_canvas: HTMLCanvasElement, updateHud: (state: AthleticsHudState) => void) { athletics.updateHud = updateHud; }
    dispose(): void {}
  },
}));

it('labels estimated finish times until the race results are complete', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<GameCanvas sport="athletics" onEngine={() => {}} tracking="TRACKING" />); });
    const hud: AthleticsHudState = {
      score: 100, label: '0:14.0', speed01: 0, status: 'Chegada!',
      finished: {
        title: 'PROVA EM ANDAMENTO', detail: '0:14.0 nos 100 m', standingsFinal: false, restart01: 0,
        standings: [
          { name: 'Você', time: '0:14.0', you: true, status: 'confirmed', place: 1 },
          { name: 'Bia', time: '0:20.0', you: false, status: 'estimated', place: 2 },
        ],
      },
    };
    await act(async () => { athletics.updateHud!(hud); });
    expect(container.textContent).toContain('Classificação em andamento');
    expect(container.textContent).toContain('0:20.0 (estimado)');
    await act(async () => { athletics.updateHud!({ ...hud, finished: {
      ...hud.finished!, title: 'VOCÊ VENCEU!', standingsFinal: true,
      standings: hud.finished!.standings.map((runner) => ({ ...runner, status: 'confirmed' })),
    } }); });
    expect(container.textContent).toContain('VOCÊ VENCEU!');
    expect(container.textContent).not.toContain('(estimado)');
    expect(container.textContent).not.toContain('Classificação em andamento');
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
