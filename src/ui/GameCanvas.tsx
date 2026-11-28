import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { Hand, SportActionEvent } from '../cv/protocol';
import type { AthleticsHudState } from '../games/athletics/AthleticsGame';
import type { Goal } from '../games/athletics/race';
import type { ProceduralAudio } from '../games/audio';
import type { BoxingScoreboard } from '../games/boxing/BoxingGame';
import { BOXING_MODES, type BoxingMode } from '../games/boxing/boxingModes';
import { DEFAULT_OPPONENT_PROFILE_ID, OPPONENT_PROFILES, type OpponentProfileId } from '../games/boxing/opponentProfiles';
import type { ArmMotion } from '../kinematics/armMotion';
import type { SwingTracking } from '../kinematics/actionPipeline';
import { type GestureSample, RestartGesture } from '../games/core/restartGesture';
import type { GameHudState as CoreHudState } from '../games/core/hud';
import type { GameHudState as TrackHudState } from '../games/track/TrackGame';

type GameHudState = Omit<TrackHudState, 'feedback'> & {
  tennis?: CoreHudState['tennis'];
  feedback?: TrackHudState['feedback'] | CoreHudState['feedback'];
  finished?: AthleticsHudState['finished'];
  framing?: boolean;
  energy?: AthleticsHudState['energy'];
  runners?: AthleticsHudState['runners'];
  boxing?: BoxingScoreboard;
};
import { forwardKeyDown } from './keys';

export type Sport = 'track' | 'athletics' | 'tennis' | 'boxing';
const HUD_TEXT: Record<Sport, { score: string; speed: string; controls: string }> = {
  track: { score: 'SCORE', speed: 'RITMO', controls: '← → trocar raia  ·  ↑ / espaço saltar  ·  ↓ andar / correr / parar' },
  athletics: { score: 'TEMPO', speed: 'INTENSIDADE', controls: 'corra no lugar, mexendo os braços' },
  tennis: { score: 'PONTOS', speed: 'MIRA', controls: 'raquetada no tempo da bola: cedo cruza, tarde vai reto' },
  boxing: { score: 'HP', speed: 'RITMO', controls: 'W A S D mover  ·  E socar  ·  segure Q para defender  ·  ← → esquivar' },
};
const BOXING_TRAINING_CONTROLS = {
  bag: 'E ou socos no ritmo  ·  W A S D mover',
  dodge: '← → esquivar  ·  A / D circular para sair da linha  ·  W / S ajustar distância',
} as const;
export interface GameEngineHandle { onAction(event: SportActionEvent): void; onKey(key: string): void; setTracking?(tracking: string): void; setPoseTracking?(tracking: string, atMs: number): void; setLaneZone?(zone: -1 | 0 | 1 | undefined): void; setEffort?(effort: number, sampleAtMs?: number | null): void; setHandsRaised?(raised: boolean, atMs: number | null): void; setTossHand?(hand: Hand | undefined, atMs: number): void; setArmMotions?(motions: readonly ArmMotion[]): void; setSwingTracking?(tracking: SwingTracking): void; setFraming?(advice: string | undefined, handsHidden?: boolean): void; resetLaneZone?(): void; setDodgeZone?(zone: -1 | 0 | 1 | undefined, atMs?: number | null): void; setGuard?(guard: boolean | undefined, atMs?: number | null): void; setDuck?(ducked: boolean | undefined, atMs?: number | null): void; setDepthMove?(move: -1 | 0 | 1 | undefined, atMs?: number | null): void; setDepthSpeed?(speed: number | undefined, atMs?: number | null): void; setLateralDash?(dash: -1 | 0 | 1 | undefined): void; onKeyUp?(key: string): void; dispose(): void }

export interface IronManResult {
  sport: 'athletics' | 'tennis' | 'boxing';
  detail: string;
}

interface Props {
  sport: Sport;
  ironMan?: { onComplete: (result: IronManResult) => void };
  onEngine: (engine: GameEngineHandle | null) => void;
  tracking: string;
  audio?: ProceduralAudio;
  /** Race distance for athletics, picked in the menu. */
  goal?: Goal;
  /** The player is holding their arms crossed; on a result screen that leads back to the menu. */
  crossedPose?: RefObject<GestureSample | null>;
  onExit?: () => void;
  /** Receives the stroke length the tennis warm-up settles on. */
  onStrokeTravel?: (travel: number) => void;
  onPunchTravel?: (travel: number) => void;
  initialRacketHand?: Hand;
  onRacketHand?: (hand: Hand) => void;
}

/** Restarting remounts the whole run, so a new game starts from a clean engine and canvas. */
export function GameCanvas(props: Props) {
  const [run, setRun] = useState(0);
  const racketHandRef = useRef<Hand>('right');
  const rememberRacketHand = useCallback((hand: Hand) => { racketHandRef.current = hand; }, []);
  const [boxingMode, setBoxingMode] = useState<BoxingMode>('fight');
  const [boxingOpponent, setBoxingOpponent] = useState<OpponentProfileId>(DEFAULT_OPPONENT_PROFILE_ID);
  // The warm-up opens the first match only; playing again goes straight to the court.
  return <GameRun
    key={`${run}-${boxingMode}-${boxingOpponent}`}
    {...props}
    boxingMode={boxingMode}
    onBoxingMode={setBoxingMode}
    boxingOpponent={boxingOpponent}
    onBoxingOpponent={setBoxingOpponent}
    tutorial={run === 0}
    initialRacketHand={racketHandRef.current}
    onRacketHand={rememberRacketHand}
    onRestart={() => setRun((value) => value + 1)}
  />;
}

function GameRun({ sport, ironMan, onEngine, tracking, audio, goal = 100, crossedPose, onExit, onStrokeTravel, onPunchTravel, initialRacketHand, onRacketHand, tutorial, onRestart, boxingMode, onBoxingMode, boxingOpponent, onBoxingOpponent }: Props & {
  onRestart: () => void;
  tutorial: boolean;
  boxingMode: BoxingMode;
  onBoxingMode: (mode: BoxingMode) => void;
  boxingOpponent: OpponentProfileId;
  onBoxingOpponent: (opponent: OpponentProfileId) => void;
}) {
  const ironActive = Boolean(ironMan);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hud, setHud] = useState<GameHudState>({ score: 0, label: '00000', speed01: 0, status: 'Pronto para jogar' });
  const hudRef = useRef(setHud);
  hudRef.current = setHud;
  const engineRef = useRef<GameEngineHandle | null>(null);
  const trackingRef = useRef(tracking);
  trackingRef.current = tracking;

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine?.setPoseTracking) engine?.setTracking?.(tracking);
  }, [tracking]);

  // The 100 m asks for a new run with the body: both hands held up.
  const restartByBody = Math.max(hud.finished?.restart01 ?? 0, hud.tennis?.winner ? hud.tennis.restart01 : 0) >= 1;
  const restartRef = useRef(onRestart);
  restartRef.current = onRestart;
  useEffect(() => { if (restartByBody && !ironMan) restartRef.current(); }, [restartByBody, ironMan]);

  // Same rules as playing again: only after the result has been seen, and from arms that were down.
  const over = Boolean(hud.finished || hud.tennis?.winner);
  const travelRef = useRef(onStrokeTravel);
  travelRef.current = onStrokeTravel;
  const punchTravelRef = useRef(onPunchTravel);
  punchTravelRef.current = onPunchTravel;
  const racketHandRef = useRef(initialRacketHand);
  racketHandRef.current = initialRacketHand;
  const racketHandCallbackRef = useRef(onRacketHand);
  racketHandCallbackRef.current = onRacketHand;
  const tutorialRef = useRef(tutorial);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const [leave01, setLeave01] = useState(0);
  useEffect(() => {
    if (!over || ironMan) { setLeave01(0); return; }
    const gesture = new RestartGesture();
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const pose = crossedPose?.current;
      gesture.setHandsRaised(pose?.active ?? false, pose?.atMs ?? null);
      gesture.step((now - last) / 1000, now);
      last = now;
      setLeave01(gesture.progress01);
      if (gesture.progress01 >= 1) {
        window.clearInterval(timer);
        exitRef.current?.();
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [over, crossedPose, ironMan]);
  const [countdown, setCountdown] = useState(10);
  const completedRef = useRef(ironMan?.onComplete);
  completedRef.current = ironMan?.onComplete;
  const ironResult: IronManResult | undefined = !ironMan ? undefined
    : sport === 'athletics' && hud.finished ? {
      sport: 'athletics',
      detail: `${hud.finished.detail} · ${hud.finished.standings.findIndex((runner) => runner.you) + 1}º lugar`,
    } : sport === 'tennis' && hud.tennis?.winner ? {
      sport: 'tennis',
      detail: `${hud.tennis.winner === 'player' ? 'Vitória' : 'Derrota'} · ${hud.tennis.games.player} × ${hud.tennis.games.opponent} games`,
    } : sport === 'boxing' && hud.boxing?.winner ? {
      sport: 'boxing',
      detail: hud.boxing.winner === 'player' ? 'Vitória' : hud.boxing.winner === 'draw' ? 'Empate' : 'Derrota',
    } : undefined;
  // Capture the first terminal result, then clean up both timers if the player exits.
  const resultRef = useRef<IronManResult | undefined>(undefined);
  if (ironResult && !resultRef.current) resultRef.current = ironResult;
  const displayedResult = resultRef.current;
  const hasIronResult = Boolean(displayedResult);
  useEffect(() => {
    if (!hasIronResult) return;
    setCountdown(10);
    const interval = window.setInterval(() => setCountdown((seconds) => Math.max(0, seconds - 1)), 1000);
    const timeout = window.setTimeout(() => {
      if (resultRef.current) completedRef.current?.(resultRef.current);
    }, 10_000);
    return () => { window.clearInterval(interval); window.clearTimeout(timeout); };
  }, [hasIronResult]);
  const leaveBar = <div className="restart-gesture"><b style={{ width: `${leave01 * 100}%` }} /><span>Cruze os braços em X para voltar ao menu</span></div>;

  useEffect(() => {
    if (!canvasRef.current) return;
    let game: GameEngineHandle | undefined;
    let disposed = false;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('button, input, select, textarea, a'))) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) event.preventDefault();
      if (!forwardKeyDown(event.key, event.repeat)) return;
      void audio?.unlock();
      game?.onKey(event.key);
    };
    const keyup = (event: KeyboardEvent) => game?.onKeyUp?.(event.key);
    // A key released while the window is unfocused never reports it.
    const blur = () => { for (const key of ['ArrowDown', 'q', 'w', 'a', 's', 'd']) game?.onKeyUp?.(key); };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    const mount = async () => {
      try {
        const canvas = canvasRef.current;
        if (disposed || !canvas) return;
        const updateHud = (state: GameHudState) => hudRef.current(state);
        const engine: GameEngineHandle = sport === 'track'
          ? new (await import('../games/track/TrackGame')).TrackGame(canvas, updateHud)
          : sport === 'athletics'
            ? new (await import('../games/athletics/AthleticsGame')).AthleticsGame(canvas, updateHud, audio, goal)
            : sport === 'tennis'
              ? new (await import('../games/tennis/TennisGame')).TennisGame(canvas, updateHud, audio, {
                tutorial: tutorialRef.current,
                initialRacketHand: racketHandRef.current,
                onRacketHand: (hand) => racketHandCallbackRef.current?.(hand),
                onStrokeTravel: (travel) => travelRef.current?.(travel),
              })
              : new (await import('../games/boxing/BoxingGame')).BoxingGame(canvas, updateHud, audio, undefined, {
                mode: boxingMode,
                holdResult: ironActive,
                opponent: boxingOpponent,
                motionRng: Math.random,
                onPunchTravel: (travel) => punchTravelRef.current?.(travel),
              });
        if (disposed) { engine.dispose(); return; }
        game = engine;
        engineRef.current = engine;
        engine.setTracking?.(trackingRef.current);
        onEngine(engine);
      } catch (error) {
        if (!disposed) hudRef.current({ score: 0, label: '—', speed01: 0, status: error instanceof Error ? error.message : 'WebGL indisponível' });
      }
    };
    void mount();
    return () => {
      disposed = true;
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
      game?.dispose();
      engineRef.current = null;
      onEngine(null);
    };
  }, [sport, onEngine, audio, goal, boxingMode, boxingOpponent, ironActive]);

  const boxingControls = hud.boxing?.training ? BOXING_TRAINING_CONTROLS[hud.boxing.training.kind] : HUD_TEXT.boxing.controls;

  return <div className={`game-viewport ${sport}${hud.framing ? ' is-framing' : ''}`}>
    <canvas ref={canvasRef} />
    {hud.tennis ? <table className="tennis-score" aria-label="Placar do tênis">
      <thead><tr><th scope="col">Tênis</th><th scope="col">Games</th><th scope="col">Pontos</th></tr></thead>
      <tbody>{(['player', 'opponent'] as const).map((side) => (
        <tr key={side}>
          <th scope="row">{side === 'player' ? 'Você' : 'Adversário'}{hud.tennis?.server === side && <span className="tennis-server" role="img" aria-label={hud.tennis.secondServe ? 'Segundo saque' : 'Sacando'}>●</span>}</th>
          <td>{hud.tennis?.games[side]}</td>
          <td>{hud.tennis?.points[side]}</td>
        </tr>
      ))}</tbody>
    </table> : sport === 'boxing' ? hud.boxing && <BoxingHud {...hud.boxing} /> : sport !== 'tennis' && <div className="game-hud"><div><span>{HUD_TEXT[sport].score}</span><strong>{hud.label}</strong>{(hud.combo ?? 0) > 1 && <em>COMBO {hud.combo}</em>}</div><div className="game-speed"><span>{HUD_TEXT[sport].speed}</span><strong>{Math.round(hud.speed01 * 100)}%</strong></div></div>}
    {hud.tennis?.winner && !ironMan && <section className="game-over tennis-result" aria-label="Resultado da partida">
      <h2>{hud.tennis.winner === 'player' ? 'Você venceu!' : 'Adversário venceu'}</h2>
      <p>{hud.tennis.games.player} × {hud.tennis.games.opponent} games</p>
      <div className="restart-gesture"><b style={{ width: `${hud.tennis.restart01 * 100}%` }} /><span>Levante as duas mãos para jogar de novo</span></div>
      {leaveBar}
      <button type="button" onClick={onRestart}>Jogar de novo</button>
    </section>}
    {sport === 'boxing' && !ironMan && hud.boxing?.selectionOpen && <fieldset className="game-goals boxing-setup" aria-label="Configuração do boxe">
      <div className="boxing-select-row">
        <span>MODO</span>
        {BOXING_MODES.map((mode) => <button key={mode.id} type="button" className="dock-btn" aria-pressed={mode.id === boxingMode} onClick={() => onBoxingMode(mode.id)}>{mode.label}</button>)}
      </div>
      {boxingMode === 'fight' && <div className="boxing-select-row">
        <span>ADVERSÁRIO</span>
        {OPPONENT_PROFILES.map((profile) => <button key={profile.id} type="button" className="dock-btn" aria-pressed={profile.id === boxingOpponent} onClick={() => onBoxingOpponent(profile.id)}>{profile.label}</button>)}
      </div>}
    </fieldset>}
    {hud.feedback && <div key={hud.feedback.id} className={`game-feedback ${('kind' in hud.feedback ? hud.feedback.kind : hud.feedback.tone)}`}>
      <span>{hud.feedback.text}</span>
    </div>}
    {hud.banner && <div className="game-banner" role="status"><strong>{hud.banner.title}</strong>{hud.banner.detail && <span>{hud.banner.detail}</span>}</div>}
    {hud.runners && <div className="race-progress">{hud.runners.map((runner) => (
      <div key={runner.name} className={runner.you ? 'you' : ''}><span>{runner.name}</span><i><b style={{ width: `${runner.progress01 * 100}%` }} /></i></div>
    ))}</div>}
    {hud.energy && <div className="energy">
      {hud.energy.coaching && <strong role="status">{hud.energy.coaching}</strong>}
      <span>{hud.energy.label}</span>
      <i><b style={{ width: `${hud.energy.value01 * 100}%` }} /></i>
    </div>}
    {hud.finished && !ironMan && <div className="game-over" role="dialog" aria-label="Fim da prova">
      <h2>{hud.finished.title}</h2>
      <p><strong>{hud.finished.detail}</strong></p>
      {!hud.finished.standingsFinal && <p>Classificação em andamento · tempos estimados podem mudar</p>}
      <ol>{hud.finished.standings.map((runner) => (
        <li key={runner.name} className={runner.you ? 'current' : ''}><span>{runner.place}º {runner.name}</span><span>{runner.time}{runner.status === 'estimated' ? ' (estimado)' : ''}</span></li>
      ))}</ol>
      <div className="restart-gesture"><b style={{ width: `${hud.finished.restart01 * 100}%` }} /><span>Levante as duas mãos para correr de novo</span></div>
      {leaveBar}
      <button type="button" onClick={onRestart}>Correr de novo</button>
    </div>}
    {displayedResult && <section className="game-over iron-result" role="status">
      <h2>Etapa concluída!</h2>
      <p>{displayedResult.detail}</p>
      <p>{sport === 'boxing' ? 'Resumo' : 'Próxima modalidade'} em {countdown} s</p>
    </section>}
    {hud.result && <div className="game-over" role="dialog" aria-label="Fim de corrida">
      <h2>Você perdeu!</h2>
      <p>Sua melhor marca nesta corrida: <strong>{hud.result.points}</strong> pontos</p>
      <h3>Seu ranking</h3>
      <ol>{hud.result.ranking.map((points, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the place is the row's identity and scores may repeat
        <li key={index} className={hud.result?.position === index + 1 ? 'current' : ''}><span>{index + 1}º</span><span>{points}</span></li>
      ))}</ol>
      <button type="button" ref={(button) => button?.focus()} onClick={onRestart}>Jogar de novo</button>
    </div>}
    <div className="game-ready"><i className={tracking.startsWith('TRACKING') ? 'ready' : ''} />{hud.status}</div>
    <div className="game-controls">{sport === 'boxing' ? boxingControls : HUD_TEXT[sport].controls}</div>
  </div>;
}

function BoxingHud({ playerHp, opponentHp, maxHp, round, rounds, secondsLeft, training }: BoxingScoreboard) {
  if (training) {
    const card = (label: string, value: string | number) => <div className="boxing-card boxing-training-card">
      <span className="boxing-label">{label}</span>
      <strong className="boxing-value">{value}</strong>
    </div>;
    if (training.kind === 'bag') {
      return <div className="boxing-hud training">
        {card('PRECISÃO', `${Math.round((training.precision01 ?? 0) * 100)}%`)}
        {card('COMBO', `${training.combo ?? 0}x`)}
        {card('PONTOS', training.score)}
      </div>;
    }
    return <div className="boxing-hud training">
      {card('GOLPES RESTANTES', training.attacksRemaining ?? 0)}
      {card('ERROS RESTANTES', training.hitsRemaining ?? 0)}
      {card('PONTOS', training.score)}
    </div>;
  }

  const fighter = (name: string, hp: number, side: 'player' | 'opponent') => <div className={`boxing-card boxing-fighter ${side}`}>
    <p className="boxing-name"><span className="boxing-label">{name}</span><strong className="boxing-value">{hp}</strong></p>
    <div className="boxing-bar" aria-hidden="true"><div className="boxing-fill" style={{ width: `${(100 * hp) / maxHp}%` }} /></div>
  </div>;
  return <div className="boxing-hud">
    {fighter('VOCÊ', playerHp, 'player')}
    <div className="boxing-card boxing-clock">
      <span className="boxing-label">ROUND {round}/{rounds}</span>
      <strong className="boxing-value">{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</strong>
    </div>
    {fighter('CPU', opponentHp, 'opponent')}
  </div>;
}
