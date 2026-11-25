import type { CalibrationProfile, Point3, PoseSnapshot } from './protocol';
import { Calibrator } from './calibrator';
import { distance2, landmarkConfidence, midpoint } from '../kinematics/math';

const SETTLE_MS = 1000;
const COLLECT_MS = 3000;
/** Quanto ombros ou quadris podem andar na imagem (0–1) e ainda contar como parado. */
const STILL_TOLERANCE = 0.04;
/** Ombros, punhos, quadris e joelhos: o que o Calibrator precisa enxergar. */
const REQUIRED = [11, 12, 15, 16, 23, 24, 25, 26] as const;
/** A postura em pé (salto e raia) só se verifica com os tornozelos: a corrida não abre mão dela. */
const REQUIRED_STANCE = [...REQUIRED, 27, 28] as const;

export type CalibrationPhase = 'framing' | 'settling' | 'collecting' | 'done';
export interface CalibrationStep { phase: CalibrationPhase; progress: number; profile?: CalibrationProfile }

/** Calibra sozinho: espera o corpo enquadrado e parado, coleta e tenta de novo se falhar. */
export class AutoCalibrator {
  private readonly calibrator = new Calibrator();
  private anchor?: { shoulders: Point3; hips: Point3; since: number };
  private collecting = false;

  update(snapshot: PoseSnapshot, needsStance = false): CalibrationStep {
    const required = needsStance ? REQUIRED_STANCE : REQUIRED;
    const visible = required.every((index) => snapshot.landmarks[index]) && landmarkConfidence(...required.map((index) => snapshot.landmarks[index]!)) >= 0.55;
    // Antes da coleta não há investimento a proteger: qualquer estado ruim reinicia do framing.
    if (!this.collecting && (snapshot.trackingState === 'lost' || !visible)) {
      this.reset();
      return { phase: 'framing', progress: 0 };
    }
    // Durante a coleta todo quadro ruim conta no denominador de cobertura e no prazo —
    // degradado, fora de enquadramento ou rastreamento perdido: o Calibrator ignora quadros
    // inválidos nas medianas, não no total, e atingido o prazo a tentativa se encerra mesmo
    // sem voltar a enxergar. Uma perda de ~130 ms no meio de uma janela de 3 s não deve
    // descartar os ~2,9 s de amostras válidas que a cercam.
    if (snapshot.trackingState !== 'tracked' || !visible) {
      if (this.collecting) {
        // Um frame visível prova onde o corpo está mesmo sem o gate ter voltado a 'tracked':
        // antes de entrar na cobertura ele re-verifica a imobilidade — flapping após um
        // blecaute não pode esconder um deslocamento que contaminaria as medianas. Só um
        // frame 'tracked' prova estabilidade para re-ancorar; aqui, mover derruba a tentativa.
        if (visible && this.moved(snapshot)) {
          this.reset();
          return { phase: 'framing', progress: 0 };
        }
        this.calibrator.add(snapshot);
        const progress = Math.max(0, Math.min(1, (snapshot.timestampMs - this.anchor!.since - SETTLE_MS) / COLLECT_MS));
        return progress < 1 ? { phase: 'collecting', progress } : this.conclude(needsStance);
      }
      return { phase: this.anchor ? 'settling' : 'framing', progress: 0 };
    }

    const l = snapshot.landmarks;
    const shoulders = midpoint(l[11]!, l[12]!);
    const hips = midpoint(l[23]!, l[24]!);
    if (!this.anchor || this.moved(snapshot)) {
      this.reset();
      this.anchor = { shoulders, hips, since: snapshot.timestampMs };
    }
    const stillMs = snapshot.timestampMs - this.anchor.since;
    if (stillMs < SETTLE_MS) return { phase: 'settling', progress: 0 };
    if (!this.collecting) {
      this.calibrator.start(snapshot.timestampMs);
      this.collecting = true;
    }
    this.calibrator.add(snapshot);
    const progress = Math.min(1, (stillMs - SETTLE_MS) / COLLECT_MS);
    if (progress < 1) return { phase: 'collecting', progress };
    return this.conclude(needsStance);
  }

  /** Ombros ou quadris se afastaram da âncora além da tolerância de parado. Requer âncora viva. */
  private moved(snapshot: PoseSnapshot): boolean {
    const l = snapshot.landmarks;
    return distance2(midpoint(l[11]!, l[12]!), this.anchor!.shoulders) > STILL_TOLERANCE
      || distance2(midpoint(l[23]!, l[24]!), this.anchor!.hips) > STILL_TOLERANCE;
  }

  private conclude(needsStance: boolean): CalibrationStep {
    const profile = this.calibrator.finish();
    this.reset();
    // Sem a vertical das pernas não há salto nem raia: na corrida isso é calibração incompleta,
    // não parcial — volta ao enquadramento. No tênis o perfil sem stance segue útil.
    if (profile && (!needsStance || profile.world.leanUp0)) return { phase: 'done', progress: 1, profile };
    return { phase: 'framing', progress: 0 };
  }

  reset(): void { this.calibrator.reset(); this.anchor = undefined; this.collecting = false; }
}
