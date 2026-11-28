import { useEffect, useRef } from 'react';
import { createCrystalField, impulseCrystal, stepCrystal, updateCrystalBase } from './crystalField';

const GLYPHS = ' .:+=xX#%@';
const LEVELS = 5;

/** Signed cross-section of one leaning, pointed crystal in normalized coordinates. */
function crystalSection(x: number, y: number, center: number, tip: number, bottom: number, halfWidth: number, lean: number): number {
  if (y < tip || y > bottom) return -1;
  const length = bottom - tip;
  const along = (y - tip) / length;
  const axis = center + (0.5 - along) * lean;
  const width = halfWidth * Math.min(1, along * 3.3, (1 - along) * 4.5);
  return width - Math.abs(x - axis);
}

/** Decorative canvas: the parent owns interaction, so the artwork never covers controls. */
export default function CrystalAsciiField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const surface = canvas?.parentElement;
    const host = surface?.parentElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !surface || !host || !ctx) return;

    const atlas = document.createElement('canvas');
    const atlasCtx = atlas.getContext('2d');
    if (!atlasCtx) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let field = createCrystalField(2, 2);
    let width = 0;
    let height = 0;
    let cellW = 0;
    let cellH = 0;
    let spriteW = 0;
    let spriteH = 0;
    let dpr = 1;
    let frame = 0;
    let last = 0;
    let time = 0;
    let visible = false;
    let disposed = false;
    let pointerX = -1;
    let pointerY = -1;
    let pointerDown = false;
    let lastPulse = 0;
    let darkTheme = document.body.classList.contains('dark');
    let crystalMask = new Float32Array(4);
    let crystalFacet = new Float32Array(4);
    let crystalEdge = new Float32Array(4);

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const { cols, rows, heights, velocities } = field;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = y * cols + x;
          const nx = (x / (cols - 1) - 0.5) * 2;
          const ny = (y / (rows - 1) - 0.5) * 2;
          if (crystalMask[i] === 0) continue;
          const z = heights[i];
          const displacement = z - field.baseHeights[i];
          const dx = heights[y * cols + Math.min(cols - 1, x + 1)] - heights[y * cols + Math.max(0, x - 1)];
          const dy = heights[Math.min(rows - 1, y + 1) * cols + x] - heights[Math.max(0, y - 1) * cols + x];
          const edge = crystalEdge[i];
          const facet = crystalFacet[i];
          // A slow sweep of light and fine strata give the solid a living surface.
          const glint = Math.max(0, 1 - Math.abs(nx * 0.8 + ny * 0.55 - Math.sin(time * 0.2) * 0.7) * 5);
          const strata = Math.abs(Math.sin(ny * 32 + nx * 12 - time * 0.45));
          const shade = Math.max(0, Math.min(0.999, facet + z * 0.09 - dx * 0.6 - dy * 0.35 + glint * 0.15 + (strata > 0.96 ? 0.12 : 0)));
          const isEdge = edge < 0.025;
          const glyph = isEdge ? 6 : Math.max(1, Math.floor(shade * GLYPHS.length));
          const energy = Math.abs(displacement) + Math.abs(velocities[i]) * 0.12;
          const accent = isEdge || glint > 0.68 || energy > 0.1 ? 1 : 0;
          const level = isEdge ? 3 : Math.min(LEVELS - 1, Math.floor((0.34 + shade * 0.66) * LEVELS));
          ctx.drawImage(atlas, glyph * spriteW, (accent * LEVELS + level) * spriteH, spriteW, spriteH, x * cellW, y * cellH - displacement * cellH * 1.8, spriteW / dpr, spriteH / dpr);
        }
      }
    };

    const tick = (now: number) => {
      frame = 0;
      if (!visible || document.hidden || motion.matches || disposed) return;
      const dt = last ? Math.min((now - last) / 1000, 0.033) : 0;
      last = now;
      time += dt;
      updateCrystalBase(field, time);
      if (pointerDown && pointerX >= 0 && now - lastPulse > 330) {
        impulseCrystal(field, pointerX, pointerY, -0.9, 4.5);
        lastPulse = now;
      }
      stepCrystal(field, dt);
      draw();
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      if (visible && !document.hidden && !motion.matches && !disposed) frame = requestAnimationFrame(tick);
    };
    const layout = () => {
      const rect = surface.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      width = rect.width;
      height = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cols = Math.max(36, Math.min(100, Math.round(width / 7)));
      const rows = Math.max(24, Math.min(70, Math.round(height / 11)));
      cellW = width / cols;
      cellH = height / rows;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      field = createCrystalField(cols, rows);
      updateCrystalBase(field, time);
      field.heights.set(field.baseHeights);
      crystalMask = new Float32Array(cols * rows);
      crystalFacet = new Float32Array(cols * rows);
      crystalEdge = new Float32Array(cols * rows);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const nx = (x / (cols - 1) * 2 - 1) * 0.82;
          const ny = y / (rows - 1) * 2 - 1;
          let section = crystalSection(nx, ny, -0.08, -0.92, 0.84, 0.31, -0.13);
          let axis = -0.08 + (0.5 - (ny + 0.92) / 1.76) * -0.13;
          let face = 0.36;
          // Foreground shards cover the main pillar and each other.
          const left = crystalSection(nx, ny, -0.41, -0.52, 0.78, 0.24, -0.13);
          if (left >= 0) { section = left; axis = -0.41 + (0.5 - (ny + 0.52) / 1.3) * -0.13; face = 0.30; }
          const right = crystalSection(nx, ny, 0.34, -0.67, 0.76, 0.24, 0.16);
          if (right >= 0) { section = right; axis = 0.34 + (0.5 - (ny + 0.67) / 1.43) * 0.16; face = 0.39; }
          if (section < 0) continue;
          const i = y * cols + x;
          crystalMask[i] = 1;
          crystalEdge[i] = section;
          const facePosition = nx - axis;
          const seam = Math.abs(facePosition + 0.035);
          if (seam < crystalEdge[i]) crystalEdge[i] = seam;
          crystalFacet[i] = face + (facePosition < -0.035 ? 0.19 : -0.08) + Math.max(0, -ny) * 0.04;
        }
      }
      spriteW = Math.ceil(cellW * dpr * 1.4);
      spriteH = Math.ceil(cellH * dpr * 1.4);
      atlas.width = spriteW * GLYPHS.length;
      atlas.height = spriteH * LEVELS * 2;
      const dark = darkTheme;
      atlasCtx.font = `${Math.min(cellH * 0.9, cellW * 1.55) * dpr}px "DM Mono", monospace`;
      atlasCtx.textBaseline = 'middle';
      for (let accent = 0; accent < 2; accent++) {
        for (let level = 0; level < LEVELS; level++) {
          atlasCtx.fillStyle = accent ? (dark ? '#b5d9d8' : '#167e9a') : (dark ? '#e5e9e1' : '#26343b');
          atlasCtx.globalAlpha = (0.30 + level * 0.14) * (accent ? 0.9 : 1);
          for (let glyph = 1; glyph < GLYPHS.length; glyph++) {
            atlasCtx.fillText(GLYPHS[glyph], glyph * spriteW, (accent * LEVELS + level + 0.5) * spriteH);
          }
        }
      }
      atlasCtx.globalAlpha = 1;
      draw();
    };
    const position = (event: PointerEvent) => {
      const rect = surface.getBoundingClientRect();
      pointerX = (event.clientX - rect.left) / rect.width * (field.cols - 1);
      pointerY = (event.clientY - rect.top) / rect.height * (field.rows - 1);
      if (pointerX < 0 || pointerX >= field.cols || pointerY < 0 || pointerY >= field.rows) { pointerX = -1; pointerY = -1; }
    };
    const isControl = (target: EventTarget | null) => target instanceof Element && !!target.closest('button, a, input, select, textarea');
    const onMove = (event: PointerEvent) => {
      if (motion.matches || (event.pointerType === 'touch' && !pointerDown)) return;
      if (isControl(event.target)) { pointerX = -1; pointerY = -1; return; }
      position(event);
      if (pointerX >= 0) impulseCrystal(field, pointerX, pointerY, -0.12, 4);
    };
    const onDown = (event: PointerEvent) => {
      if (motion.matches || isControl(event.target)) return;
      position(event);
      if (pointerX < 0) return;
      pointerDown = true;
      impulseCrystal(field, pointerX, pointerY, -1.5, 4.5);
      lastPulse = performance.now();
    };
    const onLeave = () => { pointerX = -1; pointerY = -1; };
    const onUp = () => { pointerDown = false; };
    const onVisibilityChange = () => { if (document.hidden) onUp(); sync(); };
    const resize = new ResizeObserver(layout);
    resize.observe(surface);
    const intersection = new IntersectionObserver((entries) => { visible = entries[0]?.isIntersecting ?? false; sync(); });
    intersection.observe(surface);
    const theme = new MutationObserver(() => {
      const next = document.body.classList.contains('dark');
      if (next !== darkTheme) { darkTheme = next; layout(); }
    });
    theme.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerleave', onLeave);
    host.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', layout);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    document.addEventListener('visibilitychange', onVisibilityChange);
    motion.addEventListener('change', sync);
    layout();
    void document.fonts.ready.then(() => { if (!disposed) layout(); });
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      intersection.disconnect();
      theme.disconnect();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      host.removeEventListener('pointerdown', onDown);
      window.removeEventListener('resize', layout);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      motion.removeEventListener('change', sync);
    };
  }, []);

  return <div className="papers-ascii-bg" aria-hidden="true"><canvas ref={canvasRef} className="crystal-ascii-canvas" /></div>;
}
