import * as THREE from 'three';

/** Shared sky dome used by each arena; each game owns and disposes its returned scene resources. */
export function createSkyDome(): { mesh: THREE.Mesh; topColor: THREE.Color; bottomColor: THREE.Color; dispose(): void } {
  const topColor = new THREE.Color(0x68c7ff);
  const bottomColor = new THREE.Color(0xe5f8ff);
  const geometry = new THREE.SphereGeometry(95, 16, 12);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: { topColor: { value: topColor }, bottomColor: { value: bottomColor } },
    vertexShader: `
      varying float vHeight;
      void main() {
        vHeight = normalize(position).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying float vHeight;
      void main() {
        gl_FragColor = vec4(mix(bottomColor, topColor, smoothstep(0.0, 0.4, vHeight)), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -1;
  return { mesh, topColor, bottomColor, dispose: () => { geometry.dispose(); material.dispose(); } };
}
