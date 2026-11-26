import { describe, expect, it } from 'vitest';
import { TennisGame } from '../src/games/tennis/TennisGame';
import { emptyProgress, recordSportResult, type ProgressRecordResult } from '../src/games/engagement/progression';
import { createOpponentAi } from '../src/games/tennis/opponentAi';
import type { TennisScoreState } from '../src/games/tennis/tennisScore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type MatchCompletionHarness = {
  score: { games: { player: number } };
  pointsWon: number;
  pointsLost: number;
  bestRally: number;
  matchRecorded: boolean;
  matchGeneration: number;
  matchSummary: string;
  progressStore: {
    record: () => Promise<ProgressRecordResult>;
    load: () => ReturnType<typeof emptyProgress>;
  };
  finishMatch: (winner: 'player' | 'opponent') => Promise<unknown> | undefined;
};

type MatchEndHarness = {
  score: TennisScoreState;
  opponentAi: ReturnType<typeof createOpponentAi>;
  pointsWon: number;
  pointsLost: number;
  bestRally: number;
  rally: { finishPoint: () => number };
  ball: null;
  tape: unknown[];
  phase: unknown;
  status: string;
  feedbackCounter: number;
  feedback?: { id: number; text: string; tone: 'good' | 'bad' | 'neutral' };
  audio: { milestone: () => void };
  disposed: boolean;
  matchGeneration: number;
  finishMatch: (winner: 'player' | 'opponent') => Promise<{ record: ProgressRecordResult }>;
  updateMission: () => false | Promise<boolean>;
  setFeedback: (text: string, tone: 'good' | 'bad' | 'neutral') => void;
  endPoint: (winner: 'player' | 'opponent', headline: string, now?: number) => void;
};

function createGame(record: Promise<ProgressRecordResult>): MatchCompletionHarness {
  return Object.assign(Object.create(TennisGame.prototype) as object, {
    score: { games: { player: 2 } },
    pointsWon: 3,
    pointsLost: 2,
    bestRally: 5,
    matchRecorded: false,
    matchGeneration: 0,
    matchSummary: '',
    progressStore: {
      record: () => record,
      load: () => emptyProgress(),
    },
  }) as MatchCompletionHarness;
}

describe('Tennis match completion', () => {
  it('keeps the completed match summary snapshot while persistence is pending', async () => {
    const pending = deferred<ProgressRecordResult>();
    const game = createGame(pending.promise);
    const completion = game.finishMatch('player');

    game.pointsWon = 0;
    game.pointsLost = 0;
    game.bestRally = 0;
    pending.resolve(recordSportResult(emptyProgress(), 0, 0));
    await completion;

    expect(game.matchSummary).toContain('PONTOS 3×2 · MELHOR RALLY 5');
  });

  it('does not publish an old match summary after a rematch starts', async () => {
    const pending = deferred<ProgressRecordResult>();
    const game = createGame(pending.promise);
    const completion = game.finishMatch('player');

    game.matchGeneration += 1;
    pending.resolve(recordSportResult(emptyProgress(), 0, 0));
    await completion;

    expect(game.matchSummary).toBe('');
  });

  it('does not publish stale match-end feedback after a rematch starts', async () => {
    const matchCompletion = deferred<{ record: ProgressRecordResult }>();
    const missionCompletion = deferred<boolean>();
    let milestoneSounds = 0;
    const game = Object.assign(Object.create(TennisGame.prototype) as object, {
      score: {
        points: { player: 3, opponent: 0 },
        games: { player: 1, opponent: 0 },
        server: 'player',
        matchWinner: null,
      },
      opponentAi: createOpponentAi(),
      pointsWon: 4,
      pointsLost: 1,
      bestRally: 6,
      rally: { finishPoint: () => 1 },
      ball: null,
      tape: [],
      phase: { kind: 'rally' },
      status: '',
      feedbackCounter: 0,
      audio: { milestone: () => { milestoneSounds += 1; } },
      disposed: false,
      matchGeneration: 0,
      finishMatch: () => matchCompletion.promise,
      updateMission: () => missionCompletion.promise,
    }) as unknown as MatchEndHarness;

    game.endPoint('player', 'Ponto final', 100);
    game.matchGeneration += 1;
    game.setFeedback('Nova partida', 'neutral');

    matchCompletion.resolve({ record: recordSportResult(emptyProgress(), 0, 0) });
    missionCompletion.resolve(false);
    await Promise.all([matchCompletion.promise, missionCompletion.promise]);
    await Promise.resolve();

    expect(game.feedback?.text).toBe('Nova partida');
    expect(milestoneSounds).toBe(0);
  });
});
