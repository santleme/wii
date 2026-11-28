// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import CrystalAsciiField from '../src/components/CrystalAsciiField';
import { impulseCrystal } from '../src/components/crystalField';

vi.mock('../src/components/crystalField', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/components/crystalField')>();
  return { ...original, impulseCrystal: vi.fn(original.impulseCrystal) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('does not keep sending held pulses after the pointer enters a control', async () => {
  let intersection: IntersectionObserverCallback | undefined;
  let tick: FrameRequestCallback | undefined;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersection = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { tick = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList);
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
  const context = { clearRect() {}, setTransform() {}, fillText() {}, drawImage() {}, globalAlpha: 1 };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 300 } as DOMRect);
  const host = document.createElement('main');
  const mount = document.createElement('div');
  const button = document.createElement('button');
  host.append(mount, button);
  document.body.append(host);
  const root = createRoot(mount);
  try {
    await act(async () => { root.render(<CrystalAsciiField />); });
    act(() => { intersection?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); });
    const surface = mount.querySelector('.papers-ascii-bg')!;
    // The component listens on its parent, which also contains the button.
    mount.append(button);
    act(() => { surface.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 })); });
    expect(impulseCrystal).toHaveBeenCalledTimes(1);
    act(() => { button.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 120, clientY: 120 })); });
    act(() => { tick?.(performance.now() + 1000); });
    expect(impulseCrystal).toHaveBeenCalledTimes(1);
    act(() => { surface.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 90, clientY: 90 })); });
    expect(impulseCrystal).toHaveBeenCalledTimes(2);
    act(() => { mount.dispatchEvent(new PointerEvent('pointerleave')); });
    act(() => { tick?.(performance.now() + 2000); });
    expect(impulseCrystal).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
