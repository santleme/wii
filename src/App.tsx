import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalibrationProfile, SportActionEvent } from './cv/protocol';
import { AutoCalibrator, type CalibrationPhase } from './cv/autoCalibrator';
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

export default function App() {
  const [sport, setSport] = useState<Sport>('track');
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Permissão da câmera ainda não solicitada');
  const [tracking, setTracking] = useState('SEM POSE');
  const [calibrationPhase, setCalibrationPhase] = useState<CalibrationPhase>('framing');
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [muted, setMuted] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const clientRef = useRef<PoseClient | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const engineRef = useRef<GameEngineHandle | null>(null);
  const pipelineRef = useRef(new ActionPipeline());
  const contextRef = useRef(new ContextClassifier());
  const calibratorRef = useRef(new AutoCalibrator());
  const sportRef = useRef(sport);
  sportRef.current = sport;
  const profileRef = useRef<CalibrationProfile | undefined>(undefined);
  const audioRef = useRef(new ProceduralAudio());
  const cameraAttemptRef = useRef(0);

  useEffect(() => {
    void navigator.permissions?.query({ name: 'camera' as PermissionName }).then((permission) => {
      if (permission.state === 'granted') PoseClient.warmVisionAssets();
    }).catch(() => undefined);
    return () => {
      cameraAttemptRef.current += 1;
      clientRef.current?.dispose();
      streamRef.current?.getTracks().forEach((track) => { track.stop(); });
      streamRef.current = undefined;
    };
  }, []);

  const onEngine = useCallback((engine: GameEngineHandle | null) => { engineRef.current = engine; }, []);
  const dispatchEvent = useCallback((event: SportActionEvent) => {
    engineRef.current?.onAction(event);
    if (event.type === 'swing') audioRef.current.hit(event.power01);
    if (event.type === 'jump') audioRef.current.jump();
    if (event.type === 'step') audioRef.current.step(event.side);
  }, []);

  const recalibrate = useCallback(() => {
    profileRef.current = undefined;
    calibratorRef.current.reset();
    setCalibrationPhase('framing');
    setCalibrationProgress(0);
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
    recalibrate();
    drawPose(overlayRef.current, videoRef.current);
  }, [dispatchEvent, recalibrate]);

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
        const result = pipelineRef.current.update(raw, profileRef.current);
        const current = result.snapshot;
        if (!profileRef.current) {
          const step = calibratorRef.current.update(current, sportRef.current === 'track');
          profileRef.current = step.profile;
          setCalibrationPhase(step.phase);
          setCalibrationProgress(step.progress);
          if (step.profile) {
            setCameraStatus(step.profile.world.leanUp0
              ? 'Calibração aprovada · postura neutra salva'
              : 'Calibração parcial · troca de raia e salto desativados · estenda as pernas e enquadre os tornozelos');
          }
        }
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
      const visionReady = client.init(callbacks);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
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
    setMuted((value) => { audioRef.current.setMuted(!value); return !value; });
  }, []);

  return <main className="stage">
    <GameCanvas key={sport} sport={sport} onEngine={onEngine} tracking={tracking} />

    <div className="hud-dock">
      <nav className="sport-dock" aria-label="Modalidades">
        <button type="button" className={sport === 'track' ? 'active' : ''} onClick={() => {
          setSport('track');
          // Um perfil parcial vindo do tênis não tem referência de salto/raia: a corrida refaz a calibração.
          if (profileRef.current && !profileRef.current.world.leanUp0) recalibrate();
        }}>01 · CORRIDA</button>
        <button type="button" className={sport === 'tennis' ? 'active' : ''} onClick={() => setSport('tennis')}>02 · TÊNIS</button>
      </nav>
      <button type="button" className="mute-fab" onClick={toggleMute} title={muted ? 'Áudio desligado' : 'Áudio ligado'}>{muted ? '×' : '♫'}</button>
    </div>

    <CameraPip
      sport={sport}
      videoRef={videoRef} canvasRef={overlayRef} cameraOn={cameraOn} status={cameraStatus} tracking={tracking}
      calibrationPhase={calibrationPhase} calibrationProgress={calibrationProgress}
      onStart={() => void startCamera()} onStop={stopCamera} onRecalibrate={recalibrate}
    />
  </main>;
}
