import { missionProgress01, type DailyMission } from './missions';
import type { MissionStore } from './missionStore';

/**
 * Live high-watermark progress for one run or match. Completion is written once;
 * resetting the value starts a new attempt without reopening a mission already done today.
 */
export class MissionTracker {
  private completed: boolean;
  private value = 0;

  constructor(
    private readonly store: MissionStore,
    private readonly dateIso: string,
    readonly mission: DailyMission,
  ) {
    this.completed = store.isCompleted(dateIso, mission.sport, mission.id);
  }

  get isCompleted(): boolean {
    return this.completed;
  }

  get currentValue(): number {
    return this.value;
  }

  resetValue(): void {
    this.value = 0;
  }

  /** Returns true only on the update that first completes the mission. */
  update(rawValue: number): boolean {
    if (Number.isFinite(rawValue)) this.value = Math.max(this.value, Math.max(0, rawValue));
    if (this.completed || this.value < this.mission.target) return false;
    this.completed = true;
    this.store.complete(this.dateIso, this.mission.sport, this.mission.id);
    return true;
  }

  progress01(): number {
    return this.completed ? 1 : missionProgress01(this.value, this.mission.target);
  }

  label(): string {
    const shown = this.completed ? this.mission.target : Math.min(this.mission.target, Math.floor(this.value));
    return `${this.completed ? '✓ ' : ''}${this.mission.text} · ${shown}/${this.mission.target}`;
  }
}
