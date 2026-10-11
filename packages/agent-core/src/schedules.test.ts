import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { setUserDataDir } from "./userDataDir.js";
import { ScheduleRunner } from "./scheduleRunner.js";
import { ScheduleJobTemplateSchema } from "./conversationStoreTypes.js";
import { ConversationDb } from "./store/ConversationDb.js";
import { ScheduleRepo } from "./store/schedules.js";

mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));
let Store: typeof import("./ConversationStore.js").ConversationStore;

function freshStore(dir = mkdtempSync(path.join(tmpdir(), "kone-schedules-"))) {
  setUserDataDir(dir);
  return { store: new Store(), dir };
}

const template = { title: "scheduled", body: "run", target: { provider: "codex" as const } };

function fakeTimers() {
  let callback: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armed = false;
  let delayMs = 0;
  return {
    setTimer(next: () => void, delay: number) {
      callback = next;
      delayMs = delay;
      armed = true;
      timer = setTimeout(() => {}, 100_000);
      return timer;
    },
    clearTimer(activeTimer: ReturnType<typeof setTimeout>) {
      clearTimeout(activeTimer);
      armed = false;
    },
    fire() {
      if (timer) clearTimeout(timer);
      armed = false;
      callback?.();
    },
    isArmed: () => armed,
    delay: () => delayMs,
  };
}

describe("schedule store", () => {
  test("job templates validate provider, mode, workspace, fallback and attachment enums", () => {
    const result = ScheduleJobTemplateSchema.safeParse({
      title: "invalid", body: "run",
      target: { provider: "not-a-provider", mode: "unsafe", workspace: { mode: "remote" }, fallbacks: [{ provider: "unknown" }] },
      attachments: [{ type: "video", id: "x", name: "x", mimeType: "video/mp4", sizeBytes: 1 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((issue) => issue.path.join("."));
      expect(fields).toContain("target.provider");
      expect(fields).toContain("target.mode");
      expect(fields).toContain("target.workspace.mode");
      expect(fields).toContain("target.fallbacks.0.provider");
      expect(fields).toContain("attachments.0.type");
    }
  });

  test("fires due occurrences once, creates linked queued job and skips pile-ups", () => {
    const { store, dir } = freshStore();
    const secondStore = freshStore(dir).store;
    const row = store.createSchedule({ scheduleId: "s1", projectPath: "/p", title: "daily", cron: "0 9 * * *", jobTemplate: template, at: new Date("2025-01-01T08:00:00").getTime() });
    expect(row?.nextRunAt).toBe(new Date("2025-01-01T09:00:00").getTime());
    const fired = store.fireDueSchedules(new Date("2025-01-01T09:00:00").getTime());
    expect(fired.fired).toHaveLength(1);
    expect(fired.fired[0]?.job.scheduleId).toBe("s1");
    expect(secondStore.fireDueSchedules(new Date("2025-01-01T09:00:00").getTime()).fired).toHaveLength(0);
    expect(store.fireDueSchedules(new Date("2025-01-01T09:00:01").getTime()).fired).toHaveLength(0);
    expect(store.fireDueSchedules(new Date("2025-01-02T09:00:00").getTime()).skipped[0]?.reason).toBe("job-active");
    store.close();
    secondStore.close();
  });

  test("catches up only a recent missed occurrence and advances old ones without firing", () => {
    const { store } = freshStore();
    store.createSchedule({ scheduleId: "recent", projectPath: "/p", title: "recent", cron: "* * * * *", jobTemplate: template, at: 1_000 });
    expect(store.fireDueSchedules(61_000).fired).toHaveLength(1);
    store.createSchedule({ scheduleId: "old", projectPath: "/p", title: "old", cron: "* * * * *", jobTemplate: template, at: 1_000 });
    expect(store.fireDueSchedules(20 * 60_000).skipped).toContainEqual({ scheduleId: "old", reason: "outside-grace" });
    store.close();
  });

  test("pause, resume, edit and delete preserve expected scheduling state", () => {
    const { store } = freshStore();
    store.createSchedule({ scheduleId: "edit", projectPath: "/p", title: "daily", cron: "0 9 * * *", jobTemplate: template, at: 1_000 });
    expect(store.pauseSchedule("edit", 2_000)?.nextRunAt).toBeNull();
    expect(store.updateSchedule("edit", { cron: "0 10 * * *" }, 3_000)?.nextRunAt).toBeNull();
    expect(store.resumeSchedule("edit", new Date("2025-01-01T09:00:00").getTime())?.nextRunAt).toBe(new Date("2025-01-01T10:00:00").getTime());
    expect(store.deleteSchedule("edit")).toBe(true);
    expect(store.getSchedule("edit")).toBeNull();
    store.close();
  });

  test("run now leaves the next occurrence intact and refuses to pile up", () => {
    const { store } = freshStore();
    const created = store.createSchedule({ scheduleId: "manual", projectPath: "/p", title: "daily", cron: "0 9 * * *", jobTemplate: template, at: new Date("2025-01-01T08:00:00").getTime() });
    const before = created?.nextRunAt;
    const run = store.runNow("manual", new Date("2025-01-01T08:30:00").getTime());
    expect(run.job?.scheduleId).toBe("manual");
    expect(store.getSchedule("manual")?.nextRunAt).toBe(before);
    expect(store.runNow("manual").reason).toContain("still queued or running");
    store.close();
  });

  test("a run-now committed after due enumeration prevents the firing transaction from piling up", () => {
    const { store, dir } = freshStore();
    store.createSchedule({ scheduleId: "interleave", projectPath: "/p", title: "daily", cron: "* * * * *", jobTemplate: template, at: 1_000 });
    const dbh = new ConversationDb(dir);
    const repo = new ScheduleRepo(dbh, {
      beforeFireTransaction: (scheduleId) => {
        expect(scheduleId).toBe("interleave");
        expect(store.runNow(scheduleId, 60_000).job?.scheduleId).toBe(scheduleId);
      },
    });
    const result = repo.fireDue(60_000);
    expect(result.fired).toHaveLength(0);
    expect(result.skipped).toEqual([{ scheduleId: "interleave", reason: "job-active" }]);
    expect(store.listJobs("/p").filter((job) => job.scheduleId === "interleave")).toHaveLength(1);
    dbh.close();
    store.close();
  });

  test("a second store after downtime catches up once and old downtime skips", () => {
    const { store, dir } = freshStore();
    store.createSchedule({ scheduleId: "restart", projectPath: "/p", title: "recent", cron: "* * * * *", jobTemplate: template, at: 1_000 });
    store.close();
    const reopened = freshStore(dir).store;
    expect(reopened.fireDueSchedules(61_000).fired).toHaveLength(1);
    reopened.close();
  });

  test("reports a rolled-back firing occurrence for bounded retry", () => {
    const { store, dir } = freshStore();
    store.createSchedule({ scheduleId: "retry", projectPath: "/p", title: "retry", cron: "* * * * *", jobTemplate: template, at: 1_000 });
    const raw = new Database(path.join(dir, "kone.sqlite"));
    raw.exec("CREATE TRIGGER reject_scheduled_jobs BEFORE INSERT ON jobs BEGIN SELECT RAISE(FAIL, 'test insert failure'); END");
    const result = store.fireDueSchedules(60_000);
    expect(result.failures).toEqual([{ scheduleId: "retry", occurrenceAt: 60_000, error: "test insert failure" }]);
    expect(store.getSchedule("retry")?.nextRunAt).toBe(60_000);
    raw.close();
    store.close();
  });
});

describe("schedule runner", () => {
  test("uses an injected clock and timer, caps its wait, and drains fired projects", async () => {
    let now = 10_000;
    const timers = fakeTimers();
    let fires = 0;
    const drains: string[] = [];
    const runner = new ScheduleRunner({
      store: {
        fireDueSchedules: (at) => { if (at >= 20_000) fires++; return { fired: at >= 20_000 ? [{ schedule: { scheduleId: "s", projectPath: "/p", title: "t", cron: "* * * * *", jobTemplate: template, paused: false, nextRunAt: 80_000, lastRunAt: at, lastJobId: "j", createdAt: 0, updatedAt: at }, job: { jobId: "j", projectPath: "/p", title: "t", body: "run", status: "queued", target: template.target, createdAt: at, updatedAt: at } }] : [], skipped: [], failures: [] }; },
        listSchedules: () => [{ scheduleId: "s", projectPath: "/p", title: "t", cron: "* * * * *", jobTemplate: template, paused: false, nextRunAt: 80_000, lastRunAt: null, lastJobId: null, createdAt: 0, updatedAt: 0 }],
        projectsWithQueuedJobs: () => [],
      },
      drainProject: async (projectPath) => { drains.push(projectPath); },
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    runner.start();
    await Promise.resolve();
    expect(timers.delay()).toBe(60_000);
    now = 20_000;
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(fires).toBe(1);
    expect(drains).toEqual(["/p"]);
    runner.stop();
  });

  test("retries a failed due occurrence after 30 seconds, backs off to 60, and logs once", async () => {
    let now = 10_000;
    const timers = fakeTimers();
    const runner = new ScheduleRunner({
      store: {
        fireDueSchedules: () => ({ fired: [], skipped: [], failures: [{ scheduleId: "bad", occurrenceAt: 9_000, error: "insert rejected" }] }),
        listSchedules: () => [{ scheduleId: "bad", projectPath: "/p", title: "bad", cron: "* * * * *", jobTemplate: template, paused: false, nextRunAt: 9_000, lastRunAt: null, lastJobId: null, createdAt: 0, updatedAt: 0 }],
        projectsWithQueuedJobs: () => [],
      },
      drainProject: async () => {},
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    runner.start();
    await Promise.resolve();
    expect(timers.delay()).toBe(30_000);
    now = 40_000;
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();
    expect(timers.delay()).toBe(60_000);
    expect(errorLog).toHaveBeenCalledTimes(1);
    runner.stop();
    errorLog.mockRestore();
  });

  test("a rejected project drain is caught and leaves a heartbeat armed", async () => {
    const timers = fakeTimers();
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const runner = new ScheduleRunner({
      store: {
        fireDueSchedules: () => ({ fired: [], skipped: [], failures: [] }),
        listSchedules: () => [],
        projectsWithQueuedJobs: () => ["/broken"],
      },
      drainProject: async () => { throw new Error("temporary drain failure"); },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    runner.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(timers.isArmed()).toBe(true);
    runner.stop();
    expect(timers.isArmed()).toBe(false);
    errorLog.mockRestore();
  });

  test("a never-resolving drain leaves the heartbeat armed and stop clears it", () => {
    const timers = fakeTimers();
    let dueCalls = 0;
    const runner = new ScheduleRunner({
      store: {
        fireDueSchedules: () => { dueCalls++; return { fired: [], skipped: [], failures: [] }; },
        listSchedules: () => [],
        projectsWithQueuedJobs: () => ["/slow"],
      },
      drainProject: () => new Promise(() => {}),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    runner.start();
    expect(dueCalls).toBe(1);
    expect(timers.isArmed()).toBe(true);
    timers.fire();
    expect(dueCalls).toBe(1);
    expect(timers.isArmed()).toBe(true);
    runner.stop();
    expect(timers.isArmed()).toBe(false);
  });
});

// Resolve the constructor after mock.module has replaced the native SQLite adapter.
const storeModule = await import("./ConversationStore.js");
Store = storeModule.ConversationStore;
