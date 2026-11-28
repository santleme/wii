// @vitest-environment happy-dom
import { act, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  handInit: vi.fn(),
  handCallbacks: null as null | { onStatus(status: string, detail: string): void },
  poseInit: vi.fn(),
}));

vi.mock('../src/cv/handClient', () => ({
  HandClient: class {
    isReady = true;

    init(callbacks: { onStatus(status: string, detail: string): void }): Promise<void> {
      harness.handCallbacks = callbacks;
      return harness.handInit();
    }

    beginCapture(): void {}
    pauseCapture(): void {}
    dispose(): void {}

    static warmVisionAssets(): void {}
  },
}));

vi.mock('../src/cv/poseClient', () => ({
  PoseClient: class {
    isReady = true;

    init(): Promise<void> {
      return harness.poseInit();
    }

    beginCapture(): void {}
    pauseCapture(): void {}
    dispose(): void {}

    static warmVisionAssets(): void {}
  },
}));

vi.mock('../src/games/audio', () => ({
  ProceduralAudio: class {
    setMuted(): void {}
    unlock(): Promise<void> {
      return Promise.resolve();
    }
    jump(): void {}
    step(): void {}
    dispose(): void {}
  },
}));

vi.mock('../src/ui/PoseOverlay', () => ({ drawPose: vi.fn() }));
vi.mock('../src/ui/HandCursor', () => ({ HandCursor: () => null }));
vi.mock('../src/ui/GameCanvas', () => ({ GameCanvas: () => null }));
vi.mock('../src/ui/WiiSplash', () => ({ WiiSplash: () => null }));

vi.mock('../src/ui/WiiMenu', async () => {
  const React = await import('react');
  return {
    HomeMenu: ({ onGames }: { onGames(): void }) =>
      React.createElement('button', { 'data-testid': 'home-to-games', onClick: onGames }),
    GamesMenu: ({ onPick }: { onPick(sport: 'track' | 'athletics' | 'tennis'): void }) =>
      React.createElement('button', { 'data-testid': 'start-athletics', onClick: () => onPick('athletics') }),
  };
});

vi.mock('../src/ui/CameraPip', async () => {
  const React = await import('react');
  return {
    CameraPip: ({
      videoRef,
      cameraOn,
      status,
      onStart,
      onStop,
    }: {
      videoRef: RefObject<HTMLVideoElement | null>;
      cameraOn: boolean;
      status: string;
      onStart(): void;
      onStop(): void;
    }) =>
      React.createElement(
        'div',
        null,
        React.createElement('video', { ref: videoRef }),
        React.createElement('button', {
          'data-testid': cameraOn ? 'stop-camera' : 'start-camera',
          onClick: cameraOn ? onStop : onStart,
        }),
        React.createElement('output', { 'data-testid': 'camera-status' }, status),
      ),
  };
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('App camera phase', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalSrcObject: PropertyDescriptor | undefined;
  let originalReadyState: PropertyDescriptor | undefined;
  let originalHaveCurrentData: PropertyDescriptor | undefined;

  beforeEach(() => {
    harness.handInit.mockResolvedValue(undefined);
    harness.poseInit.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    if (originalSrcObject) Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', originalSrcObject);
    else Reflect.deleteProperty(HTMLMediaElement.prototype, 'srcObject');
    if (originalReadyState) Object.defineProperty(HTMLMediaElement.prototype, 'readyState', originalReadyState);
    else Reflect.deleteProperty(HTMLMediaElement.prototype, 'readyState');
    if (originalHaveCurrentData) Object.defineProperty(HTMLMediaElement, 'HAVE_CURRENT_DATA', originalHaveCurrentData);
    else Reflect.deleteProperty(HTMLMediaElement, 'HAVE_CURRENT_DATA');
    root = undefined;
    container = undefined;
    originalSrcObject = undefined;
    originalReadyState = undefined;
    originalHaveCurrentData = undefined;
    harness.handCallbacks = null;
    harness.handInit.mockReset();
    harness.poseInit.mockReset();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function prepareMedia(getUserMedia: () => Promise<MediaStream>): void {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia }, permissions: undefined });
    originalSrcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    originalReadyState = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
    originalHaveCurrentData = Object.getOwnPropertyDescriptor(HTMLMediaElement, 'HAVE_CURRENT_DATA');
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get() {
        return null;
      },
      set(_stream: MediaProvider | null) {},
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, value: 2 });
    Object.defineProperty(HTMLMediaElement, 'HAVE_CURRENT_DATA', { configurable: true, value: 2 });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  }

  async function mountApp(videoReadyState?: number): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    if (videoReadyState !== undefined) {
      Object.defineProperty(video!, 'readyState', { configurable: true, value: videoReadyState });
    }
  }

  function statusText(): string | null {
    return container!.querySelector('[data-testid="camera-status"]')!.textContent;
  }

  it('derives the status line and the on flag from the single phase', async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const cameraRequest = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    prepareMedia(() => cameraRequest);
    await mountApp();

    // off: initial text, camera off.
    expect(statusText()).toBe('Permissão da câmera ainda não solicitada');
    expect(container!.querySelector('[data-testid="start-camera"]')).not.toBeNull();

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-testid="start-camera"]')!.click();
      await flushMicrotasks();
    });

    // starting: still off, and a progress report rewrites the text without moving the phase.
    expect(container!.querySelector('[data-testid="start-camera"]')).not.toBeNull();
    await act(async () => {
      harness.handCallbacks?.onStatus('loading', 'Carregando MediaPipe e modelo local…');
      await flushMicrotasks();
    });
    expect(statusText()).toBe('Carregando MediaPipe e modelo local…');
    expect(container!.querySelector('[data-testid="start-camera"]')).not.toBeNull();

    await act(async () => {
      resolveStream(stream);
      await flushMicrotasks();
    });

    // on: the flag flips, the progress text survives the transition.
    expect(container!.querySelector('[data-testid="stop-camera"]')).not.toBeNull();
    expect(statusText()).toBe('Carregando MediaPipe e modelo local…');

    await act(async () => {
      harness.handCallbacks?.onStatus('ready', 'MediaPipe pronto · capturando');
      await flushMicrotasks();
    });
    expect(statusText()).toBe('MediaPipe pronto · capturando');
    expect(container!.querySelector('[data-testid="stop-camera"]')).not.toBeNull();

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-testid="stop-camera"]')!.click();
      await flushMicrotasks();
    });

    // off again, via stopCamera's own text.
    expect(statusText()).toBe('Câmera desligada');
    expect(container!.querySelector('[data-testid="start-camera"]')).not.toBeNull();
  });

  it('lands in the error phase, not plain off, when getUserMedia rejects', async () => {
    prepareMedia(async () => {
      throw new Error('Permissão negada pelo usuário');
    });
    await mountApp();

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-testid="start-camera"]')!.click();
      await flushMicrotasks();
    });

    expect(statusText()).toBe('Permissão negada pelo usuário');
    expect(container!.querySelector('[data-testid="start-camera"]')).not.toBeNull();
  });

  it('fails the attempt when the video never produces data instead of hanging', async () => {
    vi.useFakeTimers();
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    prepareMedia(async () => stream);
    await mountApp(0);

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-testid="start-camera"]')!.click();
      await flushMicrotasks();
    });

    // Parked in 'starting': no error yet just before the deadline.
    await act(async () => {
      vi.advanceTimersByTime(3999);
      await flushMicrotasks();
    });
    expect(statusText()).toBe('Câmera desligada');
    expect(track.stop).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await flushMicrotasks();
    });

    // The attempt failed through the normal start-failure path: tracks stopped,
    // status carries the start error and the camera is off, ready to retry.
    expect(track.stop).toHaveBeenCalledOnce();
    expect(statusText()).toBe('Não foi possível iniciar a câmera.');
    expect(container!.querySelector('[data-testid="start-camera"]')).not.toBeNull();
  });
});
