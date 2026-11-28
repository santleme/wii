// GPU ASCII post-process for the /product hand: the scene renders into a target, then a fullscreen quad
// swaps each cell for a glyph from an atlas. The CPU never reads pixels back.
import * as THREE from 'three';
import { chooseGlyph, rankGlyphs } from '../lib/ascii';

const GLYPH_LEVELS = 24;
/** Glyphs are ranked on cells this many times larger than drawn, where coverage is measurable. */
const RANK_SCALE = 4;

const vertexShader = /* glsl */ `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tAtlas;
  uniform vec2 uResolution;
  uniform vec2 uCellSize;
  uniform float uGlyphCount;
  uniform float uIsLight;

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  void main() {
    vec2 grid = gl_FragCoord.xy / uCellSize;
    vec2 localUv = fract(grid);
    vec4 sceneColor = texture2D(tDiffuse, (floor(grid) + 0.5) * uCellSize / uResolution);
    if (sceneColor.a < 0.05) discard;

    // The target holds linear, edge-premultiplied color; glyphs are chosen and tinted in sRGB.
    vec3 color = pow(clamp(sceneColor.rgb / sceneColor.a, 0.0, 1.0), vec3(1.0 / 2.2));
    float lum = dot(color, LUMA);
    float tone = smoothstep(0.12, 0.88, lum);

    float density;
    if (uIsLight > 0.5) {
      // Paper: shadows get the dense glyphs, and the floor keeps highlights visible.
      density = mix(0.38, 1.0, 1.0 - tone);
      float gray = dot(color, LUMA);
      color = clamp(gray + (color - gray) * 2.8, 0.0, 1.0);
      color *= min(1.0, 0.4 / max(dot(color, LUMA), 0.001));
    } else {
      density = mix(0.16, 1.0, tone);
      color = clamp(color * 1.15 + 0.08, 0.0, 1.0);
    }

    float index = floor(density * (uGlyphCount - 1.0) + 0.5);
    float mask = texture2D(tAtlas, vec2((index + localUv.x) / uGlyphCount, localUv.y)).a;
    // The canvas expects premultiplied alpha.
    gl_FragColor = vec4(color * mask, mask);
  }
`;

/** Evenly spaced steps of the site's glyph ramp, lightest first. */
function glyphRamp(cellW: number, cellH: number): string[] {
  const ranked = rankGlyphs(`${cellH * RANK_SCALE}px "DM Mono", monospace`, cellW * RANK_SCALE, cellH * RANK_SCALE);
  const densest = ranked[0]!.darkness;
  const ramp = new Set<string>();
  for (let level = 1; level <= GLYPH_LEVELS; level += 1) {
    const { character } = chooseGlyph(ranked, (densest * level) / GLYPH_LEVELS);
    if (character !== ' ') ramp.add(character);
  }
  return [...ramp];
}

/** One white-on-transparent row of glyphs, tiled at device-pixel cell size so sampling stays 1:1. */
function createAtlas(cellW: number, cellH: number) {
  const ramp = glyphRamp(cellW, cellH);
  const canvas = document.createElement('canvas');
  canvas.width = cellW * ramp.length;
  canvas.height = cellH;
  const context = canvas.getContext('2d');
  if (context) {
    context.font = `500 ${cellH}px "DM Mono", monospace`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#fff';
    ramp.forEach((character, index) => {
      context.fillText(character, (index + 0.5) * cellW, cellH / 2, cellW);
    });
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return { texture, count: ramp.length };
}

/** `onChange` runs when the atlas is redrawn outside a resize, so on-demand renderers can repaint. */
export function createAsciiPass(renderer: THREE.WebGLRenderer, onChange: () => void) {
  const target = new THREE.WebGLRenderTarget(1, 1);
  const uniforms = {
    tDiffuse: { value: target.texture },
    tAtlas: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCellSize: { value: new THREE.Vector2(8, 10) },
    uGlyphCount: { value: 1 },
    uIsLight: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  const geometry = new THREE.PlaneGeometry(2, 2);
  const quadScene = new THREE.Scene();
  quadScene.add(new THREE.Mesh(geometry, material));
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let disposed = false;

  const redrawAtlas = () => {
    const { x, y } = uniforms.uCellSize.value;
    const { texture, count } = createAtlas(x, y);
    uniforms.tAtlas.value?.dispose();
    uniforms.tAtlas.value = texture;
    uniforms.uGlyphCount.value = count;
  };
  redrawAtlas();
  // The first atlas may use the fallback font; redraw once DM Mono is available.
  void document.fonts
    ?.load('500 12px "DM Mono"')
    .then(() => document.fonts.ready)
    .then(() => {
      if (disposed) return;
      redrawAtlas();
      onChange();
    })
    .catch(() => undefined);

  return {
    /** Call after `renderer.setSize`, with the canvas width in CSS pixels. */
    setSize(cssWidth: number) {
      const size = renderer.getDrawingBufferSize(uniforms.uResolution.value);
      target.setSize(size.x, size.y);
      // Narrow stages get smaller cells so each finger still spans more than one.
      const cell = Math.max(5, Math.min(8, cssWidth / 110)) * renderer.getPixelRatio();
      const cellW = Math.round(cell);
      const cellH = Math.round(cell * 1.2);
      if (uniforms.uCellSize.value.x === cellW && uniforms.uCellSize.value.y === cellH) return;
      uniforms.uCellSize.value.set(cellW, cellH);
      redrawAtlas();
    },
    setLight(light: boolean) {
      uniforms.uIsLight.value = light ? 1 : 0;
    },
    render(scene: THREE.Scene, camera: THREE.Camera) {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(quadScene, quadCamera);
    },
    dispose() {
      disposed = true;
      target.dispose();
      uniforms.tAtlas.value?.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
