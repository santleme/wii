// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import App from '../src/App';
import { pose } from './fixtures/syntheticPose';
import type { PoseSnapshot } from '../src/cv/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const captures = vi.hoisted(() => ({
  gameProps: undefined as { onExit?: () => void; onEngine?: (engine: unknown) => void; sport: string; goal?: number; ironMan?: { onComplete: (result: { sport: 'athletics' | 'tennis' | 'boxing'; detail: string }) => void } } | undefined,
  onPose: undefined as ((snapshot: PoseSnapshot) => void) | undefined,
  handBegins: 0,
  handPauses: 0,
  poseBegins: 0,
  posePauses: 0,
}));

vi.mock('../src/ui/WiiSplash', () => ({ WiiSplash: () => null }));
vi.mock('../src/ui/PoseOverlay', () => ({ drawPose: vi.fn() }));

vi.mock('../src/ui/GameCanvas', async () => {
  const React = await import('react');
  return {
    GameCanvas: (props: typeof captures.gameProps) => {
      captures.gameProps = props;
      return React.createElement('div');
    },
  };
});

vi.mock('../src/cv/poseClient', () => ({
  PoseClient: class {
    static warmVisionAssets(): void {}
    readonly delegate = 'GPU';
    isReady = true;
    init(callbacks: { onPose(snapshot: PoseSnapshot): void }): Promise<void> { captures.onPose = callbacks.onPose; return Promise.resolve(); }
    beginCapture(): void { captures.poseBegins += 1; }
    pauseCapture(): void { captures.posePauses += 1; }
    dispose(): void {}
  },
}));

vi.mock('../src/cv/handClient', () => ({
  HandClient: class {
    static warmVisionAssets(): void {}
    isReady = true;
    init(): Promise<void> { return Promise.resolve(); }
    beginCapture(): void { captures.handBegins += 1; }
    pauseCapture(): void { captures.handPauses += 1; }
    dispose(): void {}
  },
}));

it('switches the camera back to hand tracking when play exits to the channel menu', async () => {
  const stream = new MediaStream();
  Object.assign(stream, { getTracks: () => [] });
  const getUserMedia = vi.fn(async () => stream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get: () => 2, configurable: true });
  Object.defineProperty(HTMLMediaElement, 'HAVE_CURRENT_DATA', { value: 2, configurable: true });
  window.matchMedia = (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
    expect(button, text).toBeDefined();
    await act(async () => { button!.click(); });
  };

  try {
    await act(async () => { root.render(<App />); });
    await click('ATIVAR CÂMERA');
    await act(flush);
    expect(captures.handBegins).toBe(1);

    await click('Tênis'); // brings the card to the front
    await click('Tênis');
    await act(flush);
    expect(captures.gameProps).toBeDefined();
    expect(captures.poseBegins).toBe(1);
    expect(captures.handPauses).toBe(1);

    const engine = { onAction: vi.fn(), setPoseTracking: vi.fn(), setDodgeZone: vi.fn(), setGuard: vi.fn(), setDuck: vi.fn(), setDepthMove: vi.fn(), setDepthSpeed: vi.fn() };
    captures.gameProps?.onEngine?.(engine);
    await act(async () => { captures.onPose?.(pose(1234)); });
    for (const setter of [engine.setPoseTracking, engine.setDodgeZone, engine.setGuard, engine.setDuck, engine.setDepthMove, engine.setDepthSpeed]) expect(setter.mock.calls.at(-1)?.[1]).toBe(1234);
    expect(engine.setPoseTracking.mock.invocationCallOrder[0]).toBeLessThan(engine.setGuard.mock.invocationCallOrder[0]!);
    await act(async () => {
      captures.onPose?.(pose(1300));
      captures.onPose?.(pose(1400));
      const missing = pose(10000);
      captures.onPose?.({ ...missing, landmarks: [], worldLandmarks: [] });
      captures.onPose?.(pose(10001));
      captures.onPose?.(pose(10002));
      captures.onPose?.(pose(10003));
    });
    expect(engine.setPoseTracking.mock.calls.map((args) => args[1])).toEqual([1234, 1300, 1400, 10000, 10001, 10002, 10003]);
    expect(engine.setPoseTracking.mock.calls.map((args) => args[0])).toEqual([
      'PROCURANDO', 'PROCURANDO', expect.stringContaining('TRACKING'), 'SEM POSE', 'PROCURANDO', 'PROCURANDO', expect.stringContaining('TRACKING'),
    ]);
    for (let index = 0; index < 7; index += 1) {
      expect(engine.setPoseTracking.mock.invocationCallOrder[index]).toBeLessThan(engine.setGuard.mock.invocationCallOrder[index]!);
    }

    await act(async () => { captures.gameProps?.onExit?.(); });
    await act(flush);
    expect(captures.posePauses).toBe(1);
    expect(captures.handBegins).toBe(2);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});


it('runs the three Iron Man stages in order, shows the summary, and discards a cancelled challenge', async () => {
  window.matchMedia = (query: string) => ({ matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const start = async () => act(async () => { container.querySelector<HTMLButtonElement>('.channel.sports')!.click(); });
  const finish = async (sport: 'athletics' | 'tennis' | 'boxing', detail: string) => act(async () => {
    captures.gameProps!.ironMan!.onComplete({ sport, detail });
  });
  try {
    await act(async () => root.render(<App />));
    await start();
    expect(captures.gameProps).toMatchObject({ sport: 'athletics', goal: 100 });
    await finish('athletics', '15 segundos · 2º lugar');
    expect(captures.gameProps?.sport).toBe('tennis');
    await finish('tennis', 'Derrota · 0 × 2 games');
    expect(captures.gameProps?.sport).toBe('boxing');
    await finish('boxing', 'Empate');
    expect(container.textContent).toContain('Iron Man concluído!');
    expect(container.textContent).toContain('15 segundos · 2º lugar');
    expect(container.textContent).toContain('Derrota · 0 × 2 games');
    expect(container.textContent).toContain('Empate');
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Voltar ao menu')!.click());
    await start();
    await finish('athletics', 'Outro resultado');
    await act(async () => captures.gameProps!.onExit!());
    await start();
    expect(captures.gameProps).toMatchObject({ sport: 'athletics', goal: 100 });
    expect(container.textContent).toContain('ETAPA 1 DE 3');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
