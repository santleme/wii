/**
 * Opt-in (`?fotos`) small camera pictures kept beside the body points of a mistake clip, so whoever
 * debugs it can see what the player did instead of asking. In memory only until E saves the clip.
 */
export interface Photo { timestampMs: number; jpeg: string }

const EVERY_MS = 200;
const KEEP_MS = 20_000;
const WIDTH = 240;

export class PhotoTrail {
  private photos: Photo[] = [];
  private canvas?: HTMLCanvasElement;

  /** `timestampMs` is the pose frame's, so pictures and points share one clock. */
  add(timestampMs: number, video: HTMLVideoElement | null): void {
    const last = this.photos.at(-1)?.timestampMs ?? Number.NEGATIVE_INFINITY;
    if (!video?.videoWidth || timestampMs - last < EVERY_MS) return;
    this.canvas ??= document.createElement('canvas');
    this.canvas.width = WIDTH;
    this.canvas.height = Math.round((WIDTH * video.videoHeight) / video.videoWidth);
    const context = this.canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
    this.keep({ timestampMs, jpeg: this.canvas.toDataURL('image/jpeg', 0.6) });
  }

  keep(photo: Photo): void {
    this.photos.push(photo);
    while (photo.timestampMs - this.photos[0]!.timestampMs > KEEP_MS) this.photos.shift();
  }

  get all(): readonly Photo[] { return this.photos; }

  clear(): void { this.photos = []; }
}
