import { useEffect, useRef } from 'react';
import { rotationBlocksHandInput, type HandCursorInput } from './handCursorTypes';

const HOVER = 'data-hand-hover';

/** Só o elemento do topo conta: o cursor não atravessa painéis para clicar no que está atrás. */
function targetAt(x: number, y: number): HTMLElement | null {
  const target = document.elementsFromPoint(x, y)[0]?.closest<HTMLElement>('button, [role="button"], a') ?? null;
  return target?.matches(':disabled') ? null : target;
}

/** Traduz o cursor de mão em hover, clique e voltar no DOM. */
export function useHandHitTest(input: HandCursorInput, active: boolean, onBack: () => void) {
  const { visible, x, y, pinchRelease, backProgress, rotationPhase } = input;
  const enabled = active && visible && input.synced && !rotationBlocksHandInput(rotationPhase);
  const hovered = useRef<HTMLElement | null>(null);
  const released = useRef(false);
  const backDone = useRef(false);

  useEffect(() => {
    // Clique e voltar valem só na subida do sinal, não a cada frame em que ele segue ligado.
    const click = pinchRelease && !released.current;
    released.current = pinchRelease;
    const target = enabled ? targetAt(x, y) : null;
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
    if (click) target?.click();
  }, [enabled, x, y, pinchRelease]);

  useEffect(() => {
    const complete = backProgress >= 1;
    if (enabled && complete && !backDone.current) onBack();
    backDone.current = complete;
  }, [enabled, backProgress, onBack]);

  useEffect(() => () => hovered.current?.removeAttribute(HOVER), []);
}
