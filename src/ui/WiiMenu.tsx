import { type CSSProperties, type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { Sport } from './GameCanvas';
import type { CarouselStepResult } from './carouselController';
import type { HandInputStore } from './handInputStore';
import { positiveModulo, useWheelCarousel } from './useWheelCarousel';

const SPORTS: { id: Sport; name: string; hint: string }[] = [
  { id: 'athletics', name: 'Corrida', hint: 'Uma volta de 400 m no estádio Resort' },
  { id: 'tennis', name: 'Tênis', hint: 'Balance o braço para rebater' },
  { id: 'boxing', name: 'Boxe', hint: 'Soque para a frente e incline o corpo para esquivar' },
];

const SLOTS = Array.from({ length: 12 }, (_, i) => `slot-${i}`);
const GRID_MS = 1100; // a grade fica à vista antes de virar roda
const RING_TRANSITION_MS = 900;
const GAMES_TRANSITION_MS = 700;
let introduced = false; // só a primeira visita mostra a grade se desfazendo

type SharedRef<T> = { current: T };

interface HandWheelProps {
  handStore: HandInputStore;
  rotationGateRef: SharedRef<boolean>;
  carouselDebugRef?: SharedRef<CarouselStepResult | undefined>;
}

interface HomeMenuProps extends HandWheelProps {
  onGames: () => void;
  exit: ReactNode;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion(): boolean {
  const query = REDUCED_MOTION_QUERY;
  const [reduced, setReduced] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** Grade 4 x 3, ou roda em elipse com o canal da vez grande e à frente. */
function placement(index: number, turn: number, ring: boolean): CSSProperties {
  if (!ring) return { left: `${14 + 24 * (index % 4)}%`, top: `${18 + 32 * Math.floor(index / 4)}%`, transform: 'translate(-50%, -50%) scale(1)' };
  const angle = ((index - turn) / SLOTS.length) * Math.PI * 2;
  const depth = (Math.cos(angle) + 1) / 2; // 1 = frente
  return {
    left: `${50 + Math.sin(angle) * 37}%`,
    top: `${24 + depth * 34}%`,
    transform: `translate(-50%, -50%) scale(${(.4 + .4 * depth ** 2 + .8 * depth ** 24).toFixed(3)})`,
    opacity: .45 + .55 * depth,
    zIndex: Math.round(depth * 20),
  };
}

function Logo() {
  return <span className="logo"><b>Wii</b> <i>Sports</i></span>;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="wii-clock">
    <strong>{now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</strong>
    <span>{now.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'numeric' })}</span>
  </div>;
}

const ringPlacement = (index: number, turn: number) => placement(index, turn, true);

export function HomeMenu({ onGames, exit, handStore, rotationGateRef, carouselDebugRef }: HomeMenuProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [zoom, setZoom] = useState<CSSProperties>();
  const [ring, setRing] = useState(() => introduced || reducedMotion);
  const [ringReady, setRingReady] = useState(() => introduced || reducedMotion);
  const ringRef = useRef<HTMLDivElement>(null);
  const { turn, controller, slotRef, rotateBy, bring: bringSlot } = useWheelCarousel({
    slotCount: SLOTS.length,
    ready: ring && ringReady && zoom === undefined,
    reducedMotion,
    transitionMs: RING_TRANSITION_MS,
    placement: ringPlacement,
    handStore,
    rotationGateRef,
    debugRef: carouselDebugRef,
    ringRef,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => { introduced = true; setRing(true); }, ring ? 0 : GRID_MS);
    return () => window.clearTimeout(timer);
  }, [ring]);

  useEffect(() => {
    if (!ring) {
      setRingReady(false);
      return;
    }
    if (ringReady) return;
    const timer = window.setTimeout(() => setRingReady(true), reducedMotion ? 0 : RING_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [ring, ringReady, reducedMotion]);

  // A câmera avança sobre o canal, o branco nasce no meio da tela e só então troca de tela.
  // Como nos papers: clicar num canal gira a roda, pelo caminho curto, até ele chegar à frente.
  const bring = (index: number) => {
    setRing(true);
    introduced = true;
    bringSlot(index);
  };
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const frontNow = positiveModulo(Math.round(controller.currentTurn), SLOTS.length);
    if (controller.isControlling || frontNow !== 0) { bring(0); return; }
    if (reducedMotion) { onGames(); return; }
    // O foco da aproximação é o centro do canal, medido dentro da roda (que é quem escala).
    const tile = event.currentTarget.getBoundingClientRect();
    const wheel = event.currentTarget.closest('.channel-ring')?.getBoundingClientRect();
    setZoom({ '--zx': `${tile.left + tile.width / 2 - (wheel?.left ?? 0)}px`, '--zy': `${tile.top + tile.height / 2 - (wheel?.top ?? 0)}px` } as CSSProperties);
  };

  return <section className={zoom ? 'menu channels is-opening' : 'menu channels'} style={zoom} aria-label="Menu de canais">
    <div ref={ringRef} className={ring ? 'channel-ring is-ring' : 'channel-ring'}>
      {SLOTS.map((slot, index) => index === 0
        ? <button key={slot} ref={slotRef(index)} type="button" className="channel sports" style={placement(index, turn, ring)} onClick={open} disabled={zoom !== undefined}><Logo /></button>
        : <button key={slot} ref={slotRef(index)} type="button" className="channel empty" style={placement(index, turn, ring)} onClick={() => bring(index)} aria-label={`Trazer o canal vazio ${index} para a frente`}>Wii</button>)}
      <button type="button" className="ring-arrow left" onClick={() => rotateBy(-1)} aria-label="Girar para a esquerda">◀</button>
      <button type="button" className="ring-arrow right" onClick={() => rotateBy(1)} aria-label="Girar para a direita">▶</button>
    </div>
    <footer className="wii-bar">
      <svg viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 20H150C250 20 270 120 380 120H620C730 120 750 20 850 20H1000V200H0Z" />
      </svg>
      <span className="wii-title">Wii Menu</span>
      <Clock />
      {exit}
    </footer>
    {zoom && <div className="channel-whiteout" onAnimationEnd={onGames} aria-hidden="true" />}
  </section>;
}

export function TitleMenu({ onStart, onBack }: { onStart: () => void; onBack: () => void }) {
  return <section className="menu title" aria-label="Wii Sports">
    <div className="title-card">
      <Logo />
      <div className="stripes" />
    </div>
    <div className="title-actions">
      <button type="button" className="wii-btn pill" onClick={onBack}>Wii Menu</button>
      <button type="button" className="wii-btn pill" onClick={onStart}>Start</button>
    </div>
  </section>;
}

/** Roda de jogos: o da vez fica grande e à frente, os outros recuam para os lados. */
function gamePlacement(index: number, turn: number): CSSProperties {
  const angle = ((index - turn) / SPORTS.length) * Math.PI * 2;
  const depth = (Math.cos(angle) + 1) / 2; // 1 = frente
  return {
    left: `${50 + Math.sin(angle) * 31}%`,
    top: `${46 + (1 - depth) * -6}%`,
    transform: `translate(-50%, -50%) scale(${(.62 + .38 * depth ** 2).toFixed(3)})`,
    opacity: .55 + .45 * depth,
    zIndex: Math.round(depth * 20),
  };
}

interface GamesMenuProps extends HandWheelProps {
  onPick: (sport: Sport) => void;
  onBack: () => void;
  onHome: () => void;
}

export function GamesMenu({ onPick, onBack, onHome, handStore, rotationGateRef, carouselDebugRef }: GamesMenuProps) {
  const reducedMotion = usePrefersReducedMotion();
  const ringRef = useRef<HTMLDivElement>(null);
  const { turn, controller, slotRef, rotateBy, bring } = useWheelCarousel({
    slotCount: SPORTS.length,
    initialTurn: 1, // começa no Tênis, como antes
    ready: true,
    reducedMotion,
    transitionMs: GAMES_TRANSITION_MS,
    placement: gamePlacement,
    handStore,
    rotationGateRef,
    debugRef: carouselDebugRef,
    ringRef,
  });
  const n = SPORTS.length;
  const front = positiveModulo(Math.round(turn), n);
  const hint = SPORTS[front].hint;
  // Clicar num jogo de trás gira a roda pelo caminho curto; clicar no da frente joga, mas só com
  // a roda parada.
  const open = (index: number) => {
    const frontNow = positiveModulo(Math.round(controller.currentTurn), n);
    if (index === frontNow && !controller.isControlling) onPick(SPORTS[index].id);
    else bring(index);
  };

  return <section className="menu sports-menu" aria-label="Escolha a modalidade">
    <header className="menu-header">
      <h1>Menu Principal</h1>
      <button type="button" className="logo-btn" onClick={onHome} aria-label="Wii Sports: voltar ao Wii Menu"><Logo /></button>
    </header>
    <div className="menu-body games-body">
      <div ref={ringRef} className="games-ring">
        {SPORTS.map((s, index) => <button key={s.id} ref={slotRef(index)} type="button" className={`game-card ${s.id}${index === front ? ' is-front' : ''}`}
          style={gamePlacement(index, turn)} onClick={() => open(index)}
          aria-label={index === front ? `Jogar ${s.name}` : `Trazer ${s.name} para a frente`}>
          <span className="scene" />
          <span className="game-name">{s.name}</span>
        </button>)}
        <button type="button" className="ring-arrow left" onClick={() => rotateBy(-1)} aria-label="Girar para a esquerda">◀</button>
        <button type="button" className="ring-arrow right" onClick={() => rotateBy(1)} aria-label="Girar para a direita">▶</button>
      </div>
      <p className="games-hint" aria-live="polite">{hint}</p>
      <button type="button" className="wii-btn back games-back" onClick={onBack}>Voltar</button>
    </div>
  </section>;
}
