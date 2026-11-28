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

describe('useHandHitTest', () => {
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
      root.render(
        createElement(Probe, { input: { ...input, rotationPhase: 'IDLE', pinchRelease: false }, onBack: vi.fn() }),
      );
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

  it('keeps the language menu marked across its padding without clicking outside buttons', () => {
    const anchor = document.createElement('span');
    anchor.className = 'lang-anchor';
    const theme = document.createElement('button');
    const menu = document.createElement('span');
    menu.className = 'lang-menu';
    const pt = document.createElement('button');
    const en = document.createElement('button');
    menu.append(pt, en);
    anchor.append(theme, menu);
    document.body.appendChild(anchor);
    const themeClick = vi.spyOn(theme, 'click');
    const ptClick = vi.spyOn(pt, 'click');
    const enClick = vi.spyOn(en, 'click');
    let hit: Element = theme;
    document.elementsFromPoint = vi.fn(() => [hit] as unknown as Element[]);
    const input: HandCursorInput = { ...HAND_IDLE, visible: true, synced: true, x: 20, y: 20 };
    const { root } = renderProbe(input);

    expect(anchor.getAttribute('data-hand-within')).toBe('true');
    expect(theme.getAttribute('data-hand-hover')).toBe('true');

    hit = menu;
    act(() => {
      root.render(createElement(Probe, { input: { ...input, x: 24 }, onBack: vi.fn() }));
    });
    expect(theme.hasAttribute('data-hand-hover')).toBe(false);
    expect(anchor.getAttribute('data-hand-within')).toBe('true');

    act(() => {
      root.render(createElement(Probe, { input: { ...input, x: 25, pinchRelease: true }, onBack: vi.fn() }));
    });
    expect(themeClick).not.toHaveBeenCalled();
    expect(ptClick).not.toHaveBeenCalled();
    expect(enClick).not.toHaveBeenCalled();

    hit = en;
    act(() => {
      root.render(createElement(Probe, { input: { ...input, x: 31 }, onBack: vi.fn() }));
    });
    expect(en.getAttribute('data-hand-hover')).toBe('true');
    expect(anchor.getAttribute('data-hand-within')).toBe('true');
    act(() => {
      root.render(createElement(Probe, { input: { ...input, x: 31, pinchRelease: true }, onBack: vi.fn() }));
    });
    expect(enClick).toHaveBeenCalledTimes(1);
    expect(themeClick).not.toHaveBeenCalled();
    expect(ptClick).not.toHaveBeenCalled();
    act(() => {
      root.unmount();
    });
    expect(anchor.hasAttribute('data-hand-within')).toBe(false);
  });

  it('keeps an article explainer marked while the hand crosses into its card', () => {
    const explainer = document.createElement('span');
    explainer.className = 'article-explainer';
    const term = document.createElement('button');
    term.className = 'article-term';
    const card = document.createElement('span');
    card.className = 'article-explainer-card';
    const link = document.createElement('a');
    card.appendChild(link);
    explainer.append(term, card);
    document.body.appendChild(explainer);
    let hit: Element = term;
    document.elementsFromPoint = vi.fn(() => [hit] as unknown as Element[]);
    const input: HandCursorInput = { ...HAND_IDLE, visible: true, synced: true, x: 20, y: 20 };
    const { root } = renderProbe(input);

    expect(explainer.getAttribute('data-hand-within')).toBe('true');
    expect(term.getAttribute('data-hand-hover')).toBe('true');

    hit = card;
    act(() => {
      root.render(createElement(Probe, { input: { ...input, x: 22 }, onBack: vi.fn() }));
    });
    expect(term.hasAttribute('data-hand-hover')).toBe(false);
    expect(explainer.getAttribute('data-hand-within')).toBe('true');

    hit = link;
    act(() => {
      root.render(createElement(Probe, { input: { ...input, x: 23 }, onBack: vi.fn() }));
    });
    expect(link.getAttribute('data-hand-hover')).toBe('true');
    expect(explainer.getAttribute('data-hand-within')).toBe('true');

    act(() => {
      root.render(createElement(Probe, { input: { ...input, visible: false }, onBack: vi.fn() }));
    });
    expect(link.hasAttribute('data-hand-hover')).toBe(false);
    expect(explainer.hasAttribute('data-hand-within')).toBe(false);
    act(() => {
      root.unmount();
    });
  });

  it('toggles details when the pinch target is a summary', () => {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    details.append(summary, document.createElement('p'));
    document.body.appendChild(details);
    document.elementsFromPoint = vi.fn(() => [summary] as unknown as Element[]);
    const input: HandCursorInput = { ...HAND_IDLE, visible: true, synced: true, x: 20, y: 20, pinchRelease: true };
    const { root } = renderProbe(input);

    expect(details.open).toBe(true);
    act(() => {
      root.render(createElement(Probe, { input: { ...input, pinchRelease: false }, onBack: vi.fn() }));
    });
    act(() => {
      root.render(createElement(Probe, { input, onBack: vi.fn() }));
    });
    expect(details.open).toBe(false);
    act(() => {
      root.unmount();
    });
  });
});
