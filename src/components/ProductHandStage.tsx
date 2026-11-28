// "The Creation of Adam" on /product. Lazy-loaded so Three.js stays out of the main bundle.
//
// With the camera off this stage owns Adam's hand. With it on, Adam leaves the frame: SiteAsciiHand draws
// him across the whole site, and only the Creator stays here.
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { type SiteCameraError, useSiteHand } from '../app/SiteHandContext';
import { disposeObjectTree } from '../games/core/GameLoop';
import { useLang } from '../i18n';
import { HAND_FOV, STAGE_VIEW } from '../lib/handPlacement';
import { CREATOR_HAND_POSE, sampleIdleHand } from '../lib/handRig';
import { createAsciiPass } from './handAsciiPass';
import { addHandLights, createHand, paintHands } from './handMesh';

export type ProductHandStageHandle = {
  /** Stops rendering before the arena transition. */
  shutdown(): void;
};

/** The static upper-right half of the fresco: the Creator's hand. */
function createCreator() {
  const hand = createHand();
  hand.update(CREATOR_HAND_POSE);
  const { x, y, z } = CREATOR_HAND_POSE.offset;
  hand.group.position.set(x, y, z);
  return hand;
}

export default function ProductHandStage({ ref }: { ref?: Ref<ProductHandStageHandle> }) {
  const { tr } = useLang();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const wakeRef = useRef<() => void>(() => undefined);
  const shutdownRef = useRef(false);
  const liveRef = useRef(false);
  const { camera, error, enableCamera, stopCamera, warmAssets, getStream } = useSiteHand();
  const [noWebgl, setNoWebgl] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      shutdown() {
        shutdownRef.current = true;
      },
    }),
    [],
  );

  useEffect(() => {
    liveRef.current = camera === 'on';
    const video = videoRef.current;
    if (video) {
      video.srcObject = camera === 'on' ? (getStream() ?? null) : null;
      if (video.srcObject) void video.play().catch(() => undefined);
    }
    wakeRef.current();
  }, [camera, getStream]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    } catch {
      setNoWebgl(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

    const scene = new THREE.Scene();
    const view = new THREE.PerspectiveCamera(HAND_FOV, 1.5, 0.1, 50);
    view.position.set(0, STAGE_VIEW.y, STAGE_VIEW.z);
    const rim = addHandLights(scene);
    const hand = createHand();
    // The pivot sits on the palm center so drag rotation turns the hand in place.
    const pivot = new THREE.Group();
    pivot.add(hand.group);
    const creator = createCreator();
    scene.add(pivot, creator.group);

    const ascii = createAsciiPass(renderer, () => wake());

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const orbit = { yaw: 0, pitch: 0 };
    const hover = { x: 0, y: 0 };
    let drag: { id: number; x: number; y: number } | undefined;
    let frame = 0;
    let contextLost = false;
    let disposed = false;

    const blocked = () =>
      disposed || contextLost || shutdownRef.current || document.hidden || document.body.classList.contains('intro-active');

    const render = (now: number) => {
      const pose = sampleIdleHand(reducedMotion.matches ? 0 : now / 1000);
      const center = hand.update(pose);
      hand.group.position.copy(center).negate();
      pivot.position.set(pose.offset.x, pose.offset.y, pose.offset.z).add(center);
      pivot.rotation.set(orbit.pitch + hover.y, orbit.yaw + hover.x, 0);
      pivot.visible = !liveRef.current;
      ascii.render(scene, view);
    };

    const tick = (now: number) => {
      frame = 0;
      if (blocked()) return;
      render(now);
      if (!reducedMotion.matches) wake();
    };
    const wake = () => {
      if (!frame && !blocked()) frame = requestAnimationFrame(tick);
    };
    wakeRef.current = wake;

    const applyTheme = () => {
      ascii.setLight(paintHands(canvas, [hand, creator], rim));
    };

    const resize = () => {
      const { clientWidth, clientHeight } = canvas;
      if (!clientWidth || !clientHeight) return;
      renderer.setSize(clientWidth, clientHeight, false);
      ascii.setSize(clientWidth);
      view.aspect = clientWidth / clientHeight;
      view.updateProjectionMatrix();
      wake();
    };

    const rotate = (yaw: number, pitch: number) => {
      orbit.yaw += yaw;
      orbit.pitch = Math.max(-1.2, Math.min(1.2, orbit.pitch + pitch));
      wake();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (liveRef.current || event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (drag?.id === event.pointerId) {
        rotate((event.clientX - drag.x) * 0.01, (event.clientY - drag.y) * 0.01);
        drag = { id: drag.id, x: event.clientX, y: event.clientY };
      } else if (event.pointerType === 'mouse' && !reducedMotion.matches) {
        const box = canvas.getBoundingClientRect();
        hover.x = ((event.clientX - box.left) / box.width - 0.5) * 0.35;
        hover.y = ((event.clientY - box.top) / box.height - 0.5) * 0.25;
        wake();
      }
    };
    const onPointerEnd = () => {
      drag = undefined;
    };
    const onPointerLeave = () => {
      hover.x = 0;
      hover.y = 0;
      wake();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const step = {
        ArrowLeft: [-0.2, 0],
        ArrowRight: [0.2, 0],
        ArrowUp: [0, -0.2],
        ArrowDown: [0, 0.2],
      }[event.key];
      if (!step || liveRef.current) return;
      event.preventDefault();
      rotate(step[0]!, step[1]!);
    };
    // Preventing the default is what lets the browser hand the context back.
    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const onContextRestored = () => {
      contextLost = false;
      wake();
    };

    const listeners = [
      ['pointerdown', onPointerDown],
      ['pointermove', onPointerMove],
      ['pointerup', onPointerEnd],
      ['pointercancel', onPointerEnd],
      ['pointerleave', onPointerLeave],
      ['keydown', onKeyDown],
      ['webglcontextlost', onContextLost],
      ['webglcontextrestored', onContextRestored],
    ] as [string, EventListener][];
    for (const [type, listener] of listeners) canvas.addEventListener(type, listener);

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    // Body classes carry both the theme and `intro-active`.
    const bodyObserver = new MutationObserver(() => {
      applyTheme();
      wake();
    });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', wake);
    reducedMotion.addEventListener('change', wake);
    applyTheme();
    resize();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      wakeRef.current = () => undefined;
      resizeObserver.disconnect();
      bodyObserver.disconnect();
      document.removeEventListener('visibilitychange', wake);
      reducedMotion.removeEventListener('change', wake);
      for (const [type, listener] of listeners) canvas.removeEventListener(type, listener);
      disposeObjectTree(scene);
      ascii.dispose();
      renderer.dispose();
    };
  }, []);

  const errorText =
    error &&
    ({
      unsupported: tr(
        'A câmera exige HTTPS e um navegador compatível.',
        'The camera needs HTTPS and a supported browser.',
      ),
      denied: tr(
        'Permissão da câmera negada. Libere o acesso no navegador e tente de novo.',
        'Camera permission denied. Allow access in your browser and try again.',
      ),
      missing: tr('Nenhuma câmera encontrada.', 'No camera found.'),
      busy: tr(
        'A câmera está em uso por outro aplicativo.',
        'The camera is being used by another application.',
      ),
      failed: tr('Não foi possível iniciar o rastreamento da mão.', 'Hand tracking could not start.'),
    } satisfies Record<SiteCameraError, string>)[error];

  const buttonText =
    camera === 'on'
      ? tr('Desativar câmera', 'Turn camera off')
      : camera === 'starting'
        ? tr('Iniciando… cancelar', 'Starting… cancel')
        : error
          ? tr('Tentar novamente', 'Try again')
          : tr('Ativar câmera', 'Enable camera');

  return (
    <div className="hand-stage">
      <div className="hand-stage-view">
        <canvas
          ref={canvasRef}
          className="hand-stage-canvas"
          role="img"
          tabIndex={0}
          aria-label={tr(
            'A Criação de Adão em 3D. Arraste ou use as setas para girar a mão de Adão; com a câmera ativa, ela sai do quadro e vira o seu ponteiro.',
            'The Creation of Adam in 3D. Drag or use the arrow keys to rotate Adam’s hand; with the camera on, it leaves the frame and becomes your pointer.',
          )}
        />
        <video
          ref={videoRef}
          className={camera === 'on' ? 'hand-stage-pip is-visible' : 'hand-stage-pip'}
          muted
          playsInline
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
      <div className="hand-stage-controls">
        <button
          type="button"
          className="product-status"
          onPointerEnter={warmAssets}
          onFocus={warmAssets}
          onClick={() => {
            if (camera === 'off') void enableCamera();
            else stopCamera();
          }}
        >
          <span className={camera === 'on' ? 'status-dot is-live' : 'status-dot'} />
          {buttonText}
        </button>
        <p className="hand-stage-status" role="status">
          {noWebgl
            ? tr('Este navegador não conseguiu desenhar a mão em 3D.', 'This browser could not draw the 3D hand.')
            : (errorText ?? tr('O vídeo é processado no seu aparelho.', 'Video is processed on your device.'))}
        </p>
      </div>
    </div>
  );
}
