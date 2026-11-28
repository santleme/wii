import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { rotationBlocksHandInput, type HandCursorInput } from './handCursorTypes';
import type { HandInputStore } from './handInputStore';

const HOVER = 'data-hand-hover';
/** Time constant of the glide between camera samples. */
const FOLLOW_TAU_MS = 25;
/** Hit-testing forces layout, so it waits for real movement... */
const HIT_TEST_MIN_MOVE_PX = 2;
/** ...or for this long, since the DOM can change under a still cursor. */
const HIT_TEST_REFRESH_MS = 150;

/** Só o elemento do topo conta: o cursor não atravessa painéis para clicar no que está atrás. */
function targetAt(x: number, y: number): HTMLElement | null {
  const target = document.elementFromPoint(x, y)?.closest<HTMLElement>('button, [role="button"], a') ?? null;
  return target?.matches(':disabled') ? null : target;
}

function interactive(input: HandCursorInput, active: boolean): boolean {
  return active && input.visible && input.synced && !rotationBlocksHandInput(input.rotationPhase);
}

/**
 * Moves the cursor element at display rate and translates the hand into hover, click and back on
 * the DOM. Movement and hover run in a rAF loop; click and back fire as each sample is published,
 * so a one-sample pulse is never lost between two frames.
 */
export function useHandHitTest(
  store: HandInputStore,
  active: boolean,
  onBack: () => void,
  cursorRef: RefObject<HTMLElement | null>,
) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const hovered = useRef<HTMLElement | null>(null);
  const released = useRef(false);
  const backDone = useRef(false);

  const hover = useCallback((target: HTMLElement | null) => {
    if (target === hovered.current) return;
    hovered.current?.removeAttribute(HOVER);
    hovered.current = target;
    if (!target) return;
    target.setAttribute(HOVER, 'true');
    target.dispatchEvent(new PointerEvent('pointerenter'));
    // O onPointerEnter do React é derivado de pointerover, não do pointerenter nativo.
    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  }, []);

  useEffect(() => {
    // Clique e voltar valem só na subida do sinal, não a cada amostra em que ele segue ligado.
    const handle = () => {
      const input = store.current;
      const enabled = interactive(input, activeRef.current);
      const click = input.pinchRelease && !released.current;
      const complete = input.backProgress >= 1;
      const back = complete && !backDone.current;
      // Latched before acting: a click or back may publish again from inside this call.
      released.current = input.pinchRelease;
      backDone.current = complete;
      if (!enabled) return;
      if (click) {
        // The sample position, not the glided one: that is where the pinch froze the cursor.
        const target = targetAt(input.x, input.y);
        hover(target);
        target?.click();
      }
      if (back) onBackRef.current();
    };
    handle();
    return store.subscribe(handle);
  }, [store, hover]);

  useEffect(() => {
    if (!active) {
      hover(null);
      return;
    }
    let frame: number;
    let lastMs: number | undefined;
    let shown: { x: number; y: number } | undefined;
    let tested: { x: number; y: number; atMs: number } | undefined;
    const tick = (now: number) => {
      frame = window.requestAnimationFrame(tick);
      const dtMs = lastMs === undefined ? 0 : now - lastMs;
      lastMs = now;
      const input = store.current;
      // A hidden hand leaves the element where it faded out, and reappears without gliding there.
      if (!input.visible) shown = undefined;
      else if (!shown) shown = { x: input.x, y: input.y };
      else {
        const alpha = 1 - Math.exp(-Math.max(dtMs, 0) / FOLLOW_TAU_MS);
        shown.x += (input.x - shown.x) * alpha;
        shown.y += (input.y - shown.y) * alpha;
      }

      // Read layout before writing the cursor style.
      if (!shown || !interactive(input, true)) {
        tested = undefined;
        hover(null);
      } else if (
        !tested ||
        now - tested.atMs >= HIT_TEST_REFRESH_MS ||
        Math.hypot(shown.x - tested.x, shown.y - tested.y) >= HIT_TEST_MIN_MOVE_PX
      ) {
        tested = { x: shown.x, y: shown.y, atMs: now };
        hover(targetAt(shown.x, shown.y));
      }

      const element = cursorRef.current;
      if (shown && element) element.style.transform = `translate3d(${shown.x}px, ${shown.y}px, 0)`;
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [active, store, hover, cursorRef]);

  useEffect(() => () => hover(null), [hover]);
}
