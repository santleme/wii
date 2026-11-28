// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HAND_IDLE } from '../src/ui/handCursorTypes';
import { HomeMenu } from '../src/ui/WiiMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mockMotionAllowed() {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

function renderHome() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onGames = vi.fn();
  act(() => {
    root.render(createElement(HomeMenu, {
      onGames,
      exit: null,
      handInputRef: { current: HAND_IDLE },
      rotationGateRef: { current: false },
    }));
  });
  return { container, root, onGames };
}

function openSportsChannel(container: HTMLElement) {
  act(() => {
    vi.advanceTimersByTime(2500); // grade -> roda -> roda pronta
  });
  const channel = container.querySelector<HTMLButtonElement>('.channel.sports');
  expect(channel).not.toBeNull();
  act(() => {
    channel!.click();
  });
  const whiteout = container.querySelector('.channel-whiteout');
  expect(whiteout).not.toBeNull();
  return whiteout!;
}

describe('HomeMenu whiteout transition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockMotionAllowed();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('falls back to onGames when the whiteout animationend never fires', () => {
    const { container, root, onGames } = renderHome();
    openSportsChannel(container);
    expect(onGames).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(onGames).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onGames).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onGames).toHaveBeenCalledTimes(1);
    act(() => {
      root.unmount();
    });
  });

  it('animationend wins the race and the fallback timer never calls again', () => {
    const { container, root, onGames } = renderHome();
    const whiteout = openSportsChannel(container);

    act(() => {
      whiteout.dispatchEvent(new window.Event('animationend', { bubbles: true }));
    });
    expect(onGames).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onGames).toHaveBeenCalledTimes(1);
    act(() => {
      root.unmount();
    });
  });
});
