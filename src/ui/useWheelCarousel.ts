import { type CSSProperties, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { CarouselController, type CarouselStepResult } from './carouselController';
import type { HandInputStore } from './handInputStore';

const HAND_SAMPLE_STALE_MS = 150;
const IDLE_GESTURE = { phase: 'IDLE' as const, angularVelocityDegPerSec: 0 };

export function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}

function shortestTurnDelta(fromTurn: number, toIndex: number, slotCount: number): number {
  return ((((toIndex - fromTurn) % slotCount) + slotCount + slotCount / 2) % slotCount) - slotCount / 2;
}

function paintSlot(element: HTMLElement, style: CSSProperties): void {
  element.style.left = String(style.left ?? '');
  element.style.top = String(style.top ?? '');
  element.style.transform = String(style.transform ?? '');
  element.style.opacity = style.opacity === undefined ? '' : String(style.opacity);
  element.style.zIndex = style.zIndex === undefined ? '' : String(style.zIndex);
}

interface Options {
  slotCount: number;
  initialTurn?: number;
  /** False while the wheel is not interactive: no loop, and the hand gestures stay disarmed. */
  ready: boolean;
  reducedMotion: boolean;
  /** CSS transition of a slot; the mouse or a swipe owns the wheel for this long. */
  transitionMs: number;
  placement(index: number, turn: number): CSSProperties;
  handStore: HandInputStore;
  rotationGateRef: { current: boolean };
  debugRef?: { current: CarouselStepResult | undefined };
  ringRef: RefObject<HTMLElement | null>;
}

/**
 * Drives a wheel from the hand (palm rotation and swipe) and from clicks. While a gesture moves it,
 * slots are painted straight to the DOM; React receives `turn` when the front slot changes or the
 * wheel settles.
 */
export function useWheelCarousel({
  slotCount,
  initialTurn = 0,
  ready,
  reducedMotion,
  transitionMs,
  placement,
  handStore,
  rotationGateRef,
  debugRef,
  ringRef,
}: Options) {
  const [turn, setTurn] = useState(initialTurn); // não volta a zero: a roda gira sempre pelo caminho curto
  const slotRefs = useRef<(HTMLElement | null)[]>([]);
  const mouseControlUntilMsRef = useRef(0);
  const controllerRef = useRef<CarouselController | null>(null);
  controllerRef.current ??= new CarouselController({ slotCount, initialTurn, reducedMotion });
  const controller = controllerRef.current;

  useEffect(() => {
    controller.setReducedMotion(reducedMotion);
  }, [controller, reducedMotion]);

  useEffect(() => {
    rotationGateRef.current = ready;
    return () => {
      rotationGateRef.current = false;
    };
  }, [ready, rotationGateRef]);

  const paint = useCallback(
    (nextTurn: number) => {
      for (let index = 0; index < slotCount; index += 1) {
        const element = slotRefs.current[index];
        if (element) paintSlot(element, placement(index, nextTurn));
      }
    },
    [slotCount, placement],
  );

  const rotateTo = useCallback(
    (nextTurn: number) => {
      mouseControlUntilMsRef.current = reducedMotion ? 0 : performance.now() + transitionMs;
      ringRef.current?.classList.remove('is-gesture-controlled');
      controller.syncTurn(nextTurn);
      setTurn(nextTurn);
      // A gesture may have painted past React's last render, which alone would then skip the write.
      paint(nextTurn);
    },
    [controller, paint, reducedMotion, ringRef, transitionMs],
  );
  const rotateBy = useCallback(
    (delta: number) => rotateTo(Math.round(controller.currentTurn) + delta),
    [controller, rotateTo],
  );
  /** Brings a slot to the front the short way around. */
  const bring = useCallback(
    (index: number) =>
      rotateTo(controller.currentTurn + shortestTurnDelta(controller.currentTurn, index, slotCount)),
    [controller, rotateTo, slotCount],
  );

  // A swipe is a one-sample pulse, so it is taken as published, not polled from the loop.
  useEffect(
    () =>
      handStore.subscribe(() => {
        const input = handStore.current;
        if (input.swipeDirection === 0 || !rotationGateRef.current || !input.visible || !input.synced) return;
        rotateBy(input.swipeDirection);
      }),
    [handStore, rotationGateRef, rotateBy],
  );

  useEffect(() => {
    // O loop vive com a roda pronta, com ou sem mão: ele lê a amostra a cada frame, então uma
    // perda curta não o remonta, e com a mão ociosa mouse e CSS seguem independentes.
    if (!ready) return;
    const ringElement = ringRef.current;
    if (!ringElement) return;
    let rafId: number | undefined;
    let lastMs: number | undefined;

    const tick = (now: number) => {
      const dtMs = lastMs === undefined ? 0 : now - lastMs;
      lastMs = now;
      const input = handStore.current;
      const inputFresh = input.capturedAtMs !== undefined && now - input.capturedAtMs <= HAND_SAMPLE_STALE_MS;
      const mouseOwningTransition = now < mouseControlUntilMsRef.current;
      const rotationInteractive =
        rotationGateRef.current && input.visible && input.synced && inputFresh && !mouseOwningTransition;
      const result = controller.step(
        dtMs,
        rotationInteractive
          ? { phase: input.rotationPhase, angularVelocityDegPerSec: input.rotationAngularVelocity }
          : IDLE_GESTURE,
      );
      if (result.controlling || result.frontChanged || result.settled) paint(result.turn);
      ringElement.classList.toggle('is-gesture-controlled', result.controlling);
      if (debugRef) debugRef.current = result;
      if (result.frontChanged || result.settled) setTurn(result.turn);
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      if (rafId !== undefined) window.cancelAnimationFrame(rafId);
      ringElement.classList.remove('is-gesture-controlled');
      if (debugRef) debugRef.current = undefined;
    };
  }, [ready, controller, paint, handStore, rotationGateRef, debugRef, ringRef]);

  const slotRef = useCallback(
    (index: number) => (element: HTMLElement | null) => {
      slotRefs.current[index] = element;
    },
    [],
  );

  return { turn, controller, slotRef, rotateBy, bring };
}
