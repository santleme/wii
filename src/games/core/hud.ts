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
  feedback?: HudFeedback;
  /** Large instruction over the court. */
  banner?: { title: string; detail?: string };
  tennis?: {
    points: Readonly<Record<"player" | "opponent", string>>;
    games: Readonly<Record<"player" | "opponent", number>>;
    server: "player" | "opponent";
    winner: "player" | "opponent" | null;
    secondServe: boolean;
    /** The raise-both-hands gesture after the match, 0–1. */
    restart01: number;
  };
}
