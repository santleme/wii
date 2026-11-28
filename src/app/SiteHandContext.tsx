// The site's single hand camera: one MediaStream and one HandClient, shared by the hand cursor on every
// page and the 3D hand on /product. Nothing is created or downloaded until the user asks for the camera.
//
// State: the provider owns the stream, the client, the hidden video and `cameraAttemptRef`, the epoch that
// invalidates pending work. releaseCamera() is the only teardown path; a getUserMedia that resolves under a
// stale epoch stops its own tracks. Frames are published on the capture callback to the cursor input state
// and to subscribers, which must not keep the snapshot's arrays past the call if they mutate them.
import type { HandSnapshot } from '@wii/spatial-core';
import { createContext, type ReactNode, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HandClient } from '../cv/handClient';
import { HandCursorDetector } from '../kinematics/handCursor';
import { HAND_IDLE, type HandCursorInput } from '../ui/handCursorTypes';

export type SiteCameraState = 'off' | 'starting' | 'on';
export type SiteCameraError = 'unsupported' | 'denied' | 'missing' | 'busy' | 'failed';
export type HandFrameListener = (snapshot: HandSnapshot, aspectY: number) => void;

type SiteHand = {
  camera: SiteCameraState;
  error: SiteCameraError | undefined;
  enableCamera(): Promise<void>;
  stopCamera(): void;
  warmAssets(): void;
  /** Returns the unsubscribe function. */
  subscribe(listener: HandFrameListener): () => void;
  /** The live stream, for previews. */
  getStream(): MediaStream | undefined;
};

const SiteHandContext = createContext<SiteHand | null>(null);
// Separate so that only the cursor re-renders at camera frame rate.
const SiteHandInputContext = createContext<HandCursorInput>(HAND_IDLE);

export function useSiteHand(): SiteHand {
  const value = useContext(SiteHandContext);
  if (!value) throw new Error('useSiteHand needs <SiteHandProvider>');
  return value;
}

export const useSiteHandInput = () => useContext(SiteHandInputContext);

/** `inArena` releases the camera: the arena claims it with its own client. */
export function SiteHandProvider({ inArena, children }: { inArena: boolean; children: ReactNode }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const clientRef = useRef<HandClient | undefined>(undefined);
  const detectorRef = useRef<HandCursorDetector | undefined>(undefined);
  const listenersRef = useRef(new Set<HandFrameListener>());
  const cameraAttemptRef = useRef(0);
  const warmedRef = useRef(false);
  const [camera, setCamera] = useState<SiteCameraState>('off');
  const [error, setError] = useState<SiteCameraError>();
  const [input, setInput] = useState<HandCursorInput>(HAND_IDLE);

  const releaseCamera = useCallback(() => {
    cameraAttemptRef.current += 1;
    clientRef.current?.dispose();
    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    streamRef.current = undefined;
    if (videoRef.current) videoRef.current.srcObject = null;
    detectorRef.current?.reset();
    setInput(HAND_IDLE);
  }, []);

  const stop = useCallback(
    (reason?: SiteCameraError) => {
      releaseCamera();
      setCamera('off');
      setError(reason);
    },
    [releaseCamera],
  );
  const stopCamera = useCallback(() => stop(), [stop]);

  const warmAssets = useCallback(() => {
    if (warmedRef.current) return;
    warmedRef.current = true;
    HandClient.warmVisionAssets();
  }, []);

  const enableCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('unsupported');
      return;
    }
    releaseCamera();
    const attempt = cameraAttemptRef.current;
    const stale = () => cameraAttemptRef.current !== attempt;
    const fail = (reason: SiteCameraError) => {
      if (!stale()) stop(reason);
    };
    setError(undefined);
    setCamera('starting');
    try {
      clientRef.current ??= new HandClient();
      const client = clientRef.current;
      const visionReady = client.init({
        onStatus: (status) => {
          if (status === 'error') fail('failed');
        },
      });
      // Observed now so an init failure during the permission prompt is not an unhandled rejection.
      void visionReady.catch(() => undefined);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      });
      if (stale()) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      streamRef.current = stream;
      for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => fail('failed'));
      const video = videoRef.current;
      if (!video) throw new Error('Camera preview is unavailable.');
      video.srcObject = stream;
      await video.play();
      await visionReady;
      if (stale()) return;
      detectorRef.current ??= new HandCursorDetector({ indexTapClick: true });
      const detector = detectorRef.current;
      setCamera('on');
      client.beginCapture(
        video,
        (snapshot, aspectY) => {
          if (stale()) return;
          const primary = snapshot.hands[0];
          const state = detector.update({
            timestampMs: snapshot.timestampMs,
            landmarks: primary?.landmarks ?? [],
            worldLandmarks: primary?.worldLandmarks,
            handedness: primary?.handedness,
            handednessScore: primary?.handednessScore,
            aspectY,
            rotationEnabled: false,
          });
          setInput({
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
          });
          for (const listener of listenersRef.current) listener(snapshot, aspectY);
        },
        () => fail('failed'),
      );
    } catch (cause) {
      const name = cause instanceof DOMException ? cause.name : '';
      if (name === 'NotAllowedError') fail('denied');
      else if (name === 'NotFoundError') fail('missing');
      else if (name === 'NotReadableError') fail('busy');
      else fail('failed');
    }
  }, [releaseCamera, stop]);

  // A layout effect runs before any passive effect of the arena that is mounting.
  useLayoutEffect(() => {
    if (inArena) stopCamera();
  }, [inArena, stopCamera]);
  useLayoutEffect(() => releaseCamera, [releaseCamera]);

  const subscribe = useCallback((listener: HandFrameListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);
  const getStream = useCallback(() => streamRef.current, []);

  const value = useMemo(
    () => ({ camera, error, enableCamera, stopCamera, warmAssets, subscribe, getStream }),
    [camera, error, enableCamera, stopCamera, warmAssets, subscribe, getStream],
  );

  return (
    <SiteHandContext.Provider value={value}>
      <SiteHandInputContext.Provider value={input}>
        {children}
        {/* Capture source. Kept rendered (not display:none) so video frame callbacks keep firing. */}
        <video ref={videoRef} className="site-hand-video" muted playsInline tabIndex={-1} aria-hidden="true" />
      </SiteHandInputContext.Provider>
    </SiteHandContext.Provider>
  );
}
