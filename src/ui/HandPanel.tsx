import { type RefObject, useEffect, useRef } from 'react';

interface Props {
  /** Vídeo que já recebe o stream da câmera: a prévia reaproveita, sem outro getUserMedia. */
  sourceRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cameraOn: boolean;
  status: string;
  synced: boolean;
  onStart: () => void;
  onClose: () => void;
}

export function HandPanel({ sourceRef, canvasRef, cameraOn, status, synced, onStart, onClose }: Props) {
  const previewRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    preview.srcObject = cameraOn ? (sourceRef.current?.srcObject ?? null) : null;
    if (cameraOn) preview.play().catch(() => undefined);
  }, [cameraOn, sourceRef]);

  return <aside className="hand-panel" aria-label="Controle por mão">
    <div className="hand-preview">
      <video ref={previewRef} autoPlay muted playsInline />
      <canvas ref={canvasRef} />
      {!cameraOn && <strong>SEM SINAL</strong>}
    </div>
    <output className="hand-status" data-state={!cameraOn ? 'off' : synced ? 'synced' : 'searching'}>
      <i aria-hidden="true" />
      {!cameraOn ? status : synced ? 'Mão sincronizada ✓' : 'Mostre a mão para sincronizar…'}
    </output>
    <ul className="hand-legend">
      <li><b>Pinça</b> = clicar</li>
      <li><b>Segure o gesto</b> = Fechar/Voltar</li>
      <li><b>Aceno lateral</b> = girar a roda</li>
    </ul>
    <div className="hand-actions">
      {!cameraOn && <button type="button" className="wii-btn" onClick={onStart}>Ligar câmera</button>}
      <button type="button" className="wii-btn" onClick={onClose}>{cameraOn ? 'Desligar' : 'Fechar'}</button>
    </div>
  </aside>;
}
