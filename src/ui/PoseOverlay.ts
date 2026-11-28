import type { PoseSnapshot } from '../cv/protocol';

const BONES: readonly [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32]];
const previousWrists = new Map<number, { x: number; y: number; timestampMs: number }>();

function prepCanvas(canvas: HTMLCanvasElement | null, video: HTMLVideoElement | null): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
  if (!canvas || !video) return null;
  const width = video.videoWidth || 640;
  const height = video.videoHeight || 480;
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

export function drawPose(canvas: HTMLCanvasElement | null, video: HTMLVideoElement | null, snapshot?: PoseSnapshot): void {
  const prep = prepCanvas(canvas, video);
  if (!prep) return;
  const { ctx, width, height } = prep;
  if (!snapshot) { previousWrists.clear(); return; }
  ctx.lineWidth = Math.max(2, width / 320);
  ctx.strokeStyle = snapshot.trackingState === 'tracked' ? '#f5ad42' : '#fa6262';
  ctx.fillStyle = '#fff2cf';
  for (const [a, b] of BONES) {
    const p = snapshot.landmarks[a]; const q = snapshot.landmarks[b];
    if (!p || !q || Math.min(p.visibility ?? 0, q.visibility ?? 0) < 0.35) continue;
    ctx.beginPath(); ctx.moveTo(p.x * width, p.y * height); ctx.lineTo(q.x * width, q.y * height); ctx.stroke();
  }
  for (const index of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    const p = snapshot.landmarks[index];
    if (!p || (p.visibility ?? 0) < 0.35) continue;
    ctx.beginPath(); ctx.arc(p.x * width, p.y * height, Math.max(3, width / 120), 0, Math.PI * 2); ctx.fill();
  }
  for (const index of [15, 16]) {
    const wrist = snapshot.landmarks[index];
    const previous = previousWrists.get(index);
    if (wrist && (wrist.visibility ?? 0) >= 0.5 && previous && snapshot.trackingState === 'tracked') {
      const dt = (snapshot.timestampMs - previous.timestampMs) / 1000;
      if (dt > 0) {
        const vx = (wrist.x - previous.x) / dt;
        const vy = (wrist.y - previous.y) / dt;
        const projected = Math.hypot(vx, vy) * 0.12;
        if (projected > 0.025) {
          const length = Math.min(projected, 0.18);
          const x1 = wrist.x * width; const y1 = wrist.y * height;
          const x2 = x1 + (vx / Math.hypot(vx, vy)) * length * width;
          const y2 = y1 + (vy / Math.hypot(vx, vy)) * length * height;
          ctx.strokeStyle = index === 15 ? '#76e4ff' : '#d8ff54';
          ctx.lineWidth = Math.max(2, width / 240);
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          const angle = Math.atan2(y2 - y1, x2 - x1);
          ctx.beginPath(); ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - 8 * Math.cos(angle - 0.45), y2 - 8 * Math.sin(angle - 0.45));
          ctx.moveTo(x2, y2); ctx.lineTo(x2 - 8 * Math.cos(angle + 0.45), y2 - 8 * Math.sin(angle + 0.45)); ctx.stroke();
        }
      }
    }
    if (wrist) previousWrists.set(index, { x: wrist.x, y: wrist.y, timestampMs: snapshot.timestampMs });
  }
}
