import { useRef } from 'react';
import { type HandInputStore, useHandInput } from './handInputStore';
import { useHandHitTest } from './useHandHitTest';

const RADIUS = 34;
const LENGTH = 2 * Math.PI * RADIUS;
/** Ring progress is rendered in 5% steps, so a filling ring does not re-render at camera rate. */
const quantize = (progress: number) => Math.round(Math.min(1, Math.max(0, progress)) * 20) / 20;

interface Props {
  store: HandInputStore;
  /** Falso fora dos menus com a aba de mão: o cursor se despede e deixa de interagir. */
  active: boolean;
  onBack: () => void;
}

export function HandCursor({ store, active, onBack }: Props) {
  const cursorRef = useRef<HTMLDivElement>(null);
  useHandHitTest(store, active, onBack, cursorRef);
  const visible = useHandInput(store, (hand) => hand.current.visible);
  // Ao sair, o cursor some com a aparência da última amostra visível, não a do frame já sem mão.
  const synced = useHandInput(store, (hand) => hand.lastVisible.synced);
  const pinching = useHandInput(store, (hand) => hand.lastVisible.pinching);
  const back = useHandInput(store, (hand) => hand.lastVisible.backProgress > 0);
  const rotation = useHandInput(store, (hand) => hand.lastVisible.rotationPhase);
  const progress = useHandInput(store, ({ lastVisible }) =>
    quantize(lastVisible.backProgress > 0 ? lastVisible.backProgress : lastVisible.synced ? 0 : lastVisible.syncProgress),
  );
  // A confirmação dura mais que o frame do pinchRelease; cada clique reinicia a animação pela key.
  const flash = useHandInput(store, (hand) => hand.clicks);

  const rotating = rotation === 'ROTATING' || rotation === 'RECOVERY';
  const braking = rotation === 'BRAKING' || rotation === 'SNAP_TO_CARD';
  const rotationClass = rotating ? 'rotating' : braking ? 'braking' : rotation === 'ROTATION_CANDIDATE' ? 'rotation-candidate' : '';
  const state = back ? 'back' : synced ? 'synced' : progress > 0 ? 'syncing' : 'searching';
  const classes = ['hand-cursor', state, rotationClass, pinching ? 'pinching' : '', active && visible ? '' : 'off'].filter(Boolean).join(' ');

  return <div className="hand-layer" aria-hidden="true">
    {/* O transform é escrito direto no elemento pelo loop de useHandHitTest. */}
    <div ref={cursorRef} className={classes}>
      <div className="hand-body">
        <svg className="hand-ring" viewBox="0 0 80 80" aria-hidden="true">
          <circle className="track" cx="40" cy="40" r={RADIUS} />
          <circle className="fill" opacity={progress > 0 ? 1 : 0} cx="40" cy="40" r={RADIUS} strokeDasharray={LENGTH} strokeDashoffset={LENGTH * (1 - progress)} />
        </svg>
        {pinching && <span className="hand-pulse" />}
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
