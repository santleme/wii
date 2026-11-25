import { useEffect, useRef, useState } from 'react';
import type { SportActionEvent } from '../cv/protocol';
import type { GameHudState } from '../games/track/TrackGame';
import { forwardKeyDown } from './keys';

export type Sport = 'track' | 'tennis';
export interface GameEngineHandle { onAction(event: SportActionEvent): void; onKey(key: string): void; dispose(): void }

interface Props {
  sport: Sport;
  onEngine: (engine: GameEngineHandle | null) => void;
  tracking: string;
}

export function GameCanvas({ sport, onEngine, tracking }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hud, setHud] = useState<GameHudState>({ score: 0, label: '00000', speed01: 0, status: 'Pronto para jogar' });
  const hudRef = useRef(setHud);
  hudRef.current = setHud;

  useEffect(() => {
    if (!canvasRef.current) return;
    let game: GameEngineHandle | undefined;
    let disposed = false;
    const keydown = (event: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) event.preventDefault();
      if (!forwardKeyDown(event.key, event.repeat)) return;
      game?.onKey(event.key);
    };
    window.addEventListener('keydown', keydown);
    const mount = async () => {
      try {
        const Game = sport === 'track'
          ? (await import('../games/track/TrackGame')).TrackGame
          : (await import('../games/tennis/TennisGame')).TennisGame;
        const canvas = canvasRef.current;
        if (disposed || !canvas) return;
        const engine = new Game(canvas, (state) => hudRef.current(state));
        if (disposed) { engine.dispose(); return; }
        game = engine;
        onEngine(engine);
      } catch (error) {
        if (!disposed) hudRef.current({ score: 0, label: '—', speed01: 0, status: error instanceof Error ? error.message : 'WebGL indisponível' });
      }
    };
    void mount();
    return () => {
      disposed = true;
      window.removeEventListener('keydown', keydown);
      game?.dispose();
      onEngine(null);
    };
  }, [sport, onEngine]);

  return <div className="game-viewport">
    <canvas ref={canvasRef} />
    <div className="game-hud"><div><span>{sport === 'track' ? 'SCORE' : 'PONTOS'}</span><strong>{hud.label}</strong></div><div className="game-speed"><span>{sport === 'track' ? 'RITMO' : 'MIRA'}</span><strong>{sport === 'track' ? `${Math.round(hud.speed01 * 100)}%` : hud.status.split(' · ').at(-1)}</strong></div></div>
    <div className="game-ready"><i className={tracking.startsWith('TRACKING') ? 'ready' : ''} />{hud.status}</div>
    <div className="game-controls">{sport === 'track' ? '← → trocar raia  ·  ↑ / espaço saltar  ·  ↓ andar / correr / parar' : 'espaço bater  ·  ← → escolher direção'}</div>
  </div>;
}
