import type { ScheduleRow, ScheduleFireResult } from "./conversationStoreTypes.js";

type Timer = ReturnType<typeof setTimeout>;
export type ScheduleRunnerStore = {
  fireDueSchedules(now: number, graceMs?: number): ScheduleFireResult;
  listSchedules(projectPath?: string): ScheduleRow[];
  projectsWithQueuedJobs(): string[];
};
export type ScheduleRunnerDeps = {
  store: ScheduleRunnerStore;
  drainProject: (projectPath: string) => Promise<void>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};

/** Wakes on the nearest schedule while keeping a bounded heartbeat for clock
 *  changes and external schedule edits. The database remains the source of truth. */
export class ScheduleRunner {
  private timer: Timer | null = null;
  private stopped = true;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly failedOccurrences = new Map<string, { occurrenceAt: number; attempt: number; retryAt: number }>();
  private readonly loggedFailures = new Set<string>();

  constructor(private readonly deps: ScheduleRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = deps.clearTimer ?? clearTimeout;
  }

  start(): void { this.stopped = false; void this.tick(); }
  stop(): void { this.stopped = true; if (this.timer) this.clearTimer(this.timer); this.timer = null; }
  rearm(): void { if (!this.stopped) this.arm(); }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const fired = this.deps.store.fireDueSchedules(this.now());
    for (const failure of fired.failures) {
      const previous = this.failedOccurrences.get(failure.scheduleId);
      const attempt = previous?.occurrenceAt === failure.occurrenceAt ? previous.attempt + 1 : 1;
      const retryAt = this.now() + Math.min(60_000, 30_000 * 2 ** (attempt - 1));
      this.failedOccurrences.set(failure.scheduleId, { occurrenceAt: failure.occurrenceAt, attempt, retryAt });
      const key = `${failure.scheduleId}:${failure.occurrenceAt}`;
      if (!this.loggedFailures.has(key)) {
        this.loggedFailures.add(key);
        console.error(`[schedule-runner] schedule ${failure.scheduleId} occurrence ${failure.occurrenceAt} failed: ${failure.error}`);
      }
    }
    const projects = new Set([...fired.fired.map(({ schedule }) => schedule.projectPath), ...this.deps.store.projectsWithQueuedJobs()]);
    for (const projectPath of projects) await this.deps.drainProject(projectPath);
    this.arm();
  }

  private arm(): void {
    if (this.timer) this.clearTimer(this.timer);
    if (this.stopped) return;
    const future = this.deps.store.listSchedules().flatMap((schedule) => {
      if (schedule.paused || schedule.nextRunAt === null) {
        this.failedOccurrences.delete(schedule.scheduleId);
        return [];
      }
      const failed = this.failedOccurrences.get(schedule.scheduleId);
      if (failed && failed.occurrenceAt !== schedule.nextRunAt) {
        this.failedOccurrences.delete(schedule.scheduleId);
        this.loggedFailures.delete(`${schedule.scheduleId}:${failed.occurrenceAt}`);
        return [schedule.nextRunAt];
      }
      return [failed?.retryAt ?? schedule.nextRunAt];
    });
    const next = future.length ? Math.min(...future) : null;
    const delay = Math.min(60_000, Math.max(0, (next ?? this.now() + 60_000) - this.now()));
    this.timer = this.setTimer(() => { this.timer = null; void this.tick(); }, delay);
    this.timer.unref?.();
  }
}
