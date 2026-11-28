import type { Hand } from '../../cv/protocol';

/** No progress for this long and the step explains itself; longer still and it moves on. */
export const HINT_AFTER_S = 10;
export const GIVE_UP_AFTER_S = 22;
/** Strokes are accepted shorter than usual while learning them. */
export const LEARNING_TRAVEL = 1.6;
const DEFAULT_TRAVEL = 1.9;

type Side = 'forehand' | 'backhand';
export type StepKind = 'swings' | 'other-side' | 'toss' | 'serve';

const STEPS: readonly { kind: StepKind; needed: number; title: string; hint: string }[] = [
  { kind: 'swings', needed: 3, title: 'Dê 3 raquetadas', hint: 'Mostre o braço inteiro e bata de um lado ao outro' },
  { kind: 'other-side', needed: 2, title: 'Agora do outro lado', hint: 'Comece com o braço do lado contrário' },
  { kind: 'toss', needed: 2, title: 'Lance a bola com a mão livre', hint: 'Suba a mão sem raquete até a altura do rosto' },
  { kind: 'serve', needed: 2, title: 'Saque: lance e bata', hint: 'Uma mão lança, a outra bate' },
];

/**
 * The on-court warm-up: no opponent, one instruction at a time, advancing as each movement is
 * recognised. It learns which arm holds the racket and how short this player's strokes are. Pure.
 */
export class TennisTutorial {
  private index = 0;
  private count = 0;
  private idleS = 0;
  private tossed = false;
  private readonly travels: number[] = [];
  private readonly hands: Hand[] = [];
  private readonly sides: Side[] = [];

  get done(): boolean { return this.index >= STEPS.length; }
  get step(): StepKind | undefined { return STEPS[this.index]?.kind; }
  get racketHand(): Hand {
    const left = this.hands.filter((hand) => hand === 'left').length;
    return left * 2 > this.hands.length ? 'left' : 'right';
  }

  /** Most of this player's stroke length, never stricter than the default nor loose enough to misfire. */
  get strokeTravel(): number {
    if (this.travels.length < 3) return DEFAULT_TRAVEL;
    const sorted = [...this.travels].sort((a, b) => a - b);
    return Math.min(DEFAULT_TRAVEL, Math.max(LEARNING_TRAVEL, sorted[sorted.length >> 1]! * 0.75));
  }

  get text(): { title: string; detail: string } {
    const step = STEPS[this.index];
    if (!step) return { title: 'Pronto!', detail: 'Vamos jogar' };
    return {
      title: step.title,
      detail: `${this.count} de ${step.needed}${this.idleS >= HINT_AFTER_S ? ` · ${step.hint}` : ' · levante as duas mãos para pular'}`,
    };
  }

  swing(swing: { hand: Hand; side: Side; travel?: number }): boolean {
    const step = this.step;
    if (step === 'swings' || step === 'other-side') {
      // The second step wants the side the first one saw less of.
      const usual: Side = this.sides.filter((side) => side === 'forehand').length * 2 >= this.sides.length ? 'forehand' : 'backhand';
      if (step === 'other-side' && swing.side === usual) return false;
      if (step === 'swings') this.sides.push(swing.side);
      this.hands.push(swing.hand);
      if (swing.travel !== undefined) this.travels.push(swing.travel);
      return this.advance();
    }
    if (step === 'serve' && this.tossed && swing.hand === this.racketHand) {
      this.tossed = false;
      return this.advance();
    }
    return false;
  }

  toss(): boolean {
    if (this.step === 'toss') return this.advance();
    if (this.step !== 'serve') return false;
    this.tossed = true;
    return true;
  }

  /** Time only counts while the camera can see the player. */
  tick(dt: number, seen: boolean): void {
    if (this.done || !seen) return;
    this.idleS += dt;
    if (this.idleS >= GIVE_UP_AFTER_S) this.nextStep();
  }

  skip(): void { this.index = STEPS.length; }

  private advance(): boolean {
    this.count += 1;
    this.idleS = 0;
    if (this.count >= STEPS[this.index]!.needed) this.nextStep();
    return true;
  }

  private nextStep(): void {
    this.index += 1;
    this.count = 0;
    this.idleS = 0;
    this.tossed = false;
  }
}
