import { createBrowserMissionStore, type MissionStore } from './missionStore';
import { createBrowserProgressStore, type ProgressStore } from './progressStore';

export interface EngagementStores {
  missions: MissionStore;
  progress: ProgressStore;
}

let browserStores: EngagementStores | undefined;

/**
 * Store instances live for the document session, independently of game engines. This keeps
 * their in-memory fallback intact when localStorage is unavailable and an engine is remounted.
 */
export function getBrowserEngagementStores(): EngagementStores {
  browserStores ??= {
    missions: createBrowserMissionStore(),
    progress: createBrowserProgressStore(),
  };
  return browserStores;
}
