import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CalibrationProfile, PoseSnapshot, SportActionEvent } from './cv/protocol';
import { HandClient } from './cv/handClient';
import { AdaptiveCalibrator } from './cv/adaptiveCalibrator';
import { PoseClient, type PoseClientCallbacks } from './cv/poseClient';
import { diagnosticsEnabled } from './cv/diagnostics/flags';
import { PhotoTrail } from './cv/diagnostics/photoTrail';
import { BOXING_RECORDING_SCRIPT, TENNIS_RECORDING_SCRIPT } from './cv/diagnostics/recordingScript';
import { downloadRecording, noteArrival, PoseRecorder, rememberFrame } from './cv/diagnostics/poseRecorder';
import { ActionPipeline } from './kinematics/actionPipeline';
import { PUNCH_THRESHOLDS } from './kinematics/punchDetector';
import { framingAdvice, handsHidden, armsCrossed, handsRaised, raisedTossHand, HeadWarning } from './kinematics/framing';
import { ContextClassifier, type ActivityKind } from './kinematics/contextClassifier';
import { HandCursorDetector } from './kinematics/handCursor';
import { visibleImagePoint } from './kinematics/math';
import type { GestureSample } from './games/core/restartGesture';
import { ProceduralAudio } from './games/audio';
import { CameraPip } from './ui/CameraPip';
import { GameCanvas, type GameEngineHandle, type IronManResult, type Sport } from './ui/GameCanvas';
import type { Goal } from './games/athletics/race';
import { HandCursor } from './ui/HandCursor';
import { HandDebugOverlay } from './ui/HandDebugOverlay';
import { PerfMeter } from './ui/PerfMeter';
import { HAND_IDLE } from './ui/handCursorTypes';
import { createHandInputStore } from './ui/handInputStore';
import type { CarouselStepResult } from './ui/carouselController';
import { drawPose } from './ui/PoseOverlay';
import { EXIT_DODGE_SW } from './kinematics/postureSignals';
import { HomeMenu } from './ui/WiiMenu';
import { WiiSplash } from './ui/WiiSplash';
import './arena.css';

type Screen = 'home' | 'play' | 'summary';
type VisionMode = 'hand' | 'pose';

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  idle: 'PARADO',
  running: 'CORRIDA',
  swinging: 'RAQUETE',
  striking: 'LUTA',
};
const MUTE_STORAGE_KEY = 'wii-web-sports.muted.v1';

const inHandMenu = (screen: Screen) => screen !== 'play';
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
  const [sport, setSport] = useState<Sport>('athletics');
  const [ironResults, setIronResults] = useState<IronManResult[] | null>(null);
  const [goal, setGoal] = useState<Goal>(100);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraStatus, setCameraStatus] = useState('Permissão da câmera ainda não solicitada');
  const [tracking, setTracking] = useState('SEM POSE');
  const [muted, setMuted] = useState(readMutedPreference);
  // Hand samples stay out of React state, so the camera rate never re-renders App.
  const [handStore] = useState(createHandInputStore);
  const homeRotationGateRef = useRef(false);
  const carouselDebugRef = useRef<CarouselStepResult | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const poseClientRef = useRef<PoseClient | undefined>(undefined);
  const handClientRef = useRef<HandClient | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const engineRef = useRef<GameEngineHandle | null>(null);
  const pipelineRef = useRef(new ActionPipeline());
  const contextRef = useRef(new ContextClassifier());
  const calibratorRef = useRef(new AdaptiveCalibrator());
  const handDetectorRef = useRef(new HandCursorDetector());
  const lastHandDeliveryAtRef = useRef<number | undefined>(undefined);
  const sportRef = useRef(sport);
  sportRef.current = sport;
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const activeVisionModeRef = useRef<VisionMode>('pose');
  const visionActivationRef = useRef(0);
  const captureStartedRef = useRef<{ cameraAttempt: number; visionActivation: number } | undefined>(undefined);
  const profileRef = useRef<CalibrationProfile | undefined>(undefined);
  const audioRef = useRef(new ProceduralAudio());
  const cameraAttemptRef = useRef(0);
  const poseFramesRef = useRef(0);
  /** Capture-to-game delay of the last pose, shown by `?fps`. */
  const poseDelayRef = useRef(0);
  const [headCut, setHeadCut] = useState(false);
  const crossedPoseRef = useRef<GestureSample | null>(null);
  const recentFramesRef = useRef<PoseSnapshot[]>([]);
  const photoTrailRef = useRef(new PhotoTrail());
  const [keepPhotos] = useState(() => new URLSearchParams(window.location.search).has('fotos'));
  const headWarningRef = useRef(new HeadWarning());
  const [showPerf] = useState(() => new URLSearchParams(window.location.search).has('fps'));
  /** Diagnostic recording: owned here, fed by onPose, ended by the script, G or the camera stopping. */
  const recorderRef = useRef<PoseRecorder | undefined>(undefined);
  const [recordingPrompt, setRecordingPrompt] = useState<string>();

  useEffect(() => {
    audioRef.current.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    void navigator.permissions?.query({ name: 'camera' as PermissionName }).then((permission) => {
      if (permission.state !== 'granted') return;
      // The app opens on the hand-driven menu; both models share the same WASM.
      HandClient.warmVisionAssets();
      PoseClient.warmVisionAssets();
    }).catch(() => undefined);
    return () => {
      cameraAttemptRef.current += 1;
      captureStartedRef.current = undefined;
      poseClientRef.current?.dispose();
      handClientRef.current?.dispose();
      streamRef.current?.getTracks().forEach((track) => { track.stop(); });
      streamRef.current = undefined;
      audioRef.current.dispose();
    };
  }, []);

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
    captureStartedRef.current = undefined;
    recorderRef.current = undefined;
    setRecordingPrompt(undefined);
    setHeadCut(false);
    crossedPoseRef.current = null;
    engineRef.current?.setHandsRaised?.(false, null);
    headWarningRef.current.reset();
    recentFramesRef.current = [];
    photoTrailRef.current.clear();
    poseClientRef.current?.pauseCapture();
    handClientRef.current?.pauseCapture();
    streamRef.current?.getTracks().forEach((track) => { track.stop(); });
    streamRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
    setTracking('SEM POSE');
    engineRef.current?.setTracking?.('SEM POSE');
    setCameraStatus('Câmera desligada');
    handStore.publish(HAND_IDLE);
    handDetectorRef.current.reset();
    lastHandDeliveryAtRef.current = undefined;
    for (const event of pipelineRef.current.reset(performance.now())) dispatchEvent(event);
    engineRef.current?.resetLaneZone?.();
    engineRef.current?.setGuard?.(undefined, null);
    engineRef.current?.setDuck?.(undefined, null);
    engineRef.current?.setDepthMove?.(undefined, null);
    engineRef.current?.setDepthSpeed?.(undefined, null);
    engineRef.current?.setLateralDash?.(undefined);
    contextRef.current.reset();
    resetCalibration();
    drawPose(overlayRef.current, videoRef.current);
  }, [dispatchEvent, handStore, resetCalibration]);

  const finishRecording = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = undefined;
    setRecordingPrompt(undefined);
    const delegate = poseClientRef.current?.delegate;
    if (!recorder?.frameCount || !delegate) return;
    void downloadRecording(recorder, delegate, sport === 'tennis' ? 'tenis' : sport === 'boxing' ? 'boxe' : 'corrida').catch((error: unknown) => {
      setCameraStatus(error instanceof Error ? error.message : 'Não foi possível salvar a gravação.');
    });
  }, [sport]);

  useEffect(() => {
    if (screen === 'play') pipelineRef.current.recenterLane();
  }, [screen]);

  // G starts/stops a recording during a camera run. Detectors and calibration restart with it,
  // so replaying the file from a cold start reproduces what happened live.
  useEffect(() => {
    if (screen !== 'play' || !cameraOn || !diagnosticsEnabled()) return;
    const toggle = (event: KeyboardEvent) => {
      const delegate = poseClientRef.current?.delegate;
      if (event.key.toLowerCase() === 'e' && !event.repeat && delegate && recentFramesRef.current.length) {
        void downloadRecording(new PoseRecorder(recentFramesRef.current), delegate, sport === 'tennis' ? 'tenis-erro' : 'erro', photoTrailRef.current.all).catch(() => setCameraStatus('Não foi possível salvar o trecho.'));
        return;
      }
      if (event.key.toLowerCase() !== 'g' || event.repeat) return;
      if (recorderRef.current) { finishRecording(); return; }
      for (const stop of pipelineRef.current.reset(performance.now())) dispatchEvent(stop);
      resetCalibration();
      recorderRef.current = new PoseRecorder([], sport === 'tennis' ? TENNIS_RECORDING_SCRIPT : sport === 'boxing' ? BOXING_RECORDING_SCRIPT : undefined);
      setRecordingPrompt('Gravando…');
    };
    window.addEventListener('keydown', toggle);
    return () => {
      window.removeEventListener('keydown', toggle);
      recorderRef.current = undefined;
      setRecordingPrompt(undefined);
    };
  }, [screen, sport, cameraOn, dispatchEvent, resetCalibration, finishRecording]);

  const activateVisionMode = useCallback((next: VisionMode): VisionMode | undefined => {
    const previous = activeVisionModeRef.current;
    if (previous === next) return undefined;
    activeVisionModeRef.current = next;
    visionActivationRef.current += 1;
    captureStartedRef.current = undefined;
    return previous;
  }, []);

  const isCurrentVisionActivation = useCallback((attempt: number, activation: number, mode: VisionMode) =>
    cameraAttemptRef.current === attempt &&
    visionActivationRef.current === activation &&
    activeVisionModeRef.current === mode &&
    modeForScreen(screenRef.current) === mode,
  []);

  const failVisionActivation = useCallback((
    attempt: number,
    activation: number,
    mode: VisionMode,
    error: unknown,
    fallback: string,
  ) => {
    if (!isCurrentVisionActivation(attempt, activation, mode)) return;
    stopCamera();
    setCameraStatus(error instanceof Error ? error.message : fallback);
  }, [isCurrentVisionActivation, stopCamera]);

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
      poseFramesRef.current += 1;
      poseDelayRef.current = performance.now() - raw.timestampMs;
      noteArrival(raw, performance.now());
      rememberFrame(recentFramesRef.current, raw);
      if (keepPhotos) photoTrailRef.current.add(raw.timestampMs, videoRef.current);
      if (recorderRef.current) {
        const current = recorderRef.current.push(raw);
        if (current) setRecordingPrompt(`${current.segment.prompt} · ${Math.ceil(current.remainingMs / 1000)}`);
        else finishRecording();
      }
      setHeadCut(headWarningRef.current.update(raw));
      // Implicit calibration: every observed frame is evidence. The current profile is a
      // continuously improving estimate, never a mode the player has to enter or watch.
      const calibrated = sportRef.current === 'boxing'
        ? calibratorRef.current.update(raw, pipelineRef.current.dodgeZone, EXIT_DODGE_SW)
        : calibratorRef.current.update(raw, pipelineRef.current.laneZone);
      profileRef.current = calibrated ?? profileRef.current;
      const result = pipelineRef.current.update(raw, profileRef.current);
      const current = result.snapshot;
      const decision = contextRef.current.update(current, profileRef.current);
      const activity = decision.confidence01 > 0.4 ? ` · ${ACTIVITY_LABEL[decision.activity]}` : '';
      const trackingLabel = current.trackingState === 'tracked' ? `TRACKING${activity}` : current.trackingState === 'lost' ? 'SEM POSE' : 'PROCURANDO';
      engineRef.current?.setPoseTracking?.(trackingLabel, raw.timestampMs);
      setTracking(trackingLabel);
      drawPose(overlayRef.current, videoRef.current, current);
      engineRef.current?.setLaneZone?.(result.controls.laneZone);
      engineRef.current?.setEffort?.(result.rawEffort, result.effortSampleAtMs);
      engineRef.current?.setFraming?.(framingAdvice(raw), handsHidden(raw));
      const gestureAtMs = current.trackingState === 'tracked'
        && [11, 12].every((index) => visibleImagePoint(current.landmarks[index], 0.5))
        ? raw.timestampMs : null;
      const wristsVisible = [15, 16].every((index) => visibleImagePoint(current.landmarks[index], 0.5));
      crossedPoseRef.current = gestureAtMs === null ? null : { active: wristsVisible && armsCrossed(current), atMs: gestureAtMs };
      engineRef.current?.setHandsRaised?.(gestureAtMs !== null && wristsVisible && handsRaised(current), gestureAtMs);
      engineRef.current?.setTossHand?.(raisedTossHand(current), raw.timestampMs);
      engineRef.current?.setArmMotions?.(result.armMotions);
      engineRef.current?.setSwingTracking?.(result.swingTracking);
      engineRef.current?.setDodgeZone?.(result.controls.dodgeZone, raw.timestampMs);
      engineRef.current?.setGuard?.(result.controls.guard, raw.timestampMs);
      engineRef.current?.setDuck?.(result.controls.duck, raw.timestampMs);
      engineRef.current?.setDepthMove?.(result.controls.ringDepthMove, raw.timestampMs);
      engineRef.current?.setDepthSpeed?.(result.controls.ringDepth01, raw.timestampMs);
      engineRef.current?.setLateralDash?.(result.controls.lateralDash);
      for (const event of result.events) dispatchEvent(event);
    },
  };

  const startHandCapture = useCallback(async (video: HTMLVideoElement, attempt: number, activation: number) => {
    const stale = () => !isCurrentVisionActivation(attempt, activation, 'hand');
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
    if (stale() || !handClient.isReady || !streamRef.current || activeVisionModeRef.current !== 'hand') return;
    handClient.beginCapture(video, (snapshot, aspectY) => {
      if (stale()) return;
      const deliveredAtMs = performance.now();
      const previousDeliveryAtMs = lastHandDeliveryAtRef.current;
      lastHandDeliveryAtRef.current = deliveredAtMs;
      const handInferenceMs = Math.max(0, deliveredAtMs - snapshot.timestampMs);
      const workerFps =
        previousDeliveryAtMs === undefined ? undefined : 1000 / Math.max(deliveredAtMs - previousDeliveryAtMs, 0.01);
      const primary = snapshot.hands[0];
      const state = handDetectorRef.current.update({
        timestampMs: snapshot.timestampMs,
        landmarks: primary?.landmarks ?? [],
        worldLandmarks: primary?.worldLandmarks,
        handedness: primary?.handedness,
        aspectY,
        rotationEnabled: screenRef.current === 'home' && homeRotationGateRef.current,
        handInferenceMs,
        workerFps,
      });
      handStore.publish({
        visible: state.visible,
        x: state.x * window.innerWidth,
        y: state.y * window.innerHeight,
        syncProgress: state.syncProgress,
        synced: state.synced,
        pinching: state.pinching,
        pinchState: state.pinchState,
        freezeReason: state.freezeReason,
        pinchRelease: state.pinchRelease,
        backProgress: state.backProgress,
        swipeDirection: state.swipeDirection,
        swipeMoving: state.swipeMoving,
        handInferenceMs: state.handInferenceMs,
        workerFps: state.workerFps,
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
  }, [isCurrentVisionActivation, handStore, stopCamera]);

  const startPoseCapture = useCallback(async (video: HTMLVideoElement, attempt: number, activation: number) => {
    const stale = () => !isCurrentVisionActivation(attempt, activation, 'pose');
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
    if (stale() || !poseClient.isReady || !streamRef.current || activeVisionModeRef.current !== 'pose') return;
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
  }, [isCurrentVisionActivation]);

  // Menus use hand tracking; adaptive body calibration runs continuously during play.
  useEffect(() => {
    const next = modeForScreen(screen);
    const previous = activateVisionMode(next);
    if (previous !== undefined) {
      handDetectorRef.current.reset();
      lastHandDeliveryAtRef.current = undefined;
      handStore.publish(HAND_IDLE);
      if (next === 'hand') {
        poseClientRef.current?.pauseCapture();
        drawPose(overlayRef.current, videoRef.current);
      } else {
        handClientRef.current?.pauseCapture();
      }
    }

    const video = videoRef.current;
    if (!cameraOn || !video || !streamRef.current) return;

    const attempt = cameraAttemptRef.current;
    const activation = visionActivationRef.current;
    if (
      captureStartedRef.current?.cameraAttempt === attempt &&
      captureStartedRef.current.visionActivation === activation
    ) return;
    captureStartedRef.current = { cameraAttempt: attempt, visionActivation: activation };

    if (next === 'hand') {
      void startHandCapture(video, attempt, activation).catch((error: unknown) => {
        failVisionActivation(attempt, activation, 'hand', error, 'Não foi possível iniciar o modo de mão.');
      });
    } else {
      void startPoseCapture(video, attempt, activation).catch((error: unknown) => {
        failVisionActivation(attempt, activation, 'pose', error, 'Não foi possível iniciar o modo de pose.');
      });
    }
  }, [screen, cameraOn, activateVisionMode, failVisionActivation, startHandCapture, startPoseCapture, handStore]);

  const startCamera = useCallback(async () => {
    stopCamera();
    const attempt = ++cameraAttemptRef.current;
    const stale = () => cameraAttemptRef.current !== attempt;
    try {
      void audioRef.current.unlock();
      const desiredMode = modeForScreen(screenRef.current);
      activateVisionMode(desiredMode);
      const activation = visionActivationRef.current;

      let visionReady: Promise<void>;
      if (desiredMode === 'hand') {
        handClientRef.current ??= new HandClient();
        visionReady = handClientRef.current.init({
          onStatus: (status, detail) => {
            if (!isCurrentVisionActivation(attempt, activation, 'hand')) return;
            setCameraStatus(detail);
            if (status === 'error') { stopCamera(); setCameraStatus(detail); }
          },
        });
      } else {
        poseClientRef.current ??= new PoseClient();
        visionReady = poseClientRef.current.init({
          onStatus: (status, detail) => {
            if (!isCurrentVisionActivation(attempt, activation, 'pose')) return;
            poseCallbacksRef.current?.onStatus(status, detail);
          },
          onPose: (raw) => {
            if (!isCurrentVisionActivation(attempt, activation, 'pose')) return;
            poseCallbacksRef.current?.onPose(raw);
          },
        });
      }
      void visionReady.catch((error: unknown) => {
        failVisionActivation(attempt, activation, desiredMode, error, 'Não foi possível iniciar a visão.');
      });

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
    } catch (error) {
      if (stale()) return;
      stopCamera();
      setCameraStatus(error instanceof Error ? error.message : 'Não foi possível iniciar a câmera.');
    }
  }, [activateVisionMode, failVisionActivation, isCurrentVisionActivation, stopCamera]);

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

  const onStrokeTravel = useCallback((travel: number) => { pipelineRef.current.setStrokeTravel(travel); }, []);
  const onPunchTravel = useCallback((travel: number) => { pipelineRef.current.setPunchTravel(travel); }, []);

  const play = (next: Sport, distance: Goal = 100) => {
    setGoal(distance);
    void audioRef.current.unlock();
    // The warm-up tutorials set their own stroke length; every game starts from the default.
    pipelineRef.current.setStrokeTravel(1.9);
    pipelineRef.current.setPunchTravel(PUNCH_THRESHOLDS.confirmForwardTravel);
    pipelineRef.current.resetSwings();
    setSport(next);
    sportRef.current = next;
    setScreen('play');
  };

  const exitGame = () => {
    setIronResults(null);
    setScreen('home');
  };
  const startIronMan = () => {
    setIronResults([]);
    play('athletics', 100);
  };
  const finishIronStage = (result: IronManResult) => {
    if (!ironResults) return;
    const results = [...ironResults, result];
    setIronResults(results);
    if (result.sport === 'athletics') play('tennis');
    else if (result.sport === 'tennis') play('boxing');
    else setScreen('summary');
  };

  const menuBackRef = useRef<(() => void) | undefined>(undefined);
  const handBack = useCallback(() => menuBackRef.current?.(), []);

  const menu = inHandMenu(screen);

  return <div className="stage">
    {screen === 'play' && <GameCanvas key={`${sport}-${goal}`} sport={sport} goal={goal} onEngine={onEngine} tracking={tracking} audio={audioRef.current} crossedPose={crossedPoseRef} onExit={exitGame} ironMan={ironResults ? { onComplete: finishIronStage } : undefined} onStrokeTravel={onStrokeTravel} onPunchTravel={onPunchTravel} />}
    {screen === 'home' && (
      <HomeMenu
        exit={exit}
        onPick={(next, distance) => { setIronResults(null); play(next, distance); }}
        onIronMan={startIronMan}
        backRef={menuBackRef}
        handStore={handStore}
        rotationGateRef={homeRotationGateRef}
        carouselDebugRef={carouselDebugRef}
      />
    )}

    {screen === 'summary' && ironResults && <section className="menu iron-summary" aria-label="Resumo do Iron Man">
      <div className="iron-summary-card">
        <span className="iron-eyebrow">Wii Sports</span>
        <h1>Iron Man concluído!</h1>
        <p>Você completou as três modalidades.</p>
        <ol>{ironResults.map((result) => <li key={result.sport}>
          <strong>{result.sport === 'athletics' ? 'Atletismo · 100 m' : result.sport === 'tennis' ? 'Tênis' : 'Boxe'}</strong>
          <span>{result.detail}</span>
        </li>)}</ol>
        <button type="button" className="wii-btn" onClick={exitGame}>Voltar ao menu</button>
      </div>
    </section>}
    {screen === 'play' && ironResults && <div className="iron-progress">IRON MAN · ETAPA {ironResults.length + 1} DE 3</div>}
    {screen === 'play' && headCut && <div className="framing-hint" role="alert">Sua cabeça saiu do quadro · incline a câmera para cima ou afaste-se</div>}
    {screen === 'play' && keepPhotos && <div className="photo-notice">● guardando fotos dos últimos 20 s · E salva</div>}
    {recordingPrompt && <div className="recording-prompt" role="status">● {recordingPrompt}</div>}

    {screen === 'play' && <div className="hud-dock">
      <button type="button" className="dock-btn" onClick={exitGame}>{ironResults ? '‹ Sair do Iron Man' : '‹ Menu'}</button>
      <button type="button" className="dock-btn round" onClick={toggleMute} title={muted ? 'Áudio desligado' : 'Áudio ligado'}>{muted ? '×' : '♫'}</button>
    </div>}

    <HandCursor store={handStore} active={menu && cameraOn} onBack={handBack} />
    {menu && cameraOn && <HandDebugOverlay store={handStore} carouselRef={carouselDebugRef} />}

    <CameraPip
      videoRef={videoRef} canvasRef={overlayRef} cameraOn={cameraOn} status={cameraStatus} tracking={tracking}
      onStart={() => void startCamera()} onStop={stopCamera}
    />
    {showPerf && <PerfMeter videoRef={videoRef} poseFrames={poseFramesRef} poseDelay={poseDelayRef} />}
    {splash && <WiiSplash onDone={endSplash} />}
  </div>;
}
