// @vitest-environment happy-dom
import type { HandSnapshot } from '@wii/spatial-core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteHandProvider, useSiteHand } from '../src/app/SiteHandContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  created: 0,
  dispose: vi.fn(),
  frame: undefined as undefined | ((snapshot: HandSnapshot, aspectY: number) => void),
}));

vi.mock('../src/cv/handClient', () => ({
  HandClient: class {
    constructor() {
      harness.created += 1;
    }
    init() {
      return Promise.resolve();
    }
    beginCapture(_video: HTMLVideoElement, onHand: (snapshot: HandSnapshot, aspectY: number) => void) {
      harness.frame = onHand;
    }
    dispose() {
      harness.dispose();
    }
    static warmVisionAssets() {}
  },
}));

let root: Root;
let hand: ReturnType<typeof useSiteHand>;
const trackStop = vi.fn();
const stream = () => {
  const track = { stop: trackStop, addEventListener: () => undefined };
  return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
};
const getUserMedia = vi.fn();

function Probe() {
  hand = useSiteHand();
  return null;
}

const render = (inArena: boolean) =>
  act(async () => {
    root.render(
      <SiteHandProvider inArena={inArena}>
        <Probe />
      </SiteHandProvider>,
    );
  });

beforeEach(async () => {
  harness.created = 0;
  harness.frame = undefined;
  getUserMedia.mockImplementation(async () => stream());
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, writable: true, value: null });
  root = createRoot(document.createElement('div'));
  await render(false);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

describe('SiteHandProvider', () => {
  it('creates nothing until the camera is requested', () => {
    expect(harness.created).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(hand.camera).toBe('off');
  });

  it('delivers camera frames to subscribers until they unsubscribe', async () => {
    const listener = vi.fn();
    const unsubscribe = hand.subscribe(listener);
    await act(async () => hand.enableCamera());
    expect(hand.camera).toBe('on');
    await act(async () => harness.frame!({ timestampMs: 1, hands: [] }, 0.75));
    expect(listener).toHaveBeenCalledWith({ timestampMs: 1, hands: [] }, 0.75);
    unsubscribe();
    await act(async () => harness.frame!({ timestampMs: 2, hands: [] }, 0.75));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('releases the camera on entering the arena and ignores late frames', async () => {
    const listener = vi.fn();
    hand.subscribe(listener);
    await act(async () => hand.enableCamera());
    await render(true);
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(harness.dispose).toHaveBeenCalled();
    expect(hand.camera).toBe('off');
    await act(async () => harness.frame!({ timestampMs: 3, hands: [] }, 0.75));
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops a stream that arrives after the request was cancelled', async () => {
    let resolve!: (value: MediaStream) => void;
    getUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((done) => {
          resolve = done;
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = hand.enableCamera();
    });
    await act(async () => hand.stopCamera());
    await act(async () => {
      resolve(stream());
      await pending;
    });
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(hand.camera).toBe('off');
    expect(harness.frame).toBeUndefined();
  });
});
