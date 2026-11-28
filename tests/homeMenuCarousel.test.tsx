// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CarouselStepResult } from '../src/ui/carouselController';
import { HAND_IDLE, type HandCursorInput } from '../src/ui/handCursorTypes';
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

function renderHome(input: HandCursorInput) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const handInputRef = { current: input };
  const rotationGateRef = { current: false };
  const carouselDebugRef: { current: CarouselStepResult | undefined } = { current: undefined };
  act(() => {
    root.render(createElement(HomeMenu, {
      onGames: vi.fn(),
      exit: null,
      handInputRef,
      rotationGateRef,
      carouselDebugRef,
    }));
  });
  return { container, root, handInputRef, rotationGateRef, carouselDebugRef };
}

describe('HomeMenu rotational carousel integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
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

  it('cancels the carousel rAF when camera hand input becomes unavailable', () => {
    mockReducedMotion();
    const raf = mockRaf();
    const input: HandCursorInput = { ...HAND_IDLE, visible: true, synced: true };
    const rendered = renderHome(input);
    expect(raf.callbacks.size).toBe(1);
    rendered.handInputRef.current = HAND_IDLE;
    act(() => {
      rendered.root.render(createElement(HomeMenu, {
        onGames: vi.fn(),
        exit: null,
        handInputRef: rendered.handInputRef,
        rotationGateRef: rendered.rotationGateRef,
        carouselDebugRef: rendered.carouselDebugRef,
      }));
    });
    expect(raf.callbacks.size).toBe(0);
    act(() => {
      rendered.root.unmount();
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
