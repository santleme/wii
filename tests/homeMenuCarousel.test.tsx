// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CarouselStepResult } from '../src/ui/carouselController';
import { HAND_IDLE, type HandCursorInput } from '../src/ui/handCursorTypes';
import { createHandInputStore } from '../src/ui/handInputStore';
import { HomeMenu } from '../src/ui/WiiMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mockReducedMotion() {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

function mockRaf() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
    callbacks.delete(id);
  });
  return {
    callbacks,
    fire(now: number) {
      const first = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!first) return;
      const [id, callback] = first;
      callbacks.delete(id);
      callback(now);
    },
  };
}

function renderHome(input: HandCursorInput, onPick = vi.fn(), onIronMan = vi.fn()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const handStore = createHandInputStore(input);
  const rotationGateRef = { current: false };
  const carouselDebugRef: { current: CarouselStepResult | undefined } = { current: undefined };
  act(() => {
    root.render(createElement(HomeMenu, {
      onPick,
      onIronMan,
      exit: null,
      handStore,
      rotationGateRef,
      carouselDebugRef,
    }));
  });
  return { container, root, handStore, rotationGateRef, carouselDebugRef };
}

describe('HomeMenu rotational carousel integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('selects games on the wheel and lets athletics choose a distance', () => {
    mockReducedMotion();
    const onPick = vi.fn();
    const { container, root } = renderHome(HAND_IDLE, onPick);
    const athletics = container.querySelector<HTMLButtonElement>('[aria-label="Atletismo"]')!;
    act(() => athletics.click());
    expect(onPick).not.toHaveBeenCalled();
    act(() => athletics.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Escolha a distância');
    act(() => [...container.querySelectorAll('button')].find((button) => button.textContent === '200 metros')!.click());
    expect(onPick).toHaveBeenCalledWith('athletics', 200);
    act(() => root.unmount());
  });

  it('starts Iron Man from Wii Sports', () => {
    mockReducedMotion();
    const onPick = vi.fn();
    const onIronMan = vi.fn();
    const { container, root } = renderHome(HAND_IDLE, onPick, onIronMan);
    act(() => container.querySelector<HTMLButtonElement>('.channel.sports')!.click());
    expect(onIronMan).toHaveBeenCalledOnce();
    expect(onPick).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('paints continuous fractional motion directly, exposes debug state, and cancels rAF on unmount', () => {
    mockReducedMotion();
    const raf = mockRaf();
    const input: HandCursorInput = {
      ...HAND_IDLE,
      visible: true,
      synced: true,
      capturedAtMs: 1000,
      rotationPhase: 'ROTATING',
      rotationAngularVelocity: 180,
      rotationDirection: 1,
    };
    const { container, root, rotationGateRef, carouselDebugRef } = renderHome(input);
    const ring = container.querySelector('.channel-ring')!;
    const firstChannel = container.querySelector<HTMLElement>('.channel')!;
    expect(rotationGateRef.current).toBe(true);
    expect(raf.callbacks.size).toBe(1);

    act(() => {
      raf.fire(1000);
    });
    const initialLeft = firstChannel.style.left;
    act(() => {
      raf.fire(1016);
    });
    expect(firstChannel.style.left).not.toBe(initialLeft);
    expect(ring.className).toContain('is-gesture-controlled');
    expect(carouselDebugRef.current).toMatchObject({ mode: 'driving', controlling: true });
    expect(carouselDebugRef.current!.velocityDegPerSec).toBeGreaterThan(0);

    act(() => {
      root.unmount();
    });
    expect(raf.callbacks.size).toBe(0);
    expect(rotationGateRef.current).toBe(false);
    expect(carouselDebugRef.current).toBeUndefined();
  });


  it('expires a stale rotating hand sample instead of driving forever', () => {
    mockReducedMotion();
    const raf = mockRaf();
    const input: HandCursorInput = {
      ...HAND_IDLE,
      visible: true,
      synced: true,
      capturedAtMs: 800,
      rotationPhase: 'ROTATING',
      rotationAngularVelocity: 180,
      rotationDirection: 1,
    };
    const { container, root } = renderHome(input);
    const ring = container.querySelector('.channel-ring')!;
    const firstChannel = container.querySelector<HTMLElement>('.channel')!;
    act(() => {
      raf.fire(1000);
      raf.fire(1016);
    });
    expect(ring.className).not.toContain('is-gesture-controlled');
    expect(firstChannel.style.left).toBe('50%');
    act(() => {
      root.unmount();
    });
  });

  it('keeps one loop through a momentary hand loss and drives again without a re-render', () => {
    mockReducedMotion();
    const raf = mockRaf();
    const { container, root, handStore } = renderHome(HAND_IDLE);
    const firstChannel = container.querySelector<HTMLElement>('.channel')!;
    act(() => {
      raf.fire(1000);
    });
    expect(firstChannel.style.left).toBe('50%');
    expect(raf.callbacks.size).toBe(1);

    handStore.publish({
      ...HAND_IDLE,
      visible: true,
      synced: true,
      capturedAtMs: 1000,
      rotationPhase: 'ROTATING',
      rotationAngularVelocity: 180,
      rotationDirection: 1,
    });
    act(() => {
      raf.fire(1016);
      raf.fire(1032);
    });
    expect(firstChannel.style.left).not.toBe('50%');
    expect(raf.callbacks.size).toBe(1);
    act(() => {
      root.unmount();
    });
  });

  it('steps one channel per swipe pulse, only from a synchronized hand', () => {
    mockReducedMotion();
    mockRaf();
    const { container, root, handStore } = renderHome(HAND_IDLE);
    const athletics = container.querySelector<HTMLElement>('[aria-label="Atletismo"]')!;
    const tracked: HandCursorInput = { ...HAND_IDLE, visible: true, synced: true };
    const side = athletics.style.left;

    act(() => handStore.publish({ ...tracked, synced: false, swipeDirection: 1 }));
    expect(athletics.style.left).toBe(side);
    act(() => handStore.publish({ ...tracked, swipeDirection: 1 }));
    expect(athletics.style.left).toBe('50%');
    act(() => handStore.publish(tracked));
    act(() => handStore.publish({ ...tracked, swipeDirection: -1 }));
    expect(athletics.style.left).toBe(side);
    act(() => {
      root.unmount();
    });
  });

  it('does not move the wheel or suppress transitions when hand input is idle', () => {
    mockReducedMotion();
    const raf = mockRaf();
    const { container, root } = renderHome({ ...HAND_IDLE, visible: true, synced: true });
    const ring = container.querySelector('.channel-ring')!;
    const firstChannel = container.querySelector<HTMLElement>('.channel')!;
    act(() => {
      raf.fire(2000);
      raf.fire(2016);
    });
    expect(ring.className).not.toContain('is-gesture-controlled');
    expect(firstChannel.style.left).toBe('50%');
    act(() => {
      root.unmount();
    });
  });
});
