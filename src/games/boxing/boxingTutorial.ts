import type { Hand, PunchKind, PunchTargetZone } from '../../cv/protocol';

/** No progress for this long and the step explains itself; longer still and it moves on. */
export const HINT_AFTER_S = 10;
export const GIVE_UP_AFTER_S = 22;
/** A duck must be held this long to count, so a small bob does not pass as defense. */
export const DUCK_HOLD_S = 0.35;
/** While teaching, even a compact punch should confirm — the floor is generous on purpose. */
export const LEARNING_PUNCH_TRAVEL = 0.15;
/** Adapted travel never goes below noise or above the untuned default. */
const MIN_ADAPTED_TRAVEL = 0.15;
const MAX_ADAPTED_TRAVEL = 0.25;
/** Players punch a bit shorter in a fight than when demonstrating, like the tennis warm-up. */
const TRAVEL_FACTOR = 0.75;

export type BoxingStepKind = 'guard' | 'jab' | 'cross' | 'hook' | 'uppercut' | 'body' | 'slip' | 'duck';

const STEPS: readonly { kind: BoxingStepKind; needed: number; title: string; hint: string }[] = [
  { kind: 'guard', needed: 1, title: 'Segure a guarda alta', hint: 'Punhos fechados na altura do rosto' },
  { kind: 'jab', needed: 3, title: 'Dê 3 jabs', hint: 'Estique o braço da frente direto, rápido' },
  { kind: 'cross', needed: 3, title: 'Agora 3 cruzados', hint: 'Estique o braço de trás girando o tronco' },
  { kind: 'hook', needed: 2, title: 'Dê 2 ganchos', hint: 'Braço dobrado, gire o tronco de lado' },
  { kind: 'uppercut', needed: 2, title: 'Dê 2 uppercuts', hint: 'Suba o punho por baixo, em direção ao queixo' },
  { kind: 'body', needed: 2, title: 'Soco no corpo', hint: 'Agache um pouco e soque abaixo do peito' },
  { kind: 'slip', needed: 2, title: 'Esquive para o lado', hint: 'Incline o tronco para esquerda ou direita' },
  { kind: 'duck', needed: 2, title: 'Agache sob o gancho', hint: 'Flexione os joelhos e segure um instante' },
];

/** Continuous inputs sampled once per frame while the tutorial runs. */
export interface TutorialFrame {
  readonly dtS: number;
  readonly seen: boolean;
  readonly guard: boolean;
  readonly zone: -1 | 0 | 1;
  readonly ducked: boolean;
}

export interface TutorialPunch {
  readonly hand: Hand;
  readonly kind: Exclude<PunchKind, 'unknown'>;
  readonly target: PunchTargetZone;
  /** Peak forward reach in shoulder widths, when the pipeline measured it. */
  readonly travelSw?: number;
}

/** What the tutorial learned about this body; memory only, never persisted. */
export interface BoxerProfile {
  readonly leadHand: Hand | undefined;
  /** Median peak reach per punch kind, in shoulder widths. */
  readonly reachByKind: Readonly<Partial<Record<'straight' | 'hook' | 'uppercut', number>>>;
}

const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

/**
 * The boxing warm-up: no opponent, one instruction at a time, advancing as each movement is
 * recognised. It learns the player's stance (which hand jabs) and how far this body's punches
 * actually reach, so later calibration can trust the player instead of fixed thresholds. Pure.
 */
export class BoxingTutorial {
  private index = 0;
  private count = 0;
  private idleS = 0;
  private guardS = 0;
  private duckS = 0;
  private duckCounted = false;
  private slipArmed = true;
  private lead: Hand | undefined;
  private readonly reaches: Record<'straight' | 'hook' | 'uppercut', number[]> = { straight: [], hook: [], uppercut: [] };

  get done(): boolean { return this.index >= STEPS.length; }
  get step(): BoxingStepKind | undefined { return STEPS[this.index]?.kind; }

  /**
   * Forward travel the detector should require for this player: three quarters of the median
   * demonstrated reach, clamped so it never gets stricter than the untuned default. Undefined
   * when nothing was measured — the default applies.
   */
  get punchTravel(): number | undefined {
    const all = [...this.reaches.straight, ...this.reaches.hook, ...this.reaches.uppercut];
    const center = median(all);
    if (center === undefined) return undefined;
    return Math.min(MAX_ADAPTED_TRAVEL, Math.max(MIN_ADAPTED_TRAVEL, center * TRAVEL_FACTOR));
  }

  get profile(): BoxerProfile {
    return {
      leadHand: this.lead,
      reachByKind: {
        straight: median(this.reaches.straight),
        hook: median(this.reaches.hook),
        uppercut: median(this.reaches.uppercut),
      },
    };
  }

  get text(): { title: string; detail: string } {
    const step = STEPS[this.index];
    if (!step) return { title: 'Pronto!', detail: 'Agora é pra valer' };
    const progress = step.kind === 'guard' ? `${Math.min(1, this.guardS).toFixed(0)} de 1 s` : `${this.count} de ${step.needed}`;
    return {
      title: step.title,
      detail: `${progress}${this.idleS >= HINT_AFTER_S ? ` · ${step.hint}` : ' · levante as duas mãos para pular'}`,
    };
  }

  /** Frame inputs only count while the camera can see the player. */
  tick(frame: TutorialFrame): void {
    if (this.done) return;
    if (!frame.seen) {
      this.duckS = 0;
      this.duckCounted = false;
      return;
    }
    this.idleS += frame.dtS;
    const step = this.step;
    if (step === 'guard' && frame.guard) {
      this.guardS += frame.dtS;
      if (this.guardS >= 1) this.advanceCount();
    }
    if (step === 'slip') {
      if (frame.zone === 0) {
        this.slipArmed = true;
      } else if (this.slipArmed) {
        this.slipArmed = false;
        this.advanceCount();
      }
    }
    if (step === 'duck') {
      if (!frame.ducked) {
        this.duckS = 0;
        this.duckCounted = false;
      } else {
        this.duckS += frame.dtS;
        if (!this.duckCounted && this.duckS >= DUCK_HOLD_S) {
          this.duckCounted = true;
          this.advanceCount();
        }
      }
    }
    if (this.idleS >= GIVE_UP_AFTER_S) this.nextStep();
  }

  /** A confirmed punch; returns true when it advanced the current step. */
  punch(punch: TutorialPunch): boolean {
    if (punch.travelSw !== undefined && Number.isFinite(punch.travelSw)) this.reaches[punch.kind].push(punch.travelSw);
    const step = this.step;
    if (step === 'jab' && punch.kind === 'straight' && punch.target !== 'body') {
      if (this.lead === undefined) this.lead = punch.hand;
      if (punch.hand !== this.lead) return false;
      return this.advanceCount();
    }
    if (step === 'cross' && punch.kind === 'straight' && punch.target !== 'body') {
      const rear: Hand = this.lead === 'left' ? 'right' : 'left';
      if (punch.hand !== rear) return false;
      return this.advanceCount();
    }
    if (step === 'hook' && punch.kind === 'hook') return this.advanceCount();
    if (step === 'uppercut' && punch.kind === 'uppercut') return this.advanceCount();
    if (step === 'body' && punch.target === 'body') return this.advanceCount();
    return false;
  }

  skip(): void { this.index = STEPS.length; }

  private advanceCount(): boolean {
    this.count += 1;
    this.idleS = 0;
    if (this.count >= STEPS[this.index]!.needed) this.nextStep();
    return true;
  }

  private nextStep(): void {
    this.index += 1;
    this.count = 0;
    this.idleS = 0;
    this.guardS = 0;
    this.duckS = 0;
    this.duckCounted = false;
    this.slipArmed = true;
  }
}
