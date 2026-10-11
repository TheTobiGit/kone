import type { ScheduleRow, ScheduleFireResult } from "./conversationStoreTypes.js";

type Timer = ReturnType<typeof setTimeout>;
export type ScheduleRunnerStore = {
  fireDueSchedules(now: number, graceMs?: number, deferredScheduleIds?: readonly string[]): ScheduleFireResult;
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
  private tickInFlight = false;
  private readonly drainingProjects = new Set<string>();
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

  private tick(): void {
    if (this.stopped) return;
    if (this.tickInFlight) {
      this.arm();
      return;
    }
    this.tickInFlight = true;
    const projects = new Set<string>();
    try {
      const now = this.now();
      const deferred = [...this.failedOccurrences]
        .filter(([, failure]) => failure.retryAt > now)
        .map(([scheduleId]) => scheduleId);
      const fired = this.deps.store.fireDueSchedules(now, undefined, deferred);
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
      for (const { schedule } of fired.fired) projects.add(schedule.projectPath);
      for (const projectPath of this.deps.store.projectsWithQueuedJobs()) projects.add(projectPath);
    } catch (error) {
      console.error("[schedule-runner] schedule tick failed:", error);
    } finally {
      this.tickInFlight = false;
      this.arm();
    }

    for (const projectPath of projects) {
      if (this.stopped || this.drainingProjects.has(projectPath)) continue;
      this.drainingProjects.add(projectPath);
      void this.drain(projectPath);
    }
  }

  private async drain(projectPath: string): Promise<void> {
    try {
      await this.deps.drainProject(projectPath);
    } catch (error) {
      console.error(`[schedule-runner] could not drain queued jobs for ${projectPath}:`, error);
    } finally {
      this.drainingProjects.delete(projectPath);
    }
  }

  private arm(): void {
    if (this.timer) this.clearTimer(this.timer);
    if (this.stopped) return;
    let delay = 60_000;
    try {
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
      delay = Math.min(60_000, Math.max(1_000, (next ?? this.now() + 60_000) - this.now()));
    } catch (error) {
      console.error("[schedule-runner] could not inspect schedules for timer:", error);
    }
    this.timer = this.setTimer(() => { this.timer = null; void this.tick(); }, delay);
    this.timer.unref?.();
  }
}
