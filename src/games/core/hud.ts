export interface HudFeedback {
  id: number;
  text: string;
  tone: 'good' | 'bad' | 'neutral';
}

export interface GameHudState {
  score: number;
  label: string;
  speed01: number;
  status: string;
  /** Optional sport-specific primary metric; the canvas falls back to its legacy labels without it. */
  metricLabel?: string;
  metricValue?: string;
  bestLabel?: string;
  rankLabel?: string;
  rankProgress01?: number;
  missionLabel?: string;
  missionProgress01?: number;
  detail?: string;
  feedback?: HudFeedback;
}
