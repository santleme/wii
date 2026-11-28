import { useEffect, useRef, useState } from 'react';
import type { HandCursorInput } from './handCursorTypes';
import { useHandHitTest } from './useHandHitTest';

const RADIUS = 34;
const LENGTH = 2 * Math.PI * RADIUS;

interface Props {
  input: HandCursorInput;
  /** Falso fora dos menus com a aba de mão: o cursor se despede e deixa de interagir. */
  active: boolean;
  onBack: () => void;
}

export function HandCursor({ input, active, onBack }: Props) {
  useHandHitTest(input, active, onBack);
  // A confirmação dura mais que o frame do pinchRelease; cada clique reinicia a animação pela key.
  const [flash, setFlash] = useState(0);
  useEffect(() => { if (input.pinchRelease) setFlash((count) => count + 1); }, [input.pinchRelease]);

  // Ao sair, o cursor some a partir da última posição visível, não do frame já sem mão.
  const lastVisible = useRef(input);
  if (input.visible) lastVisible.current = input;
  const shown = lastVisible.current;

  const back = shown.backProgress > 0;
  const progress = Math.min(1, Math.max(0, back ? shown.backProgress : shown.synced ? 0 : shown.syncProgress));
  const rotation = shown.rotationPhase;
  const rotating = rotation === 'ROTATING' || rotation === 'RECOVERY';
  const braking = rotation === 'BRAKING' || rotation === 'SNAP_TO_CARD';
  const rotationClass = rotating ? 'rotating' : braking ? 'braking' : rotation === 'ROTATION_CANDIDATE' ? 'rotation-candidate' : '';
  const state = back ? 'back' : shown.synced ? 'synced' : progress > 0 ? 'syncing' : 'searching';
  const classes = ['hand-cursor', state, rotationClass, shown.pinching ? 'pinching' : '', active && input.visible ? '' : 'off'].filter(Boolean).join(' ');

  return <div className="hand-layer" aria-hidden="true">
    <div className={classes} style={{ transform: `translate3d(${shown.x}px, ${shown.y}px, 0)` }}>
      <div className="hand-body">
        <svg className="hand-ring" viewBox="0 0 80 80" aria-hidden="true">
          <circle className="track" cx="40" cy="40" r={RADIUS} />
          <circle className="fill" opacity={progress > 0 ? 1 : 0} cx="40" cy="40" r={RADIUS} strokeDasharray={LENGTH} strokeDashoffset={LENGTH * (1 - progress)} />
        </svg>
        {shown.pinching && <span className="hand-pulse" />}
        {/* A ponta do indicador fica exatamente em (x, y). */}
        <svg className="hand-icon" viewBox="0 0 32 40" aria-hidden="true">
          <path d="M11 4a3 3 0 0 1 6 0v13l2-1a3 3 0 0 1 4 1 3 3 0 0 1 4 1c3 0 4 2 4 5v5c0 7-4 11-11 11-5 0-7-2-10-6l-6-9c-2-3 2-6 4-3l3 3z" />
        </svg>
        {back && <span className="hand-badge">↩</span>}
        {(rotating || braking) && <span className="hand-badge hand-rotation-badge">{braking ? '◉' : '↻'}</span>}
      </div>
      {flash > 0 && <span className="hand-flash" key={flash} />}
    </div>
  </div>;
}
