/**
 * Diagnostic keys (G records a scripted session, E saves the last seconds) are for development:
 * a visitor brushing G mid-race would reset the detectors. On with `?debug` or `?fotos`, or in dev.
 */
export function diagnosticsEnabled(search: string = globalThis.location?.search ?? '', dev = import.meta.env.DEV): boolean {
  const params = new URLSearchParams(search);
  return dev || params.has('debug') || params.has('fotos');
}
