import { randomUUID } from "node:crypto";

import { withTransaction } from "../conversationMigrations.js";
import type { ConversationDb } from "./ConversationDb.js";
import {
  JOB_SORT_UNSET,
  rowToJob,
  rowToJobRun,
  type JobCreateInput,
  type JobDbRow,
  type JobPatch,
  type JobRow,
  type JobRunDbRow,
  type JobRunRow,
  type JobTarget,
} from "../conversationStoreTypes.js";

/** How long a claim holds before the sweep may take it back. Long enough that
 *  a slow provider start (a cold CLI, a worktree being cut) is not mistaken
 *  for a dead process, short enough that a crash does not strand a queue for
 *  the rest of the session. The runner renews nothing: a claim's whole job is
 *  to cover the gap between taking the row and the thread existing, and
 *  `bindRunThread` ends it. */
export const JOB_CLAIM_LEASE_MS = 2 * 60_000;

const JOB_COLUMNS = `job_id, project_path, title, body, status, sort_key,
                      provider, model, effort, mode, workspace_json,
                      fallbacks_json, attachments_json, created_at, updated_at,
                      started_at, ended_at`;

/** Where the job's latest attempt actually ran, read off the thread that
 *  attempt opened. The jobs table holds what was ASKED for — and a job in the
 *  project's own checkout asks for nothing — so the branch the work landed on
 *  is only knowable through the run. Latest attempt rather than first: a retry
 *  on another branch makes the earlier answer history. */
const RAN_ON_BRANCH = `(SELECT t.branch
                          FROM job_runs r
                          JOIN threads t ON t.thread_id = r.thread_id
                         WHERE r.job_id = jobs.job_id
                           AND t.branch IS NOT NULL
                         ORDER BY r.attempt DESC
                         LIMIT 1) AS ran_on_branch`;

const RUN_COLUMNS = `run_id, job_id, attempt, thread_id, status, claimed_by,
                     claimed_at, lease_expires_at, started_at, ended_at, error,
                     created_at`;

/** Drain order, shared by the claim and the lists so the queue the user sees is
 *  the queue that runs. Rows given an explicit position by a reorder come first
 *  in that order; unordered rows fall in behind them oldest-first, with rowid
 *  settling same-millisecond arrivals. Matches `idx_jobs_drain` column for
 *  column. */
// Plain column order: migration 0010 replaced the NULL that meant "unordered"
// with JOB_SORT_UNSET, which sorts last on its own, so no CASE is needed and
// `idx_jobs_drain` matches this term for term.
const JOB_DRAIN_ORDER = `sort_key ASC,
                          created_at ASC,
                          rowid ASC`;

/** List order: what the bench shows. The drain order decides among queued rows
 *  — so the top queued row is the next one to run — and everything settled
 *  falls below it newest-first, which is reading order rather than queue order.
 *  Built from JOB_DRAIN_ORDER rather than restating it: the two disagreeing is
 *  exactly the bug where the queue the user sees is not the queue that runs. */
const JOB_LIST_ORDER = `CASE status WHEN 'queued' THEN 0 ELSE 1 END ASC,
                         CASE WHEN status = 'queued' THEN sort_key END ASC,
                         CASE WHEN status = 'queued' THEN created_at END ASC,
                         created_at DESC,
                         rowid DESC`;

/** The two JSON columns a target writes, ready to bind. */
type TargetColumns = { workspace: string | null; fallbacks: string | null };

/** Serialize the parts of a target that ride as JSON. Written as null rather
 *  than "{}" when there is nothing to say, so a reader can tell "no worktree
 *  asked for" from "a worktree record that decoded to nothing". */
function targetJson(target: JobTarget): TargetColumns {
  return {
    workspace: target.workspace ? JSON.stringify(target.workspace) : null,
    fallbacks: target.fallbacks?.length ? JSON.stringify(target.fallbacks) : null,
  };
}

/** One attempt and the job it belongs to, as the claim hands them back
 *  together — the runner needs both and re-reading the job would race the
 *  next writer. */
export type ClaimedJob = { job: JobRow; run: JobRunRow };

/** How a run ended, as the runner reports it. */
export type JobRunOutcome =
  | { status: "done" }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

export class JobRepo {
  constructor(private readonly dbh: ConversationDb) {}

  // ── jobs ─────────────────────────────────────────────────────────────────

  /** File a job. `status` decides whether it queues immediately or parks as a
   *  draft; nothing else about the row differs between the two, which is why
   *  the composer's two buttons are one call. */
  createJob(input: JobCreateInput): JobRow | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const now = input.at ?? Date.now();
    const json = targetJson(input.target);
    try {
      this.dbh.durably(db, () => {
        db.prepare(
          `INSERT INTO jobs (job_id, project_path, title, body, status, sort_key,
                              provider, model, effort, mode, workspace_json,
                              fallbacks_json, attachments_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.jobId,
          input.projectPath,
          input.title,
          input.body,
          input.status,
          JOB_SORT_UNSET,
          input.target.provider,
          input.target.model ?? null,
          input.target.effort ?? null,
          input.target.mode ?? null,
          json.workspace,
          json.fallbacks,
          // Written as null rather than "[]" when nothing was attached, so a
          // reader can tell "no files" from "a list that decoded to nothing".
          input.attachments?.length ? JSON.stringify(input.attachments) : null,
          now,
          now,
        );
      });
    } catch (err) {
      console.error("[conversation-store] createJob failed:", err);
      return null;
    }
    return this.getJob(input.jobId);
  }

  getJob(jobId: string): JobRow | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection is the column list JobDbRow is declared from,
      // keyed on the primary key, so at most one row of exactly that shape.
      const row = db
        .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE job_id = ?`)
        .get(jobId) as JobDbRow | undefined;
      return row ? rowToJob(row) : null;
    } catch (err) {
      console.error("[conversation-store] getJob failed:", err);
      return null;
    }
  }

  /** Every job in a project, in the order the list shows them. The two groups
   *  sort in opposite directions on purpose: queued rows run oldest-first, so
   *  showing them newest-first would put the next thing to run at the bottom,
   *  while a settled row is history and the most recent is the one worth
   *  seeing. Everything else the bench groups by status, so within-group order
   *  is all this has to get right. */
  listJobs(projectPath: string): JobRow[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection is the column list JobDbRow is declared from.
      const rows = db
        .prepare(
          `SELECT ${JOB_COLUMNS}, ${RAN_ON_BRANCH} FROM jobs
            WHERE project_path = ?
            ORDER BY ${JOB_LIST_ORDER}`,
        )
        .all(projectPath) as JobDbRow[];
      return rows.map(rowToJob);
    } catch (err) {
      console.error("[conversation-store] listJobs failed:", err);
      return [];
    }
  }

  /** Every job the store holds, across every project, in the same order one
   *  project's list uses. The bench is one list for all of them: a job is
   *  queued against a checkout, but the person watching the queue has one
   *  attention, and a per-project bench hides the fact that four projects are
   *  each running something.
   *
   *  Queued rows stay oldest-first, which keeps each project's rows in the
   *  order its runner will take them even though the list is interleaved —
   *  every project drains its own queue, so the top queued row of a project is
   *  the next one to run for that project wherever it happens to sit here. */
  listAllJobs(): JobRow[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection is the column list JobDbRow is declared from.
      const rows = db
        .prepare(
          `SELECT ${JOB_COLUMNS}, ${RAN_ON_BRANCH} FROM jobs
            ORDER BY ${JOB_LIST_ORDER}`,
        )
        .all() as JobDbRow[];

      return rows.map(rowToJob);
    } catch (err) {
      console.error("[conversation-store] listAllJobs failed:", err);
      return [];
    }
  }

  /** Edit a filed job. Refused once the job has left the states a user may
   *  still edit from: a running job's parameters were already handed to a
   *  provider, and rewriting the row would make the list disagree with what is
   *  actually executing. */
  updateJob(jobId: string, patch: JobPatch, at?: number): JobRow | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const current = this.getJob(jobId);
    if (!current) return null;
    if (current.status !== "draft" && current.status !== "queued") return null;

    const target = patch.target ?? current.target;
    const json = targetJson(target);
    const sortKey =
      patch.sortKey === undefined
        ? current.sortKey ?? JOB_SORT_UNSET
        : patch.sortKey ?? JOB_SORT_UNSET;
    try {
      this.dbh.durably(db, () => {
        db.prepare(
          `UPDATE jobs
              SET title = ?, body = ?, sort_key = ?, provider = ?, model = ?,
                  effort = ?, mode = ?, workspace_json = ?, fallbacks_json = ?,
                  updated_at = ?
            WHERE job_id = ?`,
        ).run(
          patch.title ?? current.title,
          patch.body ?? current.body,
          sortKey,
          target.provider,
          target.model ?? null,
          target.effort ?? null,
          target.mode ?? null,
          json.workspace,
          json.fallbacks,
          at ?? Date.now(),
          jobId,
        );
      });
    } catch (err) {
      console.error("[conversation-store] updateJob failed:", err);
      return null;
    }
    return this.getJob(jobId);
  }

  /** Move a job between the two states the user drives directly. Returns the
   *  job, or null when the move is not one of those — promoting a running
   *  job or re-queueing through here would skip the run bookkeeping that
   *  `claimNextJob` and `settleRun` own. */
  setJobQueued(jobId: string, queued: boolean, at?: number): JobRow | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const current = this.getJob(jobId);
    if (!current) return null;
    const from = queued ? "draft" : "queued";
    const to = queued ? "queued" : "draft";
    if (current.status !== from) return null;
    try {
      this.dbh.durably(db, () => {
        db.prepare(`UPDATE jobs SET status = ?, updated_at = ? WHERE job_id = ?`).run(
          to,
          at ?? Date.now(),
          jobId,
        );
      });
    } catch (err) {
      console.error("[conversation-store] setJobQueued failed:", err);
      return null;
    }
    return this.getJob(jobId);
  }

  /** Re-queue a settled job. This is the retry path, and it deliberately does
   *  not touch the existing runs: the next claim opens attempt N+1 beside
   *  them, so a job that failed twice and then worked can still show all
   *  three. */
  requeueJob(jobId: string, at?: number): JobRow | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const current = this.getJob(jobId);
    if (!current) return null;
    if (current.status !== "done" && current.status !== "failed" && current.status !== "cancelled") {
      return null;
    }
    try {
      this.dbh.durably(db, () => {
        db.prepare(
          `UPDATE jobs SET status = 'queued', started_at = NULL, ended_at = NULL,
                            updated_at = ?
            WHERE job_id = ?`,
        ).run(at ?? Date.now(), jobId);
      });
    } catch (err) {
      console.error("[conversation-store] requeueJob failed:", err);
      return null;
    }
    return this.getJob(jobId);
  }

  /** Set the explicit queue positions for a project, in the order given. Rows
   *  not named keep JOB_SORT_UNSET and stay behind the sequence. Written in one
   *  transaction so a half-applied reorder can never be observed as the
   *  running order. */
  reorderJobs(projectPath: string, jobIds: readonly string[], at?: number): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    const now = at ?? Date.now();
    try {
      this.dbh.durably(db, () => {
        const stmt = db.prepare(
          `UPDATE jobs SET sort_key = ?, updated_at = ? WHERE job_id = ? AND project_path = ?`,
        );
        jobIds.forEach((jobId, index) => {
          stmt.run(index, now, jobId, projectPath);
        });
      });
      return true;
    } catch (err) {
      console.error("[conversation-store] reorderJobs failed:", err);
      return false;
    }
  }

  /** Remove a job and its attempts. Refused while the job is running.
   *
   *  `updateJob` and `setJobQueued` both refuse a running job; this did not,
   *  and it is the one that cannot be walked back — the delete cascades the
   *  job's runs away while the provider it started keeps going, leaving a live
   *  thread nothing in the store points at. Cancelling a running job is a
   *  different operation and does not exist yet; until it does, the honest
   *  answer to "delete this running job" is no. */
  deleteJob(jobId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    if (this.getJob(jobId)?.status === "running") return false;
    try {
      let deleted = false;
      this.dbh.durably(db, () => {
        const result = db.prepare(`DELETE FROM jobs WHERE job_id = ?`).run(jobId);
        deleted = Number(result.changes) > 0;
      });
      return deleted;
    } catch (err) {
      console.error("[conversation-store] deleteJob failed:", err);
      return false;
    }
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  /** Take the next queued job in a project and open an attempt against it.
   *
   *  Serial by design: a project with a job already running claims nothing.
   *  One job at a time is what the queue means here — several agents in one
   *  checkout would race on the same files, and the worktree choice is per
   *  job, not a guarantee of isolation from a sibling.
   *
   *  The pick and the status change are one statement inside one transaction,
   *  so two runners (a second window, a drain racing a boot sweep) cannot both
   *  take the same row. Returns null when there is nothing to take. */
  claimNextJob(input: {
    projectPath: string;
    claimedBy: string;
    at?: number;
    leaseMs?: number;
    runId?: string;
  }): ClaimedJob | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const now = input.at ?? Date.now();
    const runId = input.runId ?? randomUUID();
    let claimedJobId: string | null = null;
    try {
      withTransaction(db, () => {
        // One statement finds the row and takes it. Reading "is the project
        // busy" and "which row is next" as separate SELECTs before writing is
        // what let two callers agree on the same job_id: both saw an idle
        // project, both saw the same head of the queue, and both wrote. Here
        // the busy test and the pick are subqueries of the UPDATE that moves
        // the row, so whichever caller commits second matches no queued row
        // and takes nothing.
        //
        // `durably` cannot wrap this: it raises PRAGMA synchronous, which
        // SQLite refuses inside a transaction. A torn claim costs more than an
        // unfsynced one — a claim that survives the crash but points at no
        // thread is exactly what the boot sweep is there to release.
        // SAFETY: single returned column, so the row shape is fixed by the SQL.
        const claimed = db
          .prepare(
            `UPDATE jobs
                SET status = 'running',
                    started_at = COALESCE(started_at, ?),
                    updated_at = ?
              WHERE job_id = (
                SELECT j.job_id FROM jobs j
                 WHERE j.project_path = ?
                   AND j.status = 'queued'
                   AND NOT EXISTS (
                     SELECT 1 FROM jobs busy
                      WHERE busy.project_path = j.project_path
                        AND busy.status = 'running'
                   )
                 ORDER BY ${JOB_DRAIN_ORDER}
                 LIMIT 1
              )
             RETURNING job_id`,
          )
          .get(now, now, input.projectPath) as { job_id: string } | undefined;
        if (!claimed) return;

        // The attempt number is counted in the same statement that writes it,
        // so a retry racing this one cannot read the same MAX and collide on
        // UNIQUE (job_id, attempt).
        db.prepare(
          `INSERT INTO job_runs (run_id, job_id, attempt, status, claimed_by,
                                  claimed_at, lease_expires_at, created_at)
           VALUES (?, ?,
                   (SELECT COALESCE(MAX(attempt), 0) + 1 FROM job_runs WHERE job_id = ?),
                   'claimed', ?, ?, ?, ?)`,
        ).run(
          runId,
          claimed.job_id,
          claimed.job_id,
          input.claimedBy,
          now,
          now + (input.leaseMs ?? JOB_CLAIM_LEASE_MS),
          now,
        );
        claimedJobId = claimed.job_id;
      });
    } catch (err) {
      console.error("[conversation-store] claimNextJob failed:", err);
      return null;
    }
    if (claimedJobId === null) return null;
    const job = this.getJob(claimedJobId);
    const run = this.getJobRun(runId);
    return job && run ? { job, run } : null;
  }

  /** Attach the thread the run is executing in, ending the claim window. The
   *  lease is cleared here rather than renewed: from this point the thread's
   *  own lifecycle is the evidence the run is alive, and a sweep that still
   *  saw a lease would be second-guessing it. */
  bindRunThread(runId: string, threadId: string, at?: number): JobRunRow | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      let bound = false;
      this.dbh.durably(db, () => {
        const result = db
          .prepare(
            `UPDATE job_runs
                SET thread_id = ?, status = 'running', started_at = ?,
                    lease_expires_at = NULL
              WHERE run_id = ? AND status = 'claimed'`,
          )
          .run(threadId, at ?? Date.now(), runId);
        bound = Number(result.changes) > 0;
      });
      return bound ? this.getJobRun(runId) : null;
    } catch (err) {
      console.error("[conversation-store] bindRunThread failed:", err);
      return null;
    }
  }

  /** Hand a claimed run back without consuming an attempt's worth of state —
   *  the dispatch failed before anything ran (no provider available, the
   *  worktree could not be cut). The job returns to the queue for the next
   *  drain rather than being marked failed, because nothing was tried. */
  releaseClaim(runId: string, error: string, at?: number): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    const now = at ?? Date.now();
    try {
      let released = false;
      this.dbh.durably(db, () => {
        const result = db
          .prepare(
            `UPDATE job_runs
                SET status = 'failed', error = ?, ended_at = ?, lease_expires_at = NULL
              WHERE run_id = ? AND status = 'claimed'`,
          )
          .run(error, now, runId);
        if (Number(result.changes) === 0) return;
        db.prepare(
          `UPDATE jobs
              SET status = 'queued', started_at = NULL, updated_at = ?
            WHERE job_id = (SELECT job_id FROM job_runs WHERE run_id = ?)
              AND status = 'running'`,
        ).run(now, runId);
        released = true;
      });
      return released;
    } catch (err) {
      console.error("[conversation-store] releaseClaim failed:", err);
      return false;
    }
  }

  /** Settle a run and its job together. One transaction because the two
   *  states are one fact: a job left 'running' over a settled run is exactly
   *  the shape that makes a queue stop draining with nothing visibly wrong. */
  settleRun(runId: string, outcome: JobRunOutcome, at?: number): JobRunRow | null {
    const db = this.dbh.handle();
    if (!db) return null;
    const now = at ?? Date.now();
    const error = outcome.status === "failed" ? outcome.error : null;
    try {
      let settled = false;
      this.dbh.durably(db, () => {
        const result = db
          .prepare(
            `UPDATE job_runs
                SET status = ?, error = ?, ended_at = ?, lease_expires_at = NULL
              WHERE run_id = ? AND status IN ('claimed', 'running')`,
          )
          .run(outcome.status, error, now, runId);
        if (Number(result.changes) === 0) return;
        db.prepare(
          `UPDATE jobs
              SET status = ?, ended_at = ?, updated_at = ?
            WHERE job_id = (SELECT job_id FROM job_runs WHERE run_id = ?)
              AND status = 'running'`,
        ).run(outcome.status, now, now, runId);
        settled = true;
      });
      return settled ? this.getJobRun(runId) : null;
    } catch (err) {
      console.error("[conversation-store] settleRun failed:", err);
      return null;
    }
  }

  getJobRun(runId: string): JobRunRow | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection is the column list JobRunDbRow is declared
      // from, keyed on the primary key.
      const row = db
        .prepare(`SELECT ${RUN_COLUMNS} FROM job_runs WHERE run_id = ?`)
        .get(runId) as JobRunDbRow | undefined;
      return row ? rowToJobRun(row) : null;
    } catch (err) {
      console.error("[conversation-store] getJobRun failed:", err);
      return null;
    }
  }

  /** Every attempt at a job, newest first — the order the bench's detail panel reads
   *  them, where the current attempt is the one that matters and the earlier
   *  ones are history. */
  listJobRuns(jobId: string): JobRunRow[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection is the column list JobRunDbRow is declared from.
      const rows = db
        .prepare(`SELECT ${RUN_COLUMNS} FROM job_runs WHERE job_id = ? ORDER BY attempt DESC`)
        .all(jobId) as JobRunDbRow[];
      return rows.map(rowToJobRun);
    } catch (err) {
      console.error("[conversation-store] listJobRuns failed:", err);
      return [];
    }
  }

  /** The run a thread is carrying, if any. The runner reads this when a turn
   *  settles: the event names a thread, and this is what turns that back into
   *  the job whose queue should advance.
   *
   *  At most one row can match, because `UNIQUE (thread_id)` says so. This used
   *  to order by attempt and take the newest, which claimed the invariant in a
   *  comment and then hedged against it in the query — one of the two had to
   *  be wrong, and the schema is the place to settle it. */
  getJobRunByThread(threadId: string): JobRunRow | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection is the column list JobRunDbRow is declared from.
      const row = db
        .prepare(`SELECT ${RUN_COLUMNS} FROM job_runs WHERE thread_id = ?`)
        .get(threadId) as JobRunDbRow | undefined;
      return row ? rowToJobRun(row) : null;
    } catch (err) {
      console.error("[conversation-store] getJobRunByThread failed:", err);
      return null;
    }
  }

  /** Projects with queued work and nothing running — the set the runner has to
   *  wake at boot. Projects that already have a running job are left out
   *  because their own settle will advance them, and starting a second job
   *  there is the one thing the queue promises not to do. */
  projectsWithQueuedJobs(): string[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: single selected column, so the row shape is fixed by the SQL.
      const rows = db
        .prepare(
          `SELECT DISTINCT project_path FROM jobs queued
            WHERE status = 'queued'
              AND NOT EXISTS (
                SELECT 1 FROM jobs running
                 WHERE running.project_path = queued.project_path
                   AND running.status = 'running'
              )`,
        )
        .all() as Array<{ project_path: string }>;
      return rows.map((row) => row.project_path);
    } catch (err) {
      console.error("[conversation-store] projectsWithQueuedJobs failed:", err);
      return [];
    }
  }

  /** Return claims whose lease has run out to the queue. A claim only outlives
   *  its lease when the process holding it died between taking the row and
   *  starting the thread, so the job was never actually attempted and goes
   *  back to 'queued' rather than to 'failed'. Runs the sweep took are marked
   *  failed so the attempt history still shows the gap. Returns how many were
   *  reclaimed. */
  sweepExpiredClaims(at?: number): number {
    const db = this.dbh.handle();
    if (!db) return 0;
    const now = at ?? Date.now();
    try {
      let reclaimed = 0;
      this.dbh.durably(db, () => {
        // SAFETY: single selected column, so the row shape is fixed by the SQL.
        const stale = db
          .prepare(
            `SELECT run_id FROM job_runs
              WHERE status = 'claimed' AND lease_expires_at IS NOT NULL
                AND lease_expires_at <= ?`,
          )
          .all(now) as Array<{ run_id: string }>;
        if (!stale.length) return;
        const failRun = db.prepare(
          `UPDATE job_runs
              SET status = 'failed', error = 'claim expired', ended_at = ?,
                  lease_expires_at = NULL
            WHERE run_id = ?`,
        );
        const requeue = db.prepare(
          `UPDATE jobs
              SET status = 'queued', started_at = NULL, updated_at = ?
            WHERE job_id = (SELECT job_id FROM job_runs WHERE run_id = ?)
              AND status = 'running'`,
        );
        for (const row of stale) {
          failRun.run(now, row.run_id);
          requeue.run(now, row.run_id);
          reclaimed++;
        }
      });
      return reclaimed;
    } catch (err) {
      console.error("[conversation-store] sweepExpiredClaims failed:", err);
      return 0;
    }
  }
}
