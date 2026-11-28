// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SiteAsciiHand from '../src/components/SiteAsciiHand';
import { HAND_IDLE, type HandCursorInput } from '../src/ui/handCursorTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = vi.hoisted(() => ({
  input: undefined as unknown,
  webglFails: true,
  presence: 0,
  smoothers: 0,
}));

vi.mock('../src/app/SiteHandContext', () => ({
  useSiteHand: () => ({ camera: 'on', subscribe: () => () => undefined }),
  useSiteHandInput: () => harness.input,
}));

vi.mock('../src/lib/handRig', async (original) => ({
  ...(await original<typeof import('../src/lib/handRig')>()),
  HandRigSmoother: class {
    constructor() {
      harness.smoothers += 1;
    }
    observe() {}
    presence() {
      return harness.presence;
    }
    sample(_now: number, idle: import('../src/lib/handRig').HandRigPose) {
      return idle;
    }
    reset() {}
  },
}));

vi.mock('../src/components/handAsciiPass', () => ({
  createAsciiPass: () => ({
    setSize: () => undefined,
    setLight: () => undefined,
    render: () => undefined,
    dispose: () => undefined,
  }),
}));

// No WebGL here: the pointer must keep working without the drawing.
vi.mock('three', async (original) => ({
  ...(await original<typeof import('three')>()),
  WebGLRenderer: class {
    constructor() {
      if (harness.webglFails) throw new Error('no WebGL');
    }
    setPixelRatio() {}
    setSize() {}
    dispose() {}
    forceContextLoss() {}
  },
}));

let root: Root;
let container: HTMLDivElement;
const tracked: HandCursorInput = { ...HAND_IDLE, visible: true, synced: true, x: 40, y: 50 };

const render = (onProduct: boolean, input: HandCursorInput, onBack: () => void) => {
  harness.input = input;
  return act(async () => {
    root.render(<SiteAsciiHand onProduct={onProduct} onBack={onBack} />);
  });
};

function mockAnimationFrames() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = next;
    next += 1;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    callbacks.delete(id);
  });
  return {
    step(now: number) {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(now);
    },
  };
}

beforeEach(() => {
  document.elementsFromPoint = () => [];
  harness.webglFails = true;
  harness.presence = 0;
  harness.smoothers = 0;
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('SiteAsciiHand', () => {
  it('ignores the fist back gesture on /product only', async () => {
    const onBack = vi.fn();
    await render(true, { ...tracked, backProgress: 1 }, onBack);
    expect(onBack).not.toHaveBeenCalled();
    expect(container.querySelector('.site-tip-ring')).toBeNull();
    await render(false, tracked, onBack);
    await render(false, { ...tracked, backProgress: 1 }, onBack);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('draws no second hand: only feedback around the fingertip', async () => {
    await render(false, tracked, () => undefined);
    expect(container.querySelector('.site-tip')?.childElementCount).toBe(1);
    expect(container.querySelector('.site-tip-cross')?.textContent).toBe('+');
    await render(false, { ...tracked, pinching: true }, () => undefined);
    expect(container.querySelector('.site-tip-pulse')).not.toBeNull();
    await render(false, { ...tracked, pinching: true, pinchRelease: true }, () => undefined);
    expect(container.querySelector('.site-tip-flash')).not.toBeNull();
  });

  it('does not click while the hand is still rising', async () => {
    harness.webglFails = false;
    harness.presence = 0.97;
    const frames = mockAnimationFrames();
    const button = document.createElement('button');
    document.body.appendChild(button);
    const click = vi.spyOn(button, 'click');
    document.elementsFromPoint = vi.fn(() => [button] as unknown as Element[]);

    await render(false, tracked, () => undefined);
    await act(async () => frames.step(16));
    await render(false, { ...tracked, pinchRelease: true }, () => undefined);
    expect(click).not.toHaveBeenCalled();
    expect(button.hasAttribute('data-hand-hover')).toBe(false);

    await render(false, tracked, () => undefined);
    harness.presence = 0.98;
    await act(async () => frames.step(32));
    expect(button.getAttribute('data-hand-hover')).toBe('true');
    await render(false, { ...tracked, pinchRelease: true }, () => undefined);
    expect(click).toHaveBeenCalledTimes(1);
    expect(harness.smoothers).toBe(1);
  });
});
