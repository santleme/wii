import type { Delegate } from '@wii/spatial-core';

/**
 * Vision runs on the CPU by default: on an integrated GPU it competes with the 3D game and the
 * camera stutters. `?delegate=gpu` opts back in on a machine with GPU to spare.
 */
export function preferredDelegate(search: string = globalThis.location?.search ?? ''): Delegate {
  return new URLSearchParams(search).get('delegate') === 'gpu' ? 'GPU' : 'CPU';
}

