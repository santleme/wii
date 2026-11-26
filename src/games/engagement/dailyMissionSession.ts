import { dailyMissionFor, MISSION_XP, type DailyMission } from './missions';
import type { MissionStore } from './missionStore';
import { missionCompletionKey } from './missionCompletion';
import { MissionTracker } from './missionTracker';
import type { SportKey } from './progression';

/** Keeps a daily mission stable during one match, rolling it over at the next attempt. */
export class DailyMissionSession {
  private currentDateIso: string;
  private currentMission: DailyMission;
  private currentTracker: MissionTracker;

  constructor(
    private readonly store: MissionStore,
    private readonly sport: SportKey,
    dateIso: string,
  ) {
    this.currentDateIso = dateIso;
    this.currentMission = dailyMissionFor(sport, dateIso);
    this.currentTracker = new MissionTracker(store, dateIso, this.currentMission, MISSION_XP);
  }

  get mission(): DailyMission {
    return this.currentMission;
  }

  get completionKey(): string {
    return missionCompletionKey(this.currentDateIso, this.sport, this.currentMission.id);
  }

  get tracker(): MissionTracker {
    return this.currentTracker;
  }

  /** Starts a clean attempt; a new calendar day also gets its own mission and completion state. */
  startAttempt(dateIso: string): void {
    if (dateIso === this.currentDateIso) {
      this.currentTracker.resetValue();
      return;
    }

    this.currentDateIso = dateIso;
    this.currentMission = dailyMissionFor(this.sport, dateIso);
    this.currentTracker = new MissionTracker(this.store, dateIso, this.currentMission, MISSION_XP);
  }
}
