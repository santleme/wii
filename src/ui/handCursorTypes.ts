import type {
  PalmBasis,
  RotationalFlickPhase,
  RotationalFlickRejection,
  RotationalHandShape,
} from '@wii/spatial-core';

/** Contrato de entrada do cursor de mão. Quem o preenche é o pipeline de CV; a UI só consome. */
export type HandCursorInput = {
  /** Há mão rastreada e o modo 'hand' está ativo. */
  visible: boolean;
  /** Posição do ponteiro, em px da viewport. */
  x: number;
  y: number;
  /** 0..1 durante a sincronização. */
  syncProgress: number;
  synced: boolean;
  /** Pinça pressionada neste frame. */
  pinching: boolean;
  /** A pinça acabou de confirmar o clique. */
  pinchRelease: boolean;
  /** 0..1 do gesto sustentado de voltar/fechar. */
  backProgress: number;
  /** Timestamp de captura no relógio de alta resolução do navegador; usado para expirar amostras paradas. */
  capturedAtMs?: number;
  /** Fase da máquina rotacional; IDLE quando o gesto está desligado ou ausente. */
  rotationPhase: RotationalFlickPhase;
  /** Velocidade arbitrada pronta para o carrossel, em deg/s. */
  rotationAngularVelocity: number;
  rotationDirection: -1 | 0 | 1;
  /** Diagnóstico opcional: velocidade filtrada/bruta, curvatura, base 3D e qualidade temporal. */
  rotationFilteredAngularVelocity?: number;
  rotationRawAngularVelocity?: number;
  rotationCurvature?: number;
  rotationHandShape?: RotationalHandShape;
  rotationRejectReason?: RotationalFlickRejection;
  rotationDtMs?: number;
  rotationOrientation?: PalmBasis;
};

/** Sem dados de mão: nada é desenhado nem acionado. */
export const HAND_IDLE: HandCursorInput = {
  visible: false,
  x: 0,
  y: 0,
  syncProgress: 0,
  synced: false,
  pinching: false,
  pinchRelease: false,
  backProgress: 0,
  rotationPhase: 'IDLE',
  rotationAngularVelocity: 0,
  rotationDirection: 0,
};

/** Qualquer fase não ociosa bloqueia hover, clique e voltar até o próximo rearme gestual. */
export function rotationBlocksHandInput(phase: RotationalFlickPhase): boolean {
  return phase !== 'IDLE';
}
