import { type RefObject, useEffect, useState } from 'react';

/** Which chip draws WebGL; "SwiftShader" or "Basic Render" means the browser is drawing on the CPU. */
function graphicsName(): string {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return 'sem WebGL';
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return name;
}

/**
 * Shown with `?fps` in the address: screen, camera and pose rates, to tell which of the three is
 * stuttering. Owns its counters; `poseFrames` is only read.
 */
export function PerfMeter({ videoRef, poseFrames, poseDelay }: { videoRef: RefObject<HTMLVideoElement | null>; poseFrames: RefObject<number>; poseDelay: RefObject<number> }) {
  const [text, setText] = useState('medindo…');
  useEffect(() => {
    const gpu = graphicsName();
    let screen = 0, camera = 0, worstMs = 0, last = performance.now(), since = last;
    let pose = poseFrames.current, lastTime = -1, frame = 0;
    const tick = (now: number) => {
      screen += 1;
      worstMs = Math.max(worstMs, now - last);
      last = now;
      const time = videoRef.current?.currentTime ?? -1;
      if (time !== lastTime) { camera += 1; lastTime = time; }
      if (now - since >= 1000) {
        const rate = (count: number) => Math.round((count * 1000) / (now - since));
        setText(`tela ${rate(screen)} fps (pior ${Math.round(worstMs)} ms) · câmera ${rate(camera)} · pose ${rate(poseFrames.current - pose)} · atraso ${Math.round(poseDelay.current)} ms · ${gpu}`);
        screen = camera = worstMs = 0;
        pose = poseFrames.current;
        since = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [videoRef, poseFrames, poseDelay]);
  return <div className="perf-meter">{text}</div>;
}
