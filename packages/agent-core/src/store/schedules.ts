import { randomUUID } from "node:crypto";
import { nextOccurrence, parseCron } from "../cronSchedule.js";
import type { ConversationDb } from "./ConversationDb.js";
import { JOB_SORT_UNSET, rowToJob, ScheduleJobTemplateSchema, type JobDbRow, type JobRow, type ScheduleCreateInput, type ScheduleFireResult, type ScheduleJobTemplate, type SchedulePatch, type ScheduleRow } from "../conversationStoreTypes.js";

type ScheduleDbRow = { schedule_id: string; project_path: string; title: string; cron: string; job_template_json: string; paused: number; next_run_at: number | null; last_run_at: number | null; last_job_id: string | null; created_at: number; updated_at: number };
const SCHEDULE_COLUMNS = "schedule_id, project_path, title, cron, job_template_json, paused, next_run_at, last_run_at, last_job_id, created_at, updated_at";
const JOB_COLUMNS = "job_id, project_path, title, body, status, sort_key, provider, model, effort, mode, workspace_json, fallbacks_json, attachments_json, created_at, updated_at, started_at, ended_at, schedule_id";

function toSchedule(row: ScheduleDbRow): ScheduleRow {
  // SAFETY: JSON.parse yields stored data; new writes are schema-validated and
  // the assertion preserves visibility for legacy rows created before validation.
  const template = JSON.parse(row.job_template_json) as ScheduleJobTemplate;
  return { scheduleId: row.schedule_id, projectPath: row.project_path, title: row.title, cron: row.cron, jobTemplate: template, paused: row.paused === 1, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at, lastJobId: row.last_job_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

export class ScheduleRepo {
  constructor(
    private readonly dbh: ConversationDb,
    private readonly hooks: { beforeFireTransaction?: (scheduleId: string) => void } = {},
  ) {}

  createSchedule(input: ScheduleCreateInput): ScheduleRow | null {
    const db = this.dbh.handle(); if (!db) return null;
    const jobTemplate = ScheduleJobTemplateSchema.parse(input.jobTemplate);
    const at = input.at ?? Date.now();
    const next = nextOccurrence(input.cron, new Date(at)).getTime();
    db.prepare(`INSERT INTO schedules (${SCHEDULE_COLUMNS}) VALUES (?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?)`)
      .run(input.scheduleId, input.projectPath, input.title, input.cron, JSON.stringify(jobTemplate), next, at, at);
    return this.getSchedule(input.scheduleId);
  }

  getSchedule(id: string): ScheduleRow | null {
    const db = this.dbh.handle(); if (!db) return null;
    // SAFETY: this projection names every column in ScheduleDbRow and returns no row for an unknown id.
    const row = db.prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE schedule_id = ?`).get(id) as ScheduleDbRow | undefined;
    return row ? toSchedule(row) : null;
  }

  listSchedules(projectPath?: string): ScheduleRow[] {
    const db = this.dbh.handle(); if (!db) return [];
    const rows = projectPath === undefined
      ? db.prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules ORDER BY project_path, created_at`).all()
      : db.prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE project_path = ? ORDER BY created_at`).all(projectPath);
    // SAFETY: both SELECT branches use SCHEDULE_COLUMNS, matching ScheduleDbRow.
    return (rows as ScheduleDbRow[]).map(toSchedule);
  }

  updateSchedule(id: string, patch: SchedulePatch, at = Date.now()): ScheduleRow | null {
    const current = this.getSchedule(id); const db = this.dbh.handle();
    if (!current || !db) return null;
    const cron = patch.cron ?? current.cron;
    const jobTemplate = ScheduleJobTemplateSchema.parse(patch.jobTemplate ?? current.jobTemplate);
    parseCron(cron);
    const next = patch.cron !== undefined && !current.paused ? nextOccurrence(cron, new Date(at)).getTime() : current.nextRunAt;
    db.prepare(`UPDATE schedules SET title=?, cron=?, job_template_json=?, next_run_at=?, updated_at=? WHERE schedule_id=?`)
      .run(patch.title ?? current.title, cron, JSON.stringify(jobTemplate), next, at, id);
    return this.getSchedule(id);
  }

  pauseSchedule(id: string, at = Date.now()): ScheduleRow | null {
    const db = this.dbh.handle(); if (!db) return null;
    db.prepare("UPDATE schedules SET paused=1, next_run_at=NULL, updated_at=? WHERE schedule_id=?").run(at, id);
    return this.getSchedule(id);
  }

  resumeSchedule(id: string, at = Date.now()): ScheduleRow | null {
    const db = this.dbh.handle(); if (!db) return null;
    const row = this.getSchedule(id); if (!row) return null;
    const next = nextOccurrence(row.cron, new Date(at)).getTime();
    db.prepare("UPDATE schedules SET paused=0, next_run_at=?, updated_at=? WHERE schedule_id=?").run(next, at, id);
    return this.getSchedule(id);
  }

  deleteSchedule(id: string): boolean {
    const db = this.dbh.handle(); if (!db) return false;
    return db.prepare("DELETE FROM schedules WHERE schedule_id=?").run(id).changes > 0;
  }

  runNow(id: string, at = Date.now()): { job: JobRow | null; reason?: string } {
    const db = this.dbh.handle(); const schedule = this.getSchedule(id);
    if (!db || !schedule) return { job: null, reason: "unknown schedule" };
    let job: JobRow | null = null;
    this.dbh.durably(db, () => this.immediateTransaction(db, () => {
      const current = this.getSchedule(id);
      if (current && !this.hasActiveJob(current.scheduleId)) job = this.insertScheduledJob(current, at);
    }));
    return job ? { job } : { job: null, reason: "the previous scheduled job is still queued or running" };
  }

  fireDue(now: number, graceMs = 10 * 60_000, deferredScheduleIds: readonly string[] = []): ScheduleFireResult {
    const db = this.dbh.handle(); const result: ScheduleFireResult = { fired: [], skipped: [], failures: [] };
    if (!db) return result;
    // SAFETY: the due query selects SCHEDULE_COLUMNS from schedules.
    const due = db.prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE paused=0 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at`).all(now) as ScheduleDbRow[];
    const deferred = new Set(deferredScheduleIds);
    for (const candidate of due) {
      if (deferred.has(candidate.schedule_id)) continue;
      let fired: { schedule: ScheduleRow; job: JobRow } | undefined;
      let skipped: ScheduleFireResult["skipped"][number] | undefined;
      try {
        this.hooks.beforeFireTransaction?.(candidate.schedule_id);
        this.dbh.durably(db, () => this.immediateTransaction(db, () => {
          const current = this.readScheduleRow(candidate.schedule_id);
          const old = current?.next_run_at ?? null;
          if (!current || old === null || old !== candidate.next_run_at || old > now || current.paused === 1) return;
          const advanced = nextOccurrence(current.cron, new Date(now)).getTime();
          const cas = db.prepare("UPDATE schedules SET next_run_at=?, updated_at=? WHERE schedule_id=? AND next_run_at=? AND paused=0").run(advanced, now, current.schedule_id, old);
          if (cas.changes !== 1) return;
          const schedule = toSchedule(current);
          if (now - old > graceMs) { skipped = { scheduleId: candidate.schedule_id, reason: "outside-grace" }; return; }
          if (this.hasActiveJob(schedule.scheduleId)) { skipped = { scheduleId: candidate.schedule_id, reason: "job-active" }; return; }
          const job = this.insertScheduledJob(schedule, now);
          if (!job) throw new Error("Could not create scheduled job");
          fired = { schedule: this.getSchedule(candidate.schedule_id) ?? schedule, job };
        }));
      } catch (error) {
        result.failures.push({
          scheduleId: candidate.schedule_id,
          occurrenceAt: candidate.next_run_at ?? now,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (fired) result.fired.push(fired);
      if (skipped) result.skipped.push(skipped);
    }
    return result;
  }

  private hasActiveJob(scheduleId: string): boolean {
    const db = this.dbh.handle(); if (!db) return false;
    return Boolean(db.prepare("SELECT 1 FROM jobs WHERE schedule_id=? AND status IN ('queued', 'running') LIMIT 1").get(scheduleId));
  }

  private readScheduleRow(id: string): ScheduleDbRow | null {
    const db = this.dbh.handle(); if (!db) return null;
    // SAFETY: this projection names every column in ScheduleDbRow and returns no row for an unknown id.
    return (db.prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE schedule_id=?`).get(id) as ScheduleDbRow | undefined) ?? null;
  }

  private immediateTransaction(db: NonNullable<ReturnType<ConversationDb["handle"]>>, write: () => void): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      write();
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  private insertScheduledJob(schedule: ScheduleRow, at: number): JobRow | null {
    const db = this.dbh.handle(); if (!db) return null;
    const template = schedule.jobTemplate; const target = template.target;
    const jobId = randomUUID();
    db.prepare(`INSERT INTO jobs (job_id, project_path, title, body, status, sort_key, provider, model, effort, mode, workspace_json, fallbacks_json, attachments_json, created_at, updated_at, schedule_id)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(jobId, schedule.projectPath, template.title, template.body, JOB_SORT_UNSET, target.provider, target.model ?? null, target.effort ?? null, target.mode ?? null,
        target.workspace ? JSON.stringify(target.workspace) : null, target.fallbacks?.length ? JSON.stringify(target.fallbacks) : null,
        template.attachments?.length ? JSON.stringify(template.attachments) : null, at, at, schedule.scheduleId);
    db.prepare("UPDATE schedules SET last_run_at=?, last_job_id=?, updated_at=? WHERE schedule_id=?").run(at, jobId, at, schedule.scheduleId);
    // SAFETY: the inserted job exists and the query selects every JobDbRow column.
    const row = db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE job_id=?`).get(jobId) as JobDbRow;
    return rowToJob(row);
  }
}
