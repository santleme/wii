import { useEffect, useRef } from 'react';
import { rotationBlocksHandInput, type HandCursorInput } from './handCursorTypes';

const HOVER = 'data-hand-hover';
const WITHIN = 'data-hand-within';
const CLICKABLE = 'button, [role="button"], a, summary';
const HAND_CONTAINER = '.lang-anchor, .article-explainer';

/** Só o elemento do topo conta: o cursor não atravessa painéis para clicar no que está atrás. */
function targetAt(hit: Element | undefined): HTMLElement | null {
  const target = hit?.closest<HTMLElement>(CLICKABLE) ?? null;
  return target?.matches(':disabled') ? null : target;
}

/** Traduz o cursor de mão em hover, clique e voltar no DOM. */
export function useHandHitTest(input: HandCursorInput, active: boolean, onBack: () => void) {
  const { visible, x, y, pinchRelease, backProgress, rotationPhase } = input;
  const enabled = active && visible && input.synced && !rotationBlocksHandInput(rotationPhase);
  const hovered = useRef<HTMLElement | null>(null);
  const within = useRef<HTMLElement | null>(null);
  const released = useRef(false);
  const backDone = useRef(false);

  useEffect(() => {
    // Clique e voltar valem só na subida do sinal, não a cada frame em que ele segue ligado.
    const click = pinchRelease && !released.current;
    released.current = pinchRelease;
    const hit = enabled ? document.elementsFromPoint(x, y)[0] : undefined;
    const target = targetAt(hit);
    const container = hit?.closest<HTMLElement>(HAND_CONTAINER) ?? null;
    if (target !== hovered.current) {
      hovered.current?.removeAttribute(HOVER);
      hovered.current = target;
      if (target) {
        target.setAttribute(HOVER, 'true');
        target.dispatchEvent(new PointerEvent('pointerenter'));
        // O onPointerEnter do React é derivado de pointerover, não do pointerenter nativo.
        target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      }
    }
    if (container !== within.current) {
      within.current?.removeAttribute(WITHIN);
      within.current = container;
      container?.setAttribute(WITHIN, 'true');
    }
    if (click) target?.click();
  }, [enabled, x, y, pinchRelease]);

  useEffect(() => {
    const complete = backProgress >= 1;
    if (enabled && complete && !backDone.current) onBack();
    backDone.current = complete;
  }, [enabled, backProgress, onBack]);

  useEffect(
    () => () => {
      hovered.current?.removeAttribute(HOVER);
      within.current?.removeAttribute(WITHIN);
    },
    [],
  );
}
