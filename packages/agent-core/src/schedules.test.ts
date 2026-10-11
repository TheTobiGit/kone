import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { setUserDataDir } from "./userDataDir.js";
import { ScheduleRunner } from "./scheduleRunner.js";

mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));
let Store: typeof import("./ConversationStore.js").ConversationStore;

function freshStore(dir = mkdtempSync(path.join(tmpdir(), "kone-schedules-"))) {
  setUserDataDir(dir);
  return { store: new Store(), dir };
}

const template = { title: "scheduled", body: "run", target: { provider: "codex" as const } };

describe("schedule store", () => {
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

  test("a second store after downtime catches up once and old downtime skips", () => {
    const { store, dir } = freshStore();
    store.createSchedule({ scheduleId: "restart", projectPath: "/p", title: "recent", cron: "* * * * *", jobTemplate: template, at: 1_000 });
    store.close();
    const reopened = freshStore(dir).store;
    expect(reopened.fireDueSchedules(61_000).fired).toHaveLength(1);
    reopened.close();
  });
});

describe("schedule runner", () => {
  test("uses an injected clock and timer, caps its wait, and drains fired projects", async () => {
    let now = 10_000;
    let timerCallback: (() => void) | undefined;
    let timerDelay = 0;
    let fires = 0;
    const drains: string[] = [];
    const runner = new ScheduleRunner({
      store: {
        fireDueSchedules: (at) => { if (at >= 20_000) fires++; return { fired: at >= 20_000 ? [{ schedule: { scheduleId: "s", projectPath: "/p", title: "t", cron: "* * * * *", jobTemplate: template, paused: false, nextRunAt: 80_000, lastRunAt: at, lastJobId: "j", createdAt: 0, updatedAt: at }, job: { jobId: "j", projectPath: "/p", title: "t", body: "run", status: "queued", target: template.target, createdAt: at, updatedAt: at } }] : [], skipped: [] }; },
        listSchedules: () => [{ scheduleId: "s", projectPath: "/p", title: "t", cron: "* * * * *", jobTemplate: template, paused: false, nextRunAt: 80_000, lastRunAt: null, lastJobId: null, createdAt: 0, updatedAt: 0 }],
        projectsWithQueuedJobs: () => [],
      },
      drainProject: async (projectPath) => { drains.push(projectPath); },
      now: () => now,
      setTimer: (callback, delay) => { timerCallback = callback; timerDelay = delay; return setTimeout(() => {}, 100_000); },
      clearTimer: (timer) => clearTimeout(timer),
    });
    runner.start();
    await Promise.resolve();
    expect(timerDelay).toBe(60_000);
    now = 20_000;
    timerCallback?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(fires).toBe(1);
    expect(drains).toEqual(["/p"]);
    runner.stop();
  });
});

// Resolve the constructor after mock.module has replaced the native SQLite adapter.
const storeModule = await import("./ConversationStore.js");
Store = storeModule.ConversationStore;
