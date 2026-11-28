// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HAND_IDLE, type HandCursorInput } from '../src/ui/handCursorTypes';
import { useHandHitTest } from '../src/ui/useHandHitTest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ input, onBack }: { input: HandCursorInput; onBack: () => void }) {
  useHandHitTest(input, true, onBack);
  return null;
}

function renderProbe(input: HandCursorInput, onBack = vi.fn()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Probe, { input, onBack }));
  });
  return { container, root, onBack };
}

describe('useHandHitTest rotational blocking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('blocks hover and click while rotation is active, then restores them on IDLE', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    const click = vi.spyOn(button, 'click');
    document.elementsFromPoint = vi.fn(() => [button] as unknown as Element[]);
    const input: HandCursorInput = {
      ...HAND_IDLE,
      visible: true,
      synced: true,
      x: 20,
      y: 20,
      pinchRelease: true,
      rotationPhase: 'ROTATING',
    };
    const { root } = renderProbe(input);
    expect(button.hasAttribute('data-hand-hover')).toBe(false);
    expect(click).not.toHaveBeenCalled();

    act(() => {
      root.render(createElement(Probe, { input: { ...input, rotationPhase: 'IDLE' }, onBack: vi.fn() }));
    });
    expect(button.getAttribute('data-hand-hover')).toBe('true');
    expect(click).not.toHaveBeenCalled(); // a pinça segurada durante a rotação não vira clique atrasado
    act(() => {
      root.render(createElement(Probe, { input: { ...input, rotationPhase: 'IDLE', pinchRelease: false }, onBack: vi.fn() }));
    });
    act(() => {
      root.render(createElement(Probe, { input: { ...input, rotationPhase: 'IDLE' }, onBack: vi.fn() }));
    });
    expect(click).toHaveBeenCalledTimes(1);
    act(() => {
      root.unmount();
    });
  });

  it('blocks back completion during braking and snap phases', () => {
    const onBack = vi.fn();
    const input: HandCursorInput = {
      ...HAND_IDLE,
      visible: true,
      synced: true,
      backProgress: 1,
      rotationPhase: 'BRAKING',
    };
    const { root } = renderProbe(input, onBack);
    expect(onBack).not.toHaveBeenCalled();
    act(() => {
      root.render(createElement(Probe, { input: { ...input, rotationPhase: 'SNAP_TO_CARD' }, onBack }));
    });
    expect(onBack).not.toHaveBeenCalled();
    act(() => {
      root.unmount();
    });
  });
});
