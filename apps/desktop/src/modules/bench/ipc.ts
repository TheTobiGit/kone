import { ipcMain } from "electron";

import { getConversationStore } from "@kone/agent-core/ConversationStore.js";
import type { JobCreateInput, JobRow } from "@kone/agent-core/conversationStoreTypes.js";
import { z } from "zod";
import { ProviderKindSchema } from "@kone/agent-core/types.js";

import { getJobRunner, getScheduleRunner } from "../../agent/agent-ipc.js";

import type {
  BenchCreateInput,
  BenchJobDetail,
  BenchJobIdInput,
  BenchListInput,
  BenchQueueInput,
  BenchReorderInput,
  BenchUpdateInput,
  ScheduleCreateInput,
  ScheduleIdInput,
  ScheduleListInput,
  ScheduleRow,
  ScheduleRunNowResult,
  ScheduleUpdateInput,
} from "./types.js";

const scheduleIdInputSchema = z.object({ scheduleId: z.string().min(1) });
const scheduleListInputSchema = z.object({ projectPath: z.string().min(1).optional() });
const scheduleJobTemplateSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
  target: z.object({ provider: ProviderKindSchema }).passthrough(),
  attachments: z.array(z.object({
    type: z.enum(["image", "file"]),
    id: z.string(),
    name: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
  })).optional(),
}).passthrough();
const scheduleCreateInputSchema = z.object({
  scheduleId: z.string().min(1),
  projectPath: z.string().min(1),
  title: z.string().min(1),
  cron: z.string().min(1),
  jobTemplate: scheduleJobTemplateSchema,
});
const scheduleUpdateInputSchema = z.object({
  scheduleId: z.string().min(1),
  patch: z.object({
    title: z.string().min(1).optional(),
    cron: z.string().min(1).optional(),
    jobTemplate: scheduleJobTemplateSchema.optional(),
  }).refine((patch) => Object.keys(patch).length > 0, "At least one schedule field is required"),
});

function parseInput<T>(schema: z.ZodType<T>, input: T): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid schedules input: ${parsed.error.message}`);
  return parsed.data;
}

let registered = false;

/** Register the bench:* IPC handlers. Call once, before creating the window. */
export function registerBenchIpc(): void {
  if (registered) return;
  registered = true;

  const store = getConversationStore();

  /** Nudge the project's queue after a write that may have given it something
   *  to take. Without this a job filed while the app is running would sit
   *  until the next settle or restart — the runner is event-driven and a new
   *  arrival is one of the events. Best-effort and not awaited: the write has
   *  already landed, and a drain that fails leaves the job queued for the next
   *  one rather than failing the call the user made.
   *
   *  Safe to call when nothing is takeable: a project already running claims
   *  nothing, and a draft is not claimed at all. */
  function nudge(job: JobRow | null): JobRow | null {
    if (job?.status === "queued") void getJobRunner()?.drainProject(job.projectPath);
    return job;
  }

  ipcMain.handle("bench:list", (_event, input: BenchListInput): JobRow[] =>
    input.projectPath === undefined ? store.listAllJobs() : store.listJobs(input.projectPath),
  );

  ipcMain.handle("bench:detail", (_event, input: BenchJobIdInput): BenchJobDetail | null => {
    const job = store.getJob(input.jobId);
    if (!job) return null;
    return { job, runs: store.listJobRuns(input.jobId) };
  });

  ipcMain.handle("bench:create", (_event, input: BenchCreateInput): JobRow | null => {
    const create: JobCreateInput = {
      jobId: input.jobId,
      projectPath: input.projectPath,
      title: input.title,
      body: input.body,
      status: input.status,
      target: input.target,
    };

    if (input.attachments?.length) create.attachments = input.attachments;

    return nudge(store.createJob(create));
  });

  ipcMain.handle("bench:update", (_event, input: BenchUpdateInput): JobRow | null =>
    store.updateJob(input.jobId, input.patch),
  );

  ipcMain.handle("bench:set-queued", (_event, input: BenchQueueInput): JobRow | null =>
    nudge(store.setJobQueued(input.jobId, input.queued)),
  );

  ipcMain.handle("bench:requeue", (_event, input: BenchJobIdInput): JobRow | null =>
    nudge(store.requeueJob(input.jobId)),
  );

  ipcMain.handle("bench:reorder", (_event, input: BenchReorderInput): boolean =>
    store.reorderJobs(input.projectPath, input.jobIds),
  );

  ipcMain.handle("bench:delete", (_event, input: BenchJobIdInput): boolean =>
    store.deleteJob(input.jobId),
  );

  ipcMain.handle("schedules:list", (_event, rawInput: ScheduleListInput): ScheduleRow[] => {
    const input = parseInput(scheduleListInputSchema, rawInput);
    return store.listSchedules(input.projectPath);
  });

  ipcMain.handle("schedules:get", (_event, rawInput: ScheduleIdInput): ScheduleRow | null => {
    const input = parseInput(scheduleIdInputSchema, rawInput);
    return store.getSchedule(input.scheduleId);
  });

  ipcMain.handle("schedules:create", (_event, rawInput: ScheduleCreateInput): ScheduleRow | null => {
    const input = parseInput(scheduleCreateInputSchema, rawInput);
    const schedule = store.createSchedule(input);
    getScheduleRunner()?.rearm();
    return schedule;
  });

  ipcMain.handle("schedules:update", (_event, rawInput: ScheduleUpdateInput): ScheduleRow | null => {
    const input = parseInput(scheduleUpdateInputSchema, rawInput);
    const schedule = store.updateSchedule(input.scheduleId, input.patch);
    getScheduleRunner()?.rearm();
    return schedule;
  });

  ipcMain.handle("schedules:pause", (_event, rawInput: ScheduleIdInput): ScheduleRow | null => {
    const input = parseInput(scheduleIdInputSchema, rawInput);
    const schedule = store.pauseSchedule(input.scheduleId);
    getScheduleRunner()?.rearm();
    return schedule;
  });

  ipcMain.handle("schedules:resume", (_event, rawInput: ScheduleIdInput): ScheduleRow | null => {
    const input = parseInput(scheduleIdInputSchema, rawInput);
    const schedule = store.resumeSchedule(input.scheduleId);
    getScheduleRunner()?.rearm();
    return schedule;
  });

  ipcMain.handle("schedules:run-now", (_event, rawInput: ScheduleIdInput): ScheduleRunNowResult => {
    const input = parseInput(scheduleIdInputSchema, rawInput);
    const result = store.runNow(input.scheduleId);
    if (result.job?.status === "queued") void getJobRunner()?.drainProject(result.job.projectPath);
    getScheduleRunner()?.rearm();
    return result;
  });

  ipcMain.handle("schedules:delete", (_event, rawInput: ScheduleIdInput): boolean => {
    const input = parseInput(scheduleIdInputSchema, rawInput);
    const deleted = store.deleteSchedule(input.scheduleId);
    getScheduleRunner()?.rearm();
    return deleted;
  });
}
