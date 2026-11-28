// The user's hand as the site's pointer: the 3D ASCII hand on a full-screen, click-through canvas, with the
// index fingertip exactly on the pointer that hit-tests the DOM. Lazy-loaded; mounted while the camera is
// wanted, outside the arena.
//
// State: camera frames write the pose smoother (subscription); the render loop only reads it and the latest
// pointer input. The canvas and its GL context live and die with the effect.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useSiteHand, useSiteHandInput } from '../app/SiteHandContext';
import { disposeObjectTree } from '../games/core/GameLoop';
import { smoothstep } from '../lib/ascii';
import { cameraDistance, HAND_FOV, screenToPlane, stageProjection } from '../lib/handPlacement';
import { CREATOR_HAND_POSE, HandRigSmoother, mapObservationToRig, sampleIdleHand } from '../lib/handRig';
import { rotationBlocksHandInput } from '../ui/handCursorTypes';
import { useHandHitTest } from '../ui/useHandHitTest';
import { createAsciiPass } from './handAsciiPass';
import { addHandLights, createHand, paintHands } from './handMesh';

/** Width handed to the ASCII pass to pick small cells: the hand is far smaller than the viewport. */
const ASCII_CELL_WIDTH = 550;
const RADIUS = 14;
const LENGTH = 2 * Math.PI * RADIUS;

interface Props {
  /** On /product the hand rises out of the fresco, and a closed fist does not go back. */
  onProduct: boolean;
  onBack: () => void;
}

export default function SiteAsciiHand({ onProduct, onBack }: Props) {
  const { camera, subscribe } = useSiteHand();
  const input = useSiteHandInput();
  const live = camera === 'on';
  const backProgress = onProduct ? 0 : input.backProgress;
  const [settled, setSettled] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  useHandHitTest({ ...input, backProgress }, live && settled, onBack);

  const hostRef = useRef<HTMLDivElement>(null);
  const smootherRef = useRef<HandRigSmoother | null>(null);
  smootherRef.current ??= new HandRigSmoother();
  const smoother = smootherRef.current;
  const settledRef = useRef(false);
  const pointerRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const stateRef = useRef({ live, onProduct });
  stateRef.current = { live, onProduct };
  if (input.visible) pointerRef.current = { x: input.x, y: input.y };

  // The confirmation outlasts the pinchRelease frame; the key restarts it on every click.
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (input.pinchRelease) setFlash((count) => count + 1);
  }, [input.pinchRelease]);

  useEffect(
    () =>
      subscribe((snapshot, aspectY) => {
        const hand = snapshot.hands[0];
        const pose = hand && mapObservationToRig(hand, aspectY);
        if (pose) smoother.observe(pose, performance.now());
      }),
    [subscribe, smoother],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // A canvas per effect run: its context is force-released on cleanup and cannot be reused.
    const canvas = document.createElement('canvas');
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    } catch {
      settledRef.current = true;
      setSettled(true);
      setWebglFailed(true);
      return; // Without WebGL the pointer still works, it is just not drawn.
    }
    host.prepend(canvas);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));

    const scene = new THREE.Scene();
    const view = new THREE.PerspectiveCamera(HAND_FOV, 1, 0.1, 100);
    const rim = addHandLights(scene);
    const hand = createHand();
    const spark = new THREE.Group();
    spark.add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), hand.accent));
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      const ray = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 0.05), hand.accent);
      ray.rotation.z = angle;
      spark.add(ray);
    }
    scene.add(hand.group, spark);
    const ascii = createAsciiPass(renderer, () => undefined);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let width = 1;
    let height = 1;
    let frame = 0;
    let contextLost = false;
    let blank = false;

    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      if (contextLost) return;
      const { live, onProduct } = stateRef.current;
      const idle = sampleIdleHand(reducedMotion.matches ? 0 : now / 1000);
      const clock = performance.now();
      const pose = smoother.sample(clock, idle);
      const pointer = pointerRef.current;
      const presence = pointer ? smoother.presence(clock) : 0;
      const nextSettled = presence >= 0.98;
      if (settledRef.current !== nextSettled) {
        settledRef.current = nextSettled;
        setSettled(nextSettled);
      }
      const raised = presence * presence * (3 - 2 * presence);
      const stageCanvas = onProduct ? document.querySelector('.hand-stage-canvas') : null;
      const stage = stageCanvas ? stageProjection(stageCanvas.getBoundingClientRect()) : undefined;

      const pointerScale = Math.max(45, Math.min(90, Math.min(width, height) * 0.1));
      const tip = pose.joints[8]!;
      // At rest the hand sits where Adam is in the fresco, or below the screen on other pages.
      const idleTip = idle.joints[8]!;
      const rest = stage
        ? stage.toScreen({ x: idle.offset.x + idleTip.x, y: idle.offset.y + idleTip.y })
        : { x: pointer?.x ?? width / 2, y: height + 3 * pointerScale };
      const target = pointer ?? rest;
      // Exactly on the pointer once fully present.
      const anchor = { x: rest.x + (target.x - rest.x) * raised, y: rest.y + (target.y - rest.y) * raised };
      const restScale = stage?.pxPerUnit ?? pointerScale;
      const scale = restScale + (pointerScale - restScale) * raised;

      view.position.z = cameraDistance(height, scale);
      const world = screenToPlane(anchor, width, height, view.position.z);
      hand.update(pose);
      hand.group.position.set(world.x - tip.x, world.y - tip.y, -tip.z);
      hand.group.visible = live && (stage !== undefined || presence > 0);

      // The spark answers the user's own index nearing the Creator's, never the resting pose.
      spark.visible = false;
      if (live && stage && presence > 0) {
        const { offset, joints } = CREATOR_HAND_POSE;
        const creator = stage.toScreen({ x: offset.x + joints[8]!.x, y: offset.y + joints[8]!.y });
        const distance = Math.hypot(anchor.x - creator.x, anchor.y - creator.y) / stage.pxPerUnit;
        const strength = smoothstep(0.85, 0.25, distance);
        if (strength > 0) {
          const middle = { x: (anchor.x + creator.x) / 2, y: (anchor.y + creator.y) / 2 };
          const at = screenToPlane(middle, width, height, view.position.z);
          const pulse = reducedMotion.matches ? 1 : 1 + 0.2 * Math.sin(now / 90);
          spark.position.set(at.x, at.y, 0);
          spark.scale.setScalar(strength * pulse * (stage.pxPerUnit / scale));
          spark.visible = true;
        }
      }
      // An unchanged empty canvas is not redrawn: recompositing a full-screen layer is not free.
      const empty = !hand.group.visible && !spark.visible;
      if (!(empty && blank)) ascii.render(scene, view);
      blank = empty;
    };

    const resize = () => {
      width = host.clientWidth || window.innerWidth;
      height = host.clientHeight || window.innerHeight;
      renderer.setSize(width, height, false);
      ascii.setSize(ASCII_CELL_WIDTH);
      view.aspect = width / height;
      view.updateProjectionMatrix();
      blank = false;
    };
    const applyTheme = () => ascii.setLight(paintHands(canvas, [hand], rim));
    // Preventing the default is what lets the browser hand the context back.
    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
    };
    const onContextRestored = () => {
      contextLost = false;
      blank = false;
    };

    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);
    window.addEventListener('resize', resize);
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    applyTheme();
    resize();
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      themeObserver.disconnect();
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      disposeObjectTree(scene);
      ascii.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, [smoother]);

  const acting = live && input.visible && input.synced && !rotationBlocksHandInput(input.rotationPhase);

  return (
    <div ref={hostRef} className="hand-layer" aria-hidden="true">
      {pointerRef.current && (
        <div className="site-tip" style={{ transform: `translate3d(${pointerRef.current.x}px, ${pointerRef.current.y}px, 0)` }}>
          {webglFailed && live && input.visible && <span className="site-tip-cross">+</span>}
          {acting && input.pinching && <span className="site-tip-pulse" />}
          {acting && backProgress > 0 && (
            <svg className="site-tip-ring" viewBox="0 0 32 32" aria-hidden="true">
              <circle
                cx="16"
                cy="16"
                r={RADIUS}
                strokeDasharray={LENGTH}
                strokeDashoffset={LENGTH * (1 - Math.min(1, backProgress))}
              />
            </svg>
          )}
          {flash > 0 && <span className="site-tip-flash" key={flash} />}
        </div>
      )}
    </div>
  );
}
