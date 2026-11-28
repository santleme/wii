// @vitest-environment happy-dom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { CameraPip } from '../src/ui/CameraPip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('CameraPip', () => {
  it('collapses when the camera turns off and stays collapsed when it returns', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = {
      videoRef: createRef<HTMLVideoElement>(),
      canvasRef: createRef<HTMLCanvasElement>(),
      status: '',
      tracking: 'TRACKING',
      onStart: () => {},
      onStop: () => {},
    };

    await act(async () => {
      root.render(<CameraPip {...props} cameraOn />);
    });
    const expand = [...container.querySelectorAll('button')].find((button) => button.textContent === 'AMPLIAR');
    expect(expand).toBeDefined();
    await act(async () => {
      expand!.click();
    });
    expect(container.querySelector('aside')!.className).toContain('expanded');

    await act(async () => {
      root.render(<CameraPip {...props} cameraOn={false} />);
    });
    expect(container.querySelector('aside')!.className).not.toContain('expanded');

    await act(async () => {
      root.render(<CameraPip {...props} cameraOn />);
    });
    expect(container.querySelector('aside')!.className).not.toContain('expanded');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('keeps the same <video> element mounted while the camera is off', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const props = {
      videoRef: createRef<HTMLVideoElement>(),
      canvasRef: createRef<HTMLCanvasElement>(),
      status: '',
      tracking: 'TRACKING',
      onStart: () => {},
      onStop: () => {},
    };

    await act(async () => {
      root.render(<CameraPip {...props} cameraOn />);
    });
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(props.videoRef.current).toBe(video);

    // PR #40 invariant: conditional mounting would swap the element and drop its srcObject.
    await act(async () => {
      root.render(<CameraPip {...props} cameraOn={false} />);
    });
    expect(container.querySelector('video')).toBe(video);
    expect(props.videoRef.current).toBe(video);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
