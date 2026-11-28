// @vitest-environment happy-dom
import { act, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandSnapshot } from '@wii/spatial-core';
import { handSnapshot } from './fixtures/syntheticHand';
import App from '../src/App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  handInit: vi.fn(),
  handCallbacks: null as null | { onStatus(status: string, detail: string): void },
  handPauseCapture: vi.fn(),
  handDispose: vi.fn(),
  handErrorCallbacks: [] as Array<(error: Error) => void>,
  handFrameCallbacks: [] as Array<(snapshot: HandSnapshot, aspectY: number) => void>,
  handInput: null as unknown,
  poseInit: vi.fn(),
  poseBeginCapture: vi.fn(),
  posePauseCapture: vi.fn(),
  poseDispose: vi.fn(),
}));

vi.mock('../src/cv/handClient', () => ({
  HandClient: class {
    isReady = true;

    init(callbacks: { onStatus(status: string, detail: string): void }): Promise<void> {
      harness.handCallbacks = callbacks;
      return harness.handInit();
    }

    beginCapture(
      _video: HTMLVideoElement,
      onHand: (snapshot: HandSnapshot, aspectY: number) => void,
      onError?: (error: Error) => void,
    ): void {
      harness.handFrameCallbacks.push(onHand);
      if (onError) harness.handErrorCallbacks.push(onError);
    }

    pauseCapture(): void {
      harness.handPauseCapture();
    }

    dispose(): void {
      harness.handDispose();
    }

    static warmVisionAssets(): void {}
  },
}));

vi.mock('../src/cv/poseClient', () => ({
  PoseClient: class {
    isReady = true;

    init(): Promise<void> {
      return harness.poseInit();
    }

    beginCapture(): void {
      harness.poseBeginCapture();
    }

    pauseCapture(): void {
      harness.posePauseCapture();
    }

    dispose(): void {
      harness.poseDispose();
    }

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
vi.mock('../src/ui/HandCursor', () => ({
  HandCursor: ({ input }: { input: unknown }) => {
    harness.handInput = input;
    return null;
  },
}));
vi.mock('../src/ui/GameCanvas', () => ({ GameCanvas: () => null }));

vi.mock('../src/ui/WiiMenu', async () => {
  const React = await import('react');
  return {
    HomeMenu: ({ onGames }: { onGames(): void }) =>
      React.createElement('button', { 'data-testid': 'home-to-games', onClick: onGames }),
    GamesMenu: ({ onPick }: { onPick(sport: 'track' | 'athletics' | 'tennis'): void }) =>
      React.createElement('button', { 'data-testid': 'start-athletics', onClick: () => onPick('athletics') }),
  };
});

vi.mock('../src/ui/WiiSplash', () => ({ WiiSplash: () => null }));

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

describe('App vision mode lifecycle', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalSrcObject: PropertyDescriptor | undefined;
  let originalReadyState: PropertyDescriptor | undefined;
  let originalHaveCurrentData: PropertyDescriptor | undefined;

  beforeEach(() => {
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
    harness.handErrorCallbacks = [];
    harness.handFrameCallbacks = [];
    harness.handInput = null;
    harness.handInit.mockReset();
    harness.poseInit.mockReset();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  async function mountApp(): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<App />));
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    Object.defineProperty(video!, 'readyState', { configurable: true, value: 2 });
  }

  async function clickStartCamera(): Promise<void> {
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-testid="start-camera"]')!.click();
      await flushMicrotasks();
    });
  }

  async function enterPoseMode(): Promise<void> {
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-testid="home-to-games"]')!.click());
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-testid="start-athletics"]')!.click();
      await flushMicrotasks();
    });
  }

  it('keeps the active pose camera when the previous hand initialization fails', async () => {
    let rejectHandInitialization!: (error: Error) => void;
    const handInitialization = new Promise<void>((_resolve, reject) => {
      rejectHandInitialization = reject;
    });
    harness.handInit.mockReturnValue(handInitialization);

    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    prepareMedia(async () => stream);
    await mountApp();
    await clickStartCamera();
    expect(container!.querySelector('[data-testid="stop-camera"]')).not.toBeNull();

    await enterPoseMode();
    expect(harness.poseBeginCapture).toHaveBeenCalledOnce();

    await act(async () => {
      harness.handCallbacks?.onStatus('error', 'Hand Landmarker initialization failed.');
      rejectHandInitialization(new Error('Hand Landmarker initialization failed.'));
      await flushMicrotasks();
    });

    expect(track.stop).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="stop-camera"]')).not.toBeNull();
    expect(harness.posePauseCapture).not.toHaveBeenCalled();
  });

  it('ignores a late fatal hand worker status after pose becomes active', async () => {
    harness.handInit.mockResolvedValue(undefined);

    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    prepareMedia(async () => stream);
    await mountApp();
    await clickStartCamera();
    expect(container!.querySelector('[data-testid="stop-camera"]')).not.toBeNull();

    await enterPoseMode();
    expect(harness.poseBeginCapture).toHaveBeenCalledOnce();

    await act(async () => {
      harness.handCallbacks?.onStatus('error', 'Late hand worker failure.');
      await flushMicrotasks();
    });

    expect(track.stop).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="stop-camera"]')).not.toBeNull();
    expect(harness.posePauseCapture).not.toHaveBeenCalled();
  });

  it('starts the selected pose mode when the screen changes before getUserMedia resolves', async () => {
    let rejectHandInitialization!: (error: Error) => void;
    const handInitialization = new Promise<void>((_resolve, reject) => {
      rejectHandInitialization = reject;
    });
    harness.handInit.mockReturnValue(handInitialization);

    let resolveStream!: (stream: MediaStream) => void;
    const cameraRequest = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    prepareMedia(() => cameraRequest);
    await mountApp();
    await clickStartCamera();

    await enterPoseMode();
    expect(harness.poseBeginCapture).not.toHaveBeenCalled();

    await act(async () => {
      harness.handCallbacks?.onStatus('error', 'Hand Landmarker initialization failed.');
      rejectHandInitialization(new Error('Hand Landmarker initialization failed.'));
      await flushMicrotasks();
    });

    await act(async () => {
      resolveStream(stream);
      await flushMicrotasks();
    });
    expect(harness.poseBeginCapture).toHaveBeenCalledOnce();

    expect(track.stop).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="stop-camera"]')).not.toBeNull();
    expect(harness.posePauseCapture).not.toHaveBeenCalled();
  });

  it('restarts hand tracking after hand→pose→hand and ignores frames from the earlier activation', async () => {
    harness.handInit.mockResolvedValue(undefined);

    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    prepareMedia(async () => stream);
    await mountApp();
    await clickStartCamera();
    expect(harness.handErrorCallbacks).toHaveLength(1);

    await enterPoseMode();
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('.hud-dock .dock-btn')!.click();
      await flushMicrotasks();
    });
    expect(harness.handFrameCallbacks).toHaveLength(2);

    await act(async () => {
      for (const timestampMs of [0, 100, 200]) {
        harness.handFrameCallbacks[0]!(handSnapshot(timestampMs), 0.75);
      }
    });

    expect(harness.handInput).toMatchObject({ visible: false, synced: false, syncProgress: 0 });
    expect(track.stop).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="stop-camera"]')).not.toBeNull();
  });

  it('never begins hand capture when a pending hand init resolves after pose took over', async () => {
    let resolveHandInitialization!: () => void;
    const handInitialization = new Promise<void>((resolve) => {
      resolveHandInitialization = resolve;
    });
    harness.handInit.mockReturnValue(handInitialization);

    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    prepareMedia(async () => stream);
    await mountApp();
    await clickStartCamera();

    await enterPoseMode();
    expect(harness.poseBeginCapture).toHaveBeenCalledOnce();
    expect(harness.handFrameCallbacks).toHaveLength(0);

    await act(async () => {
      resolveHandInitialization();
      await flushMicrotasks();
    });

    // The late hand activation is stale: it must not start capturing over pose,
    // and its completion must not disturb the running pose camera.
    expect(harness.handFrameCallbacks).toHaveLength(0);
    expect(harness.handErrorCallbacks).toHaveLength(0);
    expect(track.stop).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="stop-camera"]')).not.toBeNull();
    expect(harness.posePauseCapture).not.toHaveBeenCalled();
  });

  it('stops the camera when the active pose provider rejects without a status callback', async () => {
    harness.handInit.mockResolvedValue(undefined);
    harness.poseInit.mockRejectedValue(new Error('Worker constructor failed.'));

    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    prepareMedia(async () => stream);
    await mountApp();
    await clickStartCamera();
    await enterPoseMode();

    expect(track.stop).toHaveBeenCalledOnce();
    expect(container!.querySelector('[data-testid="start-camera"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="camera-status"]')!.textContent).toBe('Worker constructor failed.');
  });
});
