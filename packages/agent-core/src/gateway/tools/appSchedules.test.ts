import { describe, expect, it } from "bun:test";

import type { JobRow } from "../../conversationStoreTypes.js";
import { createRegistry } from "../registry.js";
import type { GatewayToolContext } from "../registry.js";
import type { ProjectRosterEntry } from "./appProjects.js";
import { createAppScheduleTools, type AppSchedulesStore, type ScheduleJobTemplate, type ScheduleRow } from "./appSchedules.js";

const PROJECT = "/Users/dev/Developer/kone";
const PROJECTS: readonly ProjectRosterEntry[] = [{ path: PROJECT, name: "kone", active: true, pinned: false, lastOpenedAt: null }];
const TEMPLATE: ScheduleJobTemplate = { title: "Check status", body: "Summarize the project", target: { provider: "codex" } };
const JOB: JobRow = { jobId: "job-1", projectPath: PROJECT, title: TEMPLATE.title, body: TEMPLATE.body, status: "queued", target: TEMPLATE.target, createdAt: 10, updatedAt: 10 };

function makeSchedule(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return { scheduleId: "schedule-1", projectPath: PROJECT, title: "Morning check", cron: "0 9 * * 1-5", jobTemplate: TEMPLATE, paused: false, nextRunAt: Date.UTC(2026, 9, 12, 9), lastRunAt: null, lastJobId: null, createdAt: 1, updatedAt: 1, ...overrides };
}
function fixture() {
  let row: ScheduleRow | null = makeSchedule();
  const store: AppSchedulesStore = {
    listSchedules: (path) => row && (!path || row.projectPath === path) ? [row] : [],
    getSchedule: (scheduleId) => row?.scheduleId === scheduleId ? row : null,
    createSchedule: (input) => (row = makeSchedule({ ...input, paused: false, nextRunAt: 1_800_000_000_000, lastRunAt: null, lastJobId: null, createdAt: 1, updatedAt: input.at ?? 1 })),
    updateSchedule: (_id, patch) => {
      if (patch.cron === "not cron") throw new Error('Invalid cron expression "not cron": expected five fields.');
      return row ? (row = { ...row, ...patch, updatedAt: 2 }) : null;
    },
    pauseSchedule: () => row ? (row = { ...row, paused: true, nextRunAt: null }) : null,
    resumeSchedule: () => row ? (row = { ...row, paused: false, nextRunAt: 1_800_000_000_000 }) : null,
    deleteSchedule: () => { row = null; return true; },
    runNow: () => ({ job: JOB }),
  };
  const registry = createRegistry(createAppScheduleTools({ store, readProjects: () => PROJECTS, now: () => 100, createId: () => "schedule-new" }));
  return { registry, store };
}
function ctx(): GatewayToolContext { return { threadId: "assistant-1", turnId: "turn-1", provider: "codex", cwd: PROJECT, requestId: "request-1" }; }
function body(result: { content: Array<{ text: string }> }): string { return result.content.map((part) => part.text).join("\n"); }

describe("assistant schedule tools", () => {
  it("lists schedules with all fields in text and strips structured content for assistant", async () => {
    const { registry } = fixture();
    const out = await registry.call(ctx(), "app_list_schedules", {}, "assistant");
    expect(out.isError).toBeUndefined();
    expect(body(out)).toContain("schedule-1");
    expect(body(out)).toContain("Morning check");
    expect(body(out)).toContain("0 9 * * 1-5");
    expect(body(out)).toContain(new Date(makeSchedule().nextRunAt!).toISOString());
    expect(body(out)).toContain("last job none");
    expect(out.structuredContent).toBeUndefined();
  });

  it("creates a schedule, resolving the project name and retaining its required details in text", async () => {
    const { registry } = fixture();
    const out = await registry.call(ctx(), "app_create_schedule", { project: "kone", title: "Morning check", cron: "0 9 * * 1-5", jobTemplate: TEMPLATE }, "assistant");
    expect(body(out)).toContain("schedule-new");
    expect(body(out)).toContain("/Users/dev/Developer/kone");
    expect(body(out)).toContain("active");
    expect(out.structuredContent).toBeUndefined();
  });

  it("refuses invalid job target enums with the field name in assistant text", async () => {
    const { registry } = fixture();
    const invalid = await registry.call(ctx(), "app_create_schedule", {
      project: "kone", title: "bad provider", cron: "0 9 * * *",
      jobTemplate: { ...TEMPLATE, target: { provider: "not-a-provider" } },
    }, "assistant");
    expect(invalid.isError).toBe(true);
    expect(body(invalid)).toContain("target.provider");
  });

  it("updates a schedule and refuses an invalid cron from the store as assistant-visible text", async () => {
    const { registry } = fixture();
    const update = await registry.call(ctx(), "app_update_schedule", { scheduleId: "schedule-1", title: "Weekly" }, "assistant");
    expect(body(update)).toContain("Updated Schedule schedule-1");
    const invalid = await registry.call(ctx(), "app_update_schedule", { scheduleId: "schedule-1", cron: "not cron" }, "assistant");
    expect(invalid.isError).toBe(true);
    expect(body(invalid)).toContain("not cron");
    expect(invalid.structuredContent).toBeUndefined();
  });

  it("pauses and resumes schedules through the assistant mapping", async () => {
    const { registry } = fixture();
    const paused = await registry.call(ctx(), "app_pause_schedule", { scheduleId: "schedule-1" }, "assistant");
    expect(body(paused)).toContain("paused");
    expect(body(paused)).toContain("next run none (paused)");
    const resumed = await registry.call(ctx(), "app_resume_schedule", { scheduleId: "schedule-1" }, "assistant");
    expect(body(resumed)).toContain("active");
    expect(body(resumed)).toContain("next run");
  });

  it("runs now, reports pile-up refusal, and deletes through the assistant mapping", async () => {
    const { registry, store } = fixture();
    const started = await registry.call(ctx(), "app_run_schedule_now", { scheduleId: "schedule-1" }, "assistant");
    expect(body(started)).toContain("job-1");
    store.runNow = () => ({ job: null, reason: "A previous job is still running." });
    const refused = await registry.call(ctx(), "app_run_schedule_now", { scheduleId: "schedule-1" }, "assistant");
    expect(refused.isError).toBe(true);
    expect(body(refused)).toContain("previous job is still running");
    expect(refused.structuredContent).toBeUndefined();
    const deleted = await registry.call(ctx(), "app_delete_schedule", { scheduleId: "schedule-1" }, "assistant");
    expect(body(deleted)).toContain("Deleted schedule schedule-1");
  });

  it("refuses an unknown project and unknown schedule as readable tool errors", async () => {
    const { registry } = fixture();
    const project = await registry.call(ctx(), "app_create_schedule", { project: "missing", title: "No", cron: "0 9 * * *", jobTemplate: TEMPLATE }, "assistant");
    expect(project.isError).toBe(true);
    expect(body(project)).toContain("no project matching");
    const id = await registry.call(ctx(), "app_pause_schedule", { scheduleId: "missing" }, "assistant");
    expect(id.isError).toBe(true);
    expect(body(id)).toContain("No schedule has id missing");
  });
});
