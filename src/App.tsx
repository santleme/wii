import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CalibrationProfile, SportActionEvent } from './cv/protocol';
import { HandClient } from './cv/handClient';
import { AdaptiveCalibrator } from './cv/adaptiveCalibrator';
import { observeEarlyRejection } from './cv/observeEarlyRejection';
import { PoseClient, type PoseClientCallbacks } from './cv/poseClient';
import { ActionPipeline } from './kinematics/actionPipeline';
import { ContextClassifier, type ActivityKind } from './kinematics/contextClassifier';
import { HandCursorDetector } from './kinematics/handCursor';
import { ProceduralAudio } from './games/audio';
import { CameraPip } from './ui/CameraPip';
import { GameCanvas, type GameEngineHandle, type Sport } from './ui/GameCanvas';
import { HandCursor } from './ui/HandCursor';
import { HandDebugOverlay } from './ui/HandDebugOverlay';
import { HandPanel } from './ui/HandPanel';
import { HAND_IDLE } from './ui/handCursorTypes';
import { createHandInputStore, useHandInput } from './ui/handInputStore';
import type { CarouselStepResult } from './ui/carouselController';
import { drawHand, drawPose } from './ui/PoseOverlay';
import { GamesMenu, HomeMenu, TitleMenu } from './ui/WiiMenu';
import { WiiSplash } from './ui/WiiSplash';
import './arena.css';

type Screen = 'home' | 'title' | 'games' | 'play';
type VisionMode = 'hand' | 'pose';

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  idle: 'PARADO',
  running: 'CORRIDA',
  swinging: 'RAQUETE',
  striking: 'LUTA',
};
const MUTE_STORAGE_KEY = 'wii-web-sports.muted.v1';

const inHandMenu = (screen: Screen) => screen === 'home' || screen === 'title' || screen === 'games';
const modeForScreen = (screen: Screen): VisionMode => (inHandMenu(screen) ? 'hand' : 'pose');

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

export default function App({ exit }: { exit?: ReactNode }) {
  const [splash, setSplash] = useState(true);
  const [screen, setScreen] = useState<Screen>('home');
  const [sport, setSport] = useState<Sport>('track');
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Permissão da câmera ainda não solicitada');
  const [tracking, setTracking] = useState('SEM POSE');
  const [muted, setMuted] = useState(readMutedPreference);
  const [handPanelOpen, setHandPanelOpen] = useState(false);
  // Hand samples stay out of React state: App re-renders only when synchronization flips.
  const [handStore] = useState(createHandInputStore);
  const handSynced = useHandInput(handStore, (hand) => hand.current.synced);
  const homeRotationGateRef = useRef(false);
  const carouselDebugRef = useRef<CarouselStepResult | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const handOverlayRef = useRef<HTMLCanvasElement>(null);
  const poseClientRef = useRef<PoseClient | undefined>(undefined);
  const handClientRef = useRef<HandClient | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const engineRef = useRef<GameEngineHandle | null>(null);
  const pipelineRef = useRef(new ActionPipeline());
  const contextRef = useRef(new ContextClassifier());
  const calibratorRef = useRef(new AdaptiveCalibrator());
  const handDetectorRef = useRef(new HandCursorDetector());
  const sportRef = useRef(sport);
  sportRef.current = sport;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const visionModeRef = useRef<VisionMode>('pose');
  const profileRef = useRef<CalibrationProfile | undefined>(undefined);
  const audioRef = useRef(new ProceduralAudio());
  const cameraAttemptRef = useRef(0);

  useEffect(() => {
    audioRef.current.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    void navigator.permissions?.query({ name: 'camera' as PermissionName }).then((permission) => {
      // The app opens on a hand-driven menu; pose assets are warmed on the way into a game.
      if (permission.state === 'granted') HandClient.warmVisionAssets();
    }).catch(() => undefined);
    return () => {
      cameraAttemptRef.current += 1;
      poseClientRef.current?.dispose();
      handClientRef.current?.dispose();
      streamRef.current?.getTracks().forEach((track) => { track.stop(); });
      streamRef.current = undefined;
      audioRef.current.dispose();
    };
  }, []);

  useEffect(() => {
    if (screen === 'games') PoseClient.warmVisionAssets();
  }, [screen]);

  const onEngine = useCallback((engine: GameEngineHandle | null) => { engineRef.current = engine; }, []);
  const dispatchEvent = useCallback((event: SportActionEvent) => {
    engineRef.current?.onAction(event);
    if (sportRef.current === 'track' || sportRef.current === 'athletics') {
      // Only the track has jumps; athletics still hears its steps.
      if (event.type === 'jump' && sportRef.current === 'track') audioRef.current.jump();
      if (event.type === 'step') audioRef.current.step(event.side);
    }
  }, []);

  const resetCalibration = useCallback(() => {
    profileRef.current = undefined;
    calibratorRef.current.reset();
  }, []);

  const stopCamera = useCallback(() => {
    cameraAttemptRef.current += 1;
    poseClientRef.current?.pauseCapture();
    handClientRef.current?.pauseCapture();
    streamRef.current?.getTracks().forEach((track) => { track.stop(); });
    streamRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
    setTracking('SEM POSE');
    setCameraStatus('Câmera desligada');
    handStore.publish(HAND_IDLE);
    handDetectorRef.current.reset();
    for (const event of pipelineRef.current.reset()) dispatchEvent(event);
    engineRef.current?.resetLaneZone?.();
    engineRef.current?.setGuard?.(undefined);
    engineRef.current?.setDepthMove?.(undefined);
    engineRef.current?.setDepthSpeed?.(undefined);
    engineRef.current?.setLateralDash?.(undefined);
    contextRef.current.reset();
    resetCalibration();
    drawPose(overlayRef.current, videoRef.current);
    drawHand(handOverlayRef.current, videoRef.current);
  }, [dispatchEvent, handStore, resetCalibration]);

  const poseCallbacksRef = useRef<PoseClientCallbacks | undefined>(undefined);
  poseCallbacksRef.current = {
    onStatus: (status, detail) => {
      setCameraStatus(detail);
      if (status === 'error') {
        setTracking('SEM POSE');
        stopCamera();
        setCameraStatus(detail);
      }
    },
    onPose: (raw) => {
      // Implicit calibration: every observed frame is evidence. The current profile is a
      // continuously improving estimate, never a mode the player has to enter or watch.
      profileRef.current = calibratorRef.current.update(raw, pipelineRef.current.laneZone) ?? profileRef.current;
      const result = pipelineRef.current.update(raw, profileRef.current);
      const current = result.snapshot;
      const decision = contextRef.current.update(current, profileRef.current);
      const activity = decision.confidence01 > 0.4 ? ` · ${ACTIVITY_LABEL[decision.activity]}` : '';
      setTracking(current.trackingState === 'tracked' ? `TRACKING${activity}` : current.trackingState === 'lost' ? 'SEM POSE' : 'PROCURANDO');
      drawPose(overlayRef.current, videoRef.current, current);
      engineRef.current?.setLaneZone?.(result.controls.laneZone);
      engineRef.current?.setGuard?.(result.controls.guard);
      engineRef.current?.setDepthMove?.(result.controls.ringDepthMove);
      engineRef.current?.setDepthSpeed?.(result.controls.ringDepth01);
      engineRef.current?.setLateralDash?.(result.controls.lateralDash);
      for (const event of result.events) dispatchEvent(event);
    },
  };

  const startHandCapture = useCallback(async (video: HTMLVideoElement, attempt: number) => {
    const stale = () => cameraAttemptRef.current !== attempt;
    handClientRef.current ??= new HandClient();
    const handClient = handClientRef.current;
    await handClient.init({
      onStatus: (status, detail) => {
        if (stale()) return;
        setCameraStatus(detail);
        if (status === 'error') {
          stopCamera();
          setCameraStatus(detail);
        }
      },
    });
    if (stale() || !handClient.isReady || !streamRef.current || visionModeRef.current !== 'hand') return;
    handClient.beginCapture(video, (snapshot, aspectY) => {
      if (stale()) return;
      const primary = snapshot.hands[0];
      drawHand(handOverlayRef.current, video, primary?.landmarks);
      const state = handDetectorRef.current.update({
        timestampMs: snapshot.timestampMs,
        landmarks: primary?.landmarks ?? [],
        worldLandmarks: primary?.worldLandmarks,
        handedness: primary?.handedness,
        aspectY,
        rotationEnabled: screenRef.current === 'home' && homeRotationGateRef.current,
      });
      handStore.publish({
        visible: state.visible,
        x: state.x * window.innerWidth,
        y: state.y * window.innerHeight,
        syncProgress: state.syncProgress,
        synced: state.synced,
        pinching: state.pinching,
        pinchRelease: state.pinchRelease,
        backProgress: state.backProgress,
        capturedAtMs: snapshot.timestampMs,
        rotationPhase: state.rotationPhase,
        rotationAngularVelocity: state.rotationAngularVelocity,
        rotationDirection: state.rotationDirection,
        rotationFilteredAngularVelocity: state.rotationFilteredAngularVelocity,
        rotationRawAngularVelocity: state.rotationRawAngularVelocity,
        rotationCurvature: state.rotationCurvature,
        rotationHandShape: state.rotationHandShape,
        rotationRejectReason: state.rotationRejectReason,
        rotationDtMs: state.rotationDtMs,
        rotationOrientation: state.rotationOrientation,
      });
    }, (error) => {
      if (!stale()) setCameraStatus(error.message);
    });
  }, [handStore, stopCamera]);

  const startPoseCapture = useCallback(async (video: HTMLVideoElement, attempt: number) => {
    const stale = () => cameraAttemptRef.current !== attempt;
    poseClientRef.current ??= new PoseClient();
    const poseClient = poseClientRef.current;
    await poseClient.init({
      onStatus: (status, detail) => {
        if (stale()) return;
        poseCallbacksRef.current?.onStatus(status, detail);
      },
      onPose: (raw) => {
        if (stale()) return;
        poseCallbacksRef.current?.onPose(raw);
      },
    });
    if (stale() || !poseClient.isReady || !streamRef.current || visionModeRef.current !== 'pose') return;
    poseClient.beginCapture(video, {
      onStatus: (status, detail) => {
        if (stale()) return;
        poseCallbacksRef.current?.onStatus(status, detail);
      },
      onPose: (raw) => {
        if (stale()) return;
        poseCallbacksRef.current?.onPose(raw);
      },
    });
  }, []);

  // Menus use hand tracking; adaptive body calibration runs continuously during play.
  useEffect(() => {
    const next = modeForScreen(screen);
    if (visionModeRef.current === next) return;
    visionModeRef.current = next;
    handDetectorRef.current.reset();
    handStore.publish(HAND_IDLE);
    const video = videoRef.current;
    if (!cameraOn || !video || !streamRef.current) return;

    const attempt = cameraAttemptRef.current;
    if (next === 'hand') {
      poseClientRef.current?.pauseCapture();
      drawPose(overlayRef.current, videoRef.current);
      void startHandCapture(video, attempt).catch((error: unknown) => {
        if (cameraAttemptRef.current === attempt) {
          setCameraStatus(error instanceof Error ? error.message : 'Não foi possível iniciar o modo de mão.');
        }
      });
    } else {
      handClientRef.current?.pauseCapture();
      void startPoseCapture(video, attempt).catch((error: unknown) => {
        if (cameraAttemptRef.current === attempt) {
          setCameraStatus(error instanceof Error ? error.message : 'Não foi possível iniciar o modo de pose.');
        }
      });
    }
  }, [screen, cameraOn, startHandCapture, startPoseCapture, handStore]);

  const startCamera = useCallback(async () => {
    stopCamera();
    const attempt = ++cameraAttemptRef.current;
    const stale = () => cameraAttemptRef.current !== attempt;
    try {
      void audioRef.current.unlock();
      const desiredMode = modeForScreen(screenRef.current);
      visionModeRef.current = desiredMode;

      if (desiredMode === 'hand') {
        handClientRef.current ??= new HandClient();
      } else {
        poseClientRef.current ??= new PoseClient();
      }
      const visionReady = observeEarlyRejection(
        desiredMode === 'hand'
          ? handClientRef.current!.init({
              onStatus: (status, detail) => {
                if (stale()) return;
                setCameraStatus(detail);
                if (status === 'error') { stopCamera(); setCameraStatus(detail); }
              },
            })
          : poseClientRef.current!.init({
              onStatus: (status, detail) => {
                if (stale()) return;
                poseCallbacksRef.current?.onStatus(status, detail);
              },
              onPose: (raw) => {
                if (stale()) return;
                poseCallbacksRef.current?.onPose(raw);
              },
            }),
      );

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
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
      if (stale() || streamRef.current !== stream) return;
      if (visionModeRef.current === 'hand') {
        await startHandCapture(video, attempt);
      } else {
        await startPoseCapture(video, attempt);
      }
    } catch (error) {
      if (stale()) return;
      stopCamera();
      setCameraStatus(error instanceof Error ? error.message : 'Não foi possível iniciar a câmera.');
    }
  }, [stopCamera, startHandCapture, startPoseCapture]);

  const toggleMute = useCallback(() => {
    void audioRef.current.unlock();
    setMuted((value) => {
      const next = !value;
      writeMutedPreference(next);
      return next;
    });
  }, []);

  const endSplash = useCallback(() => {
    setSplash(false);
    void startCamera();
  }, [startCamera]);

  const play = (next: Sport) => {
    void audioRef.current.unlock();
    setSport(next);
    sportRef.current = next;
    setHandPanelOpen(false);
    setScreen('play');
  };

  const closeHandPanel = useCallback(() => {
    stopCamera();
    setHandPanelOpen(false);
  }, [stopCamera]);

  const handBack = useCallback(() => {
    if (screenRef.current === 'games') setScreen('home');
    else if (screenRef.current === 'title') setScreen('home');
    else if (handPanelOpen) closeHandPanel();
  }, [closeHandPanel, handPanelOpen]);

  const menu = inHandMenu(screen);

  return <div className="stage">
    {screen === 'play' && <GameCanvas key={sport} sport={sport} onEngine={onEngine} tracking={tracking} audio={audioRef.current} />}
    {screen === 'home' && (
      <HomeMenu
        exit={exit}
        onGames={() => setScreen('games')}
        handInputRef={handStore}
        rotationGateRef={homeRotationGateRef}
        carouselDebugRef={carouselDebugRef}
      />
    )}
    {screen === 'title' && <TitleMenu onStart={() => setScreen('games')} onBack={() => setScreen('home')} />}
    {screen === 'games' && <GamesMenu onHome={() => setScreen('home')} onPick={play} onBack={() => setScreen('home')} />}

    {screen === 'play' && <div className="hud-dock">
      <button type="button" className="dock-btn" onClick={() => setScreen('games')}>‹ Jogos</button>
      <button type="button" className="dock-btn round" onClick={toggleMute} title={muted ? 'Áudio desligado' : 'Áudio ligado'}>{muted ? '×' : '♫'}</button>
    </div>}

    {menu && handPanelOpen && <HandPanel
      sourceRef={videoRef} canvasRef={handOverlayRef} cameraOn={cameraOn} status={cameraStatus} synced={handSynced}
      onStart={() => void startCamera()} onClose={closeHandPanel}
    />}
    <HandCursor store={handStore} active={menu && cameraOn} onBack={handBack} />
    {menu && cameraOn && <HandDebugOverlay store={handStore} carouselRef={carouselDebugRef} />}

    <CameraPip
      hidden={menu && handPanelOpen}
      videoRef={videoRef} canvasRef={overlayRef} cameraOn={cameraOn} status={cameraStatus} tracking={tracking}
      onStart={() => void startCamera()} onStop={stopCamera}
    />
    {splash && <WiiSplash onDone={endSplash} />}
  </div>;
}
