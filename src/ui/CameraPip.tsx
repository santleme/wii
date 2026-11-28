import { type RefObject, useEffect, useState } from 'react';

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cameraOn: boolean;
  status: string;
  tracking: string;
  onStart: () => void;
  onStop: () => void;
}

export function CameraPip(props: Props) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!props.cameraOn) setExpanded(false);
  }, [props.cameraOn]);

  return <aside
    className={expanded ? 'cam-pip expanded' : 'cam-pip'}
  >
    <div className="cam-feed">
      {/* Invariante (PR #40): este <video> nunca monta sob condição — trocar o elemento
          faz o videoRef perder o srcObject e quebra a captura. Não condicionar. */}
      <video ref={props.videoRef} autoPlay muted playsInline />
      <canvas ref={props.canvasRef} />
      {!props.cameraOn && <div className="cam-empty"><strong>SEM SINAL</strong><small>processado neste dispositivo</small></div>}
      {props.cameraOn && <span className="tracking-chip">{props.tracking}</span>}
    </div>
    <div className="cam-bar">
      {!props.cameraOn ? <button type="button" className="pip-btn primary" onClick={props.onStart}>ATIVAR CÂMERA</button> : <>
        <button type="button" className="pip-btn icon" onClick={props.onStop} title="Desligar câmera">⏻</button>
        <button type="button" className="pip-btn" onClick={() => setExpanded(!expanded)}>{expanded ? 'MINIMIZAR' : 'AMPLIAR'}</button>
      </>}
    </div>
    <div className="cam-status">{props.status}</div>
  </aside>;
}
