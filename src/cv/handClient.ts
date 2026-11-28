import { type Delegate, HandClient as CoreHandClient, type HandClientAssets, type HandClientCallbacks } from '@wii/spatial-core';
import { preferredDelegate } from './delegate';
import { HAND_MODEL_SHA8, MEDIAPIPE_WASM_VERSION } from './mediapipeAssets';

export type { HandClientCallbacks } from '@wii/spatial-core';

function defaultHandAssets(): HandClientAssets {
  const base = `${import.meta.env.BASE_URL}mediapipe`;
  const wasmBaseUrl = new URL(`${base}/wasm-${MEDIAPIPE_WASM_VERSION}`, location.origin).href;
  return {
    wasmBaseUrl,
    modelUrl: new URL(`${base}/models/hand_landmarker.${HAND_MODEL_SHA8}.task`, location.origin).href,
  };
}

export class HandClient extends CoreHandClient {
  constructor(assets: HandClientAssets = defaultHandAssets()) {
    super(assets);
  }

  override init(callbacks: HandClientCallbacks, preferred: Delegate = preferredDelegate()): Promise<void> {
    return super.init(callbacks, preferred);
  }

  static warmVisionAssets(): void {
    const { wasmBaseUrl, modelUrl } = defaultHandAssets();
    const urls = [
      `${wasmBaseUrl}/vision_wasm_module_internal.js`,
      `${wasmBaseUrl}/vision_wasm_module_internal.wasm`,
      modelUrl,
    ];
    for (const url of urls) {
      void fetch(url)
        .then((response) => (response.ok ? response.arrayBuffer() : undefined))
        .catch(() => undefined);
    }
  }
}
