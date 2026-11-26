import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalibrationProfile, SportActionEvent } from './cv/protocol';
import { AdaptiveCalibrator } from './cv/adaptiveCalibrator';
import { observeEarlyRejection } from './cv/observeEarlyRejection';
import { PoseClient, type PoseClientCallbacks } from './cv/poseClient';
import { ActionPipeline } from './kinematics/actionPipeline';
import { ContextClassifier, type ActivityKind } from './kinematics/contextClassifier';
import { ProceduralAudio } from './games/audio';
import { CameraPip } from './ui/CameraPip';
import { GameCanvas, type GameEngineHandle, type Sport } from './ui/GameCanvas';
import { drawPose } from './ui/PoseOverlay';
import './styles.css';

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  idle: 'PARADO',
  running: 'CORRIDA',
  swinging: 'RAQUETE',
  striking: 'LUTA',
};
const MUTE_STORAGE_KEY = 'wii-web-sports.muted.v1';

function readMutedPreference(): boolean {
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMutedPreference(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    void 0;
  }
}

export default function App() {
  const [sport, setSport] = useState<Sport>('track');
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Permissão da câmera ainda não solicitada');
  const [tracking, setTracking] = useState('SEM POSE');
  const [muted, setMuted] = useState(readMutedPreference);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<PoseClient | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const engineRef = useRef<GameEngineHandle | null>(null);
  const pipelineRef = useRef(new ActionPipeline());
  const contextRef = useRef(new ContextClassifier());
  const calibratorRef = useRef(new AdaptiveCalibrator());
  const sportRef = useRef(sport);
  sportRef.current = sport;
  const profileRef = useRef<CalibrationProfile | undefined>(undefined);
  const audioRef = useRef(new ProceduralAudio());
  const cameraAttemptRef = useRef(0);

  useEffect(() => {
    audioRef.current.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    void navigator.permissions?.query({ name: 'camera' as PermissionName }).then((permission) => {
      if (permission.state === 'granted') PoseClient.warmVisionAssets();
    }).catch(() => undefined);
    return () => {
      cameraAttemptRef.current += 1;
      clientRef.current?.dispose();
      streamRef.current?.getTracks().forEach((track) => { track.stop(); });
      streamRef.current = undefined;
      audioRef.current.dispose();
    };
  }, []);

  const onEngine = useCallback((engine: GameEngineHandle | null) => { engineRef.current = engine; }, []);
  const dispatchEvent = useCallback((event: SportActionEvent) => {
    engineRef.current?.onAction(event);
    if (sportRef.current === 'track') {
      if (event.type === 'jump') audioRef.current.jump();
      if (event.type === 'step') audioRef.current.step(event.side);
    }
  }, []);

  const resetCalibration = useCallback(() => {
    profileRef.current = undefined;
    calibratorRef.current.reset();
  }, []);

  const stopCamera = useCallback(() => {
    cameraAttemptRef.current += 1;
    clientRef.current?.pauseCapture();
    streamRef.current?.getTracks().forEach((track) => { track.stop(); });
    streamRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
    setTracking('SEM POSE');
    setCameraStatus('Câmera desligada');
    for (const event of pipelineRef.current.reset()) dispatchEvent(event);
    contextRef.current.reset();
    resetCalibration();
    drawPose(overlayRef.current, videoRef.current);
  }, [dispatchEvent, resetCalibration]);

  const startCamera = useCallback(async () => {
    stopCamera();
    const attempt = ++cameraAttemptRef.current;
    const stale = () => cameraAttemptRef.current !== attempt;
    const callbacks: PoseClientCallbacks = {
      onStatus: (status, detail) => {
        if (stale()) return;
        setCameraStatus(detail);
        if (status === 'error') { setTracking('SEM POSE'); stopCamera(); setCameraStatus(detail); }
      },
      onPose: (raw) => {
        if (stale()) return;
        // Implicit calibration: every observed frame is evidence. The current profile is a
        // continuously improving estimate, never a mode the player has to enter or watch.
        profileRef.current = calibratorRef.current.update(raw) ?? profileRef.current;
        const result = pipelineRef.current.update(raw, profileRef.current);
        const current = result.snapshot;
        const decision = contextRef.current.update(current, profileRef.current);
        const activity = decision.confidence01 > 0.4 ? ` · ${ACTIVITY_LABEL[decision.activity]}` : '';
        setTracking(current.trackingState === 'tracked' ? `TRACKING${activity}` : current.trackingState === 'lost' ? 'SEM POSE' : 'PROCURANDO');
        drawPose(overlayRef.current, videoRef.current, current);
        for (const event of result.events) dispatchEvent(event);
      },
    };
    try {
      await audioRef.current.unlock();
      if (stale()) return;
      clientRef.current ??= new PoseClient();
      const client = clientRef.current;
      // Camera permission/video readiness may take longer than the worker; observe an early
      // worker rejection now, while preserving it for the await below.
      const visionReady = observeEarlyRejection(client.init(callbacks));
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        // Sem teto de fps: a 60 fps um swing de ~250 ms ganha o dobro de amostras temporais —
        // câmeras que só entregam 30 fps simplesmente negociam para baixo pelo `ideal`.
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
      });
      if (stale()) { stream.getTracks().forEach((track) => { track.stop(); }); return; }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('Prévia da câmera não está disponível.');
      video.srcObject = stream;
      await video.play();
      if (stale()) return;
      await new Promise<void>((resolve) => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) resolve();
        else {
          video.addEventListener('loadeddata', () => resolve(), { once: true });
          video.addEventListener('emptied', () => resolve(), { once: true });
        }
      });
      if (stale()) return;
      setCameraOn(true);
      await visionReady;
      if (stale() || !client.isReady || streamRef.current !== stream) return;
      client.beginCapture(video, callbacks);
    } catch (error) {
      if (stale()) return;
      stopCamera();
      setCameraStatus(error instanceof Error ? error.message : 'Não foi possível iniciar a câmera.');
    }
  }, [stopCamera, dispatchEvent]);

  const toggleMute = useCallback(() => {
    void audioRef.current.unlock();
    setMuted((value) => {
      const next = !value;
      writeMutedPreference(next);
      return next;
    });
  }, []);

  return <main className="stage">
    <GameCanvas key={sport} sport={sport} onEngine={onEngine} tracking={tracking} audio={audioRef.current} />

    <div className="hud-dock">
      <nav className="sport-dock" aria-label="Modalidades">
        <button type="button" className={sport === 'track' ? 'active' : ''} onClick={() => setSport('track')}>01 · CORRIDA</button>
        <button type="button" className={sport === 'tennis' ? 'active' : ''} onClick={() => {
          setSport('tennis');
          // Referências de punho são apenas o re-arm rápido. Sem elas o swing continua
          // disponível pelo fallback de velocidade baixa, então trocar de esporte não apaga
          // a calibração do torso nem bloqueia a partida.
        }}>02 · TÊNIS</button>
      </nav>
      <button type="button" className="mute-fab" onClick={toggleMute} title={muted ? 'Áudio desligado' : 'Áudio ligado'}>{muted ? '×' : '♫'}</button>
    </div>

    <CameraPip
      videoRef={videoRef} canvasRef={overlayRef} cameraOn={cameraOn} status={cameraStatus} tracking={tracking}
      onStart={() => void startCamera()} onStop={stopCamera}
    />
  </main>;
}
