// Scheduled jobs, exposed as app tools to the assistant.

import { z } from "zod";

import { ScheduleJobTemplateSchema, type JobRow, type ScheduleJobTemplate, type ScheduleRow, type SchedulePatch } from "../../conversationStoreTypes.js";
import { compact } from "../helpers.js";
import { GatewayToolError, type GatewayRecord } from "../schemas.js";
import type { GatewayToolResult, ToolEntry } from "../registry.js";
import { resolveProject, type ProjectRosterEntry } from "./appProjects.js";

export type { ScheduleJobTemplate, ScheduleRow } from "../../conversationStoreTypes.js";

export interface AppSchedulesStore {
  listSchedules(projectPath?: string): ScheduleRow[];
  getSchedule(scheduleId: string): ScheduleRow | null;
  createSchedule(input: { scheduleId: string; projectPath: string; title: string; cron: string; jobTemplate: ScheduleJobTemplate; at?: number }): ScheduleRow | null;
  updateSchedule(id: string, patch: SchedulePatch, at?: number): ScheduleRow | null;
  pauseSchedule(id: string, at?: number): ScheduleRow | null;
  resumeSchedule(id: string, at?: number): ScheduleRow | null;
  deleteSchedule(id: string): boolean;
  runNow(id: string, at?: number): { job: JobRow | null; reason?: string };
}
export interface AppSchedulesToolOptions {
  store: AppSchedulesStore;
  readProjects?: () => readonly ProjectRosterEntry[] | null;
  now?: () => number;
  createId?: () => string;
  onScheduleChanged?: () => void;
  drainProject?: (projectPath: string) => void;
}

const templateSchema = ScheduleJobTemplateSchema;
const idSchema = z.object({ scheduleId: z.string().min(1) });
const listSchema = z.object({ project: z.string().min(1).optional() });
const createSchema = z.object({ project: z.string().min(1), title: z.string().min(1), cron: z.string().min(1), jobTemplate: templateSchema });
const updateSchema = idSchema.extend({ title: z.string().min(1).optional(), cron: z.string().min(1).optional(), jobTemplate: templateSchema.optional() }).refine((v) => v.title !== undefined || v.cron !== undefined || v.jobTemplate !== undefined, "Supply at least one field to update.");

const idJson = { type: "object", properties: { scheduleId: { type: "string", description: "Schedule id returned by this tool." } }, required: ["scheduleId"] } satisfies GatewayRecord;
const templateJson = {
  type: "object", properties: { title: { type: "string" }, body: { type: "string" }, target: { type: "object", description: "Job execution target: provider and optional model, effort, mode, workspace, and fallbacks." }, attachments: { type: "array", items: { type: "object" } } }, required: ["title", "body", "target"],
} satisfies GatewayRecord;
const jsonFor = (properties: GatewayRecord, required: string[] = []): GatewayRecord => {
  const schema: GatewayRecord = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
};

function scheduleRecord(s: ScheduleRow): GatewayRecord {
  return compact({ scheduleId: s.scheduleId, projectPath: s.projectPath, title: s.title, cron: s.cron,
    jobTemplate: s.jobTemplate, paused: s.paused, nextRunAt: s.nextRunAt,
    nextRunLocal: s.nextRunAt === null ? null : new Date(s.nextRunAt).toLocaleString(),
    nextRunIso: s.nextRunAt === null ? null : new Date(s.nextRunAt).toISOString(),
    lastRunAt: s.lastRunAt, lastJobId: s.lastJobId, createdAt: s.createdAt, updatedAt: s.updatedAt,
  });
}
function scheduleText(s: ScheduleRow): string {
  const next = s.nextRunAt === null ? "none (paused)" : `${new Date(s.nextRunAt).toLocaleString()} (${new Date(s.nextRunAt).toISOString()})`;
  return `Schedule ${s.scheduleId}: **${s.title}** in \`${s.projectPath}\`; cron \`${s.cron}\`; ${s.paused ? "paused" : "active"}; next run ${next}; last job ${s.lastJobId ?? "none"}.`;
}
function result(text: string, value: GatewayRecord): GatewayToolResult { return { content: [{ type: "text", text }], structuredContent: value }; }
function projectPath(options: AppSchedulesToolOptions, name: string): string {
  const projects = options.readProjects?.();
  if (!projects) throw new GatewayToolError("not_found", "kone has not reported its open projects, so the project cannot be checked.");
  return resolveProject(projects, name).path;
}
function existing(options: AppSchedulesToolOptions, id: string): ScheduleRow {
  const row = options.store.getSchedule(id);
  if (!row) throw new GatewayToolError("not_found", `No schedule has id ${id}.`);
  const projects = options.readProjects?.();
  if (!projects || !projects.some((p) => p.path === row.projectPath)) throw new GatewayToolError("not_found", `Schedule ${id} belongs to a project kone no longer knows: ${row.projectPath}.`);
  return row;
}
function safe<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof GatewayToolError) throw error;
    throw new GatewayToolError("invalid_input", error instanceof Error ? error.message : String(error));
  }
}

export function createAppScheduleTools(options: AppSchedulesToolOptions): ToolEntry[] {
  const now = options.now ?? Date.now;
  const id = options.createId ?? (() => crypto.randomUUID());
  const tool = (name: string, description: string, schema: z.ZodTypeAny, jsonSchema: GatewayRecord, handler: (args: GatewayRecord) => GatewayToolResult): ToolEntry => ({
    name, description, inputSchema: schema, jsonSchema, permission: "allow", requiresActiveTurn: true, target: "assistant",
    promptSnippet: description,
    handler: async (_ctx, args) => handler(args),
  });
  return [
    tool("app_list_schedules", "List scheduled jobs, optionally in one project.", listSchema, jsonFor({ project: { type: "string", description: "Project name or absolute path; omit to list all schedules." } }), (a) => {
      const path = a.project ? projectPath(options, String(a.project)) : undefined;
      const schedules = options.store.listSchedules(path);
      return result(schedules.length ? schedules.map(scheduleText).join("\n") : "No scheduled jobs.", { schedules: schedules.map(scheduleRecord) });
    }),
    tool("app_create_schedule", "Create a recurring scheduled job.", createSchema, jsonFor({ project: { type: "string" }, title: { type: "string" }, cron: { type: "string", description: "Standard five-field cron expression in local time." }, jobTemplate: templateJson }, ["project", "title", "cron", "jobTemplate"]), (a) => safe(() => {
      // SAFETY: createSchema has validated this nested job template before the registry calls the handler.
      const jobTemplate = a.jobTemplate as ScheduleJobTemplate;
      const schedule = options.store.createSchedule({ scheduleId: id(), projectPath: projectPath(options, String(a.project)), title: String(a.title), cron: String(a.cron), jobTemplate, at: now() });
      if (!schedule) throw new GatewayToolError("internal", "The schedule could not be created.");
      options.onScheduleChanged?.();
      return result(`Created ${scheduleText(schedule)}`, { schedule: scheduleRecord(schedule) });
    })),
    tool("app_update_schedule", "Update a schedule's title, cron expression, or job template.", updateSchema, jsonFor({ ...idJson.properties, title: { type: "string" }, cron: { type: "string" }, jobTemplate: templateJson }, ["scheduleId"]), (a) => safe(() => {
      existing(options, String(a.scheduleId));
      const patch: SchedulePatch = {};
      if (a.title !== undefined) patch.title = String(a.title);
      if (a.cron !== undefined) patch.cron = String(a.cron);
      if (a.jobTemplate !== undefined) {
        // SAFETY: updateSchema validates a supplied template before dispatch.
        patch.jobTemplate = a.jobTemplate as ScheduleJobTemplate;
      }
      const schedule = options.store.updateSchedule(String(a.scheduleId), patch, now());
      if (!schedule) throw new GatewayToolError("not_found", `No schedule has id ${String(a.scheduleId)}.`);
      options.onScheduleChanged?.();
      return result(`Updated ${scheduleText(schedule)}`, { schedule: scheduleRecord(schedule) });
    })),
    ...(["pause", "resume"] as const).map((action) => tool(`app_${action}_schedule`, `${action === "pause" ? "Pause" : "Resume"} a schedule.`, idSchema, idJson, (a) => safe(() => {
      existing(options, String(a.scheduleId));
      const schedule = options.store[`${action}Schedule`](String(a.scheduleId), now());
      if (!schedule) throw new GatewayToolError("not_found", `No schedule has id ${String(a.scheduleId)}.`);
      options.onScheduleChanged?.();
      return result(`${action === "pause" ? "Paused" : "Resumed"} ${scheduleText(schedule)}`, { schedule: scheduleRecord(schedule) });
    }))),
    tool("app_run_schedule_now", "Run a scheduled job immediately without changing its next scheduled time.", idSchema, idJson, (a) => safe(() => {
      const schedule = existing(options, String(a.scheduleId));
      const run = options.store.runNow(schedule.scheduleId, now());
      if (!run.job) throw new GatewayToolError("invalid_input", run.reason ?? "The scheduled job could not be started.");
      options.drainProject?.(run.job.projectPath);
      const updated = options.store.getSchedule(schedule.scheduleId) ?? schedule;
      return result(`Started job ${run.job.jobId} from ${scheduleText(updated)}`, { jobId: run.job.jobId, schedule: scheduleRecord(updated) });
    })),
    tool("app_delete_schedule", "Delete a scheduled job.", idSchema, idJson, (a) => safe(() => {
      existing(options, String(a.scheduleId));
      if (!options.store.deleteSchedule(String(a.scheduleId))) throw new GatewayToolError("not_found", `No schedule has id ${String(a.scheduleId)}.`);
      options.onScheduleChanged?.();
      return result(`Deleted schedule ${String(a.scheduleId)}.`, { scheduleId: String(a.scheduleId), deleted: true });
    })),
  ];
}
