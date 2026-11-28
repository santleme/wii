import { useEffect, useMemo, useState } from 'react';
import type { CarouselStepResult } from './carouselController';
import type { HandCursorInput } from './handCursorTypes';

interface Props {
  input: HandCursorInput;
  carouselRef: { current: CarouselStepResult | undefined };
}

function vectorText(vector: { x: number; y: number; z: number } | undefined): string {
  if (!vector) return '—';
  return `${vector.x.toFixed(2)}, ${vector.y.toFixed(2)}, ${vector.z.toFixed(2)}`;
}

function velocityText(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(0)}°/s`;
}

/** Overlay de diagnóstico real do pipeline de mão/carrossel; só existe com ?handDebug=1. */
export function HandDebugOverlay({ input, carouselRef }: Props) {
  const enabled = useMemo(() => new URLSearchParams(window.location.search).get('handDebug') === '1', []);
  const [, setRefresh] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setRefresh((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, [enabled]);
  if (!enabled) return null;

  const carousel = carouselRef.current;
  const dtMs = input.rotationDtMs;
  const fps = dtMs && dtMs > 0 ? 1000 / dtMs : undefined;
  const carouselDtMs = carousel?.dtMs;
  const carouselFps = carouselDtMs && carouselDtMs > 0 ? 1000 / carouselDtMs : undefined;
  return <aside className="hand-debug" aria-label="Diagnóstico do gesto rotacional">
    <strong>hand debug</strong>
    <dl>
      <dt>fase</dt><dd>{input.rotationPhase}</dd>
      <dt>forma</dt><dd>{input.rotationHandShape ?? '—'} · curvatura {input.rotationCurvature?.toFixed(2) ?? '—'}</dd>
      <dt>normal palma</dt><dd>{vectorText(input.rotationOrientation?.zAxis)}</dd>
      <dt>eixo punho→médio</dt><dd>{vectorText(input.rotationOrientation?.yAxis)}</dd>
      <dt>ω bruta</dt><dd>{velocityText(input.rotationRawAngularVelocity)}</dd>
      <dt>ω filtrada</dt><dd>{velocityText(input.rotationFilteredAngularVelocity)}</dd>
      <dt>ω controle</dt><dd>{velocityText(input.rotationAngularVelocity)}</dd>
      <dt>direção</dt><dd>{input.rotationDirection}</dd>
      <dt>dt mão</dt><dd>{dtMs === undefined ? '—' : `${dtMs.toFixed(1)} ms`}{fps ? ` · ${fps.toFixed(1)} fps` : ''}</dd>
      <dt>rejeição</dt><dd>{input.rotationRejectReason ?? '—'}</dd>
      <dt>carrossel</dt><dd>{carousel ? `${carousel.mode} · ${velocityText(carousel.velocityDegPerSec)} · canal ${carousel.front}` : 'fora da roda'}</dd>
      <dt>turn / dt roda</dt><dd>{carousel ? `${carousel.turn.toFixed(3)} · ${carouselDtMs?.toFixed(1) ?? '—'} ms${carouselFps ? ` · ${carouselFps.toFixed(1)} fps` : ''}` : '—'}</dd>
    </dl>
  </aside>;
}
